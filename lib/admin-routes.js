import crypto from 'node:crypto';
import { CallLogStore } from './call-log-store.js';
import { describeDisconnectReason } from './disconnect-reasons.js';
import { RuntimeSettingsStore } from './runtime-settings-store.js';
import { auditLog as defaultAuditLog, maskPhone } from './security.js';
import { getRuntimeConfig, sanitizeRuntimeConfig } from './runtime-config.js';
import { validateRealtimeSettingsPatch } from './realtime-models.js';

const ADMIN_REALM = 'Cor Voice Admin';

const isPlainObject = (value) => Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);

const JAPAN_PHONE_TEXT_PATTERN = /(^|[^\d])((?:\+81|0)[\d\s().-]{8,}\d)(?!\d)/g;

const hash = (value) => crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest();

const safeCompare = (actual, expected) => {
    const actualHash = hash(actual);
    const expectedHash = hash(expected);
    return crypto.timingSafeEqual(actualHash, expectedHash);
};

const parseBasicAuth = (header = '') => {
    const parts = String(header).trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic') return null;
    const encoded = parts[1];

    try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator < 0) return null;
        return {
            user: decoded.slice(0, separator),
            password: decoded.slice(separator + 1)
        };
    } catch {
        return null;
    }
};

export function createAdminBasicAuth({
    user = process.env.ADMIN_BASIC_USER,
    password = process.env.ADMIN_BASIC_PASSWORD
} = {}) {
    const expectedUser = String(user || '');
    const expectedPassword = String(password || '');

    return {
        isConfigured() {
            return Boolean(expectedUser && expectedPassword);
        },
        async authenticate(request) {
            if (!expectedUser || !expectedPassword) {
                return {
                    ok: false,
                    configured: false,
                    statusCode: 503,
                    reason: 'admin_auth_unconfigured'
                };
            }

            const credentials = parseBasicAuth(request.headers.authorization);
            const ok = Boolean(credentials)
                && safeCompare(credentials.user, expectedUser)
                && safeCompare(credentials.password, expectedPassword);

            return {
                ok,
                configured: true,
                statusCode: ok ? 200 : 401,
                actor: ok ? credentials.user : '',
                reason: ok ? '' : 'invalid_admin_credentials'
            };
        }
    };
}

const authenticate = async (request, auth) => {
    if (typeof auth === 'function') return auth(request);
    if (typeof auth?.authenticate === 'function') return auth.authenticate(request);
    if (typeof auth?.verify === 'function') return auth.verify(request);
    return createAdminBasicAuth(auth).authenticate(request);
};

const requireAdmin = (auth, auditLog) => async (request, reply) => {
    const result = await authenticate(request, auth);
    request.adminAuth = result;

    if (result?.ok) return;

    if (result?.configured === false || result?.statusCode === 503) {
        reply.code(503).send({
            error: 'admin_auth_unconfigured',
            message: 'Admin API credentials are not configured'
        });
        return;
    }

    auditLog('admin.auth.failure', {
        actor: 'anonymous',
        target: request.url,
        result: 'failure',
        metadata: { reason: result?.reason || 'unauthorized' }
    });

    reply
        .header('WWW-Authenticate', `Basic realm="${ADMIN_REALM}"`)
        .code(401)
        .send({ error: 'unauthorized' });
};

const phoneDisplays = (record) => ({
    fromDisplay: maskPhone(record.from),
    toDisplay: maskPhone(record.to),
    customerPhoneDisplay: maskPhone(record.customerPhoneNumber || record.extraction?.customerPhoneNumber)
});

const getOps = (log) => isPlainObject(log.ops) ? log.ops : {};

const isPendingCallback = (log) => Boolean(log.callbackRequired)
    && !['completed', 'not_required'].includes(getOps(log).callbackStatus);

const isInProgress = (log) => ['needs_callback', 'in_progress'].includes(getOps(log).status);

const isCompleted = (log) => getOps(log).status === 'done';

const redactPhoneText = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(JAPAN_PHONE_TEXT_PATTERN, (_match, prefix, phone) => `${prefix}${maskPhone(phone)}`);
};

const redactPhoneValues = (value) => {
    if (Array.isArray(value)) return value.map(redactPhoneValues);
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, redactPhoneValues(entry)])
        );
    }
    return redactPhoneText(value);
};

const sanitizeExtraction = (extraction) => {
    if (!isPlainObject(extraction)) return extraction || null;
    const {
        customerPhoneNumber,
        customerPhoneDisplay,
        ...safeExtraction
    } = extraction;
    return {
        ...redactPhoneValues(safeExtraction),
        customerPhoneDisplay: customerPhoneNumber
            ? maskPhone(customerPhoneNumber)
            : redactPhoneText(customerPhoneDisplay || '')
    };
};

const sanitizeCallLog = (record, { includeTranscript = false } = {}) => {
    const {
        from,
        to,
        customerPhoneNumber,
        transcript,
        turns,
        extraction,
        ...source
    } = record || {};

    const disconnect = describeDisconnectReason({
        disconnectReason: source.disconnectReason,
        openAiCloseCode: source.openAiCloseCode,
        openAiError: source.openAiError
    });

    return {
        callSid: source.callSid || '',
        isSmokeTest: String(source.callSid || '').startsWith('CA_SMOKE'),
        startedAt: source.startedAt || '',
        startedAtJst: source.startedAtJst || '',
        endedAt: source.endedAt || '',
        endedAtJst: source.endedAtJst || '',
        durationSeconds: source.durationSeconds || 0,
        status: source.status || '',
        disconnectReason: redactPhoneText(source.disconnectReason || ''),
        disconnectReasonLabel: redactPhoneText(disconnect.label || ''),
        disconnectReasonCategory: disconnect.category || 'unknown',
        openAiCloseCode: source.openAiCloseCode || '',
        openAiError: redactPhoneText(source.openAiError || ''),
        summary: redactPhoneText(source.summary || ''),
        intent: redactPhoneText(source.intent || ''),
        callbackRequired: Boolean(source.callbackRequired),
        customerName: redactPhoneText(source.customerName || ''),
        preferredDatetime: redactPhoneText(source.preferredDatetime || ''),
        createdAt: source.createdAt || '',
        updatedAt: source.updatedAt || '',
        ops: redactPhoneValues(isPlainObject(source.ops) ? source.ops : {}),
        opsUpdatedAt: source.opsUpdatedAt || '',
        opsUpdatedBy: source.opsUpdatedBy || '',
        ...phoneDisplays({ from, to, customerPhoneNumber, extraction }),
        extraction: sanitizeExtraction(extraction),
        ...(includeTranscript ? {
            transcript: redactPhoneText(transcript),
            turns: redactPhoneValues(turns)
        } : {})
    };
};

const getConfig = async (provider, options = {}) => {
    if (!provider) return getRuntimeConfig();
    if (typeof provider === 'function') return provider(options);
    if (typeof provider.getRuntimeConfig === 'function') return provider.getRuntimeConfig();
    return provider;
};

const getSummary = async (store) => {
    if (typeof store.summary === 'function') return store.summary();
    const logs = typeof store.list === 'function' ? await store.list({ limit: 200 }) : [];
    return {
        total: logs.length,
        callbackRequired: logs.filter(isPendingCallback).length,
        inProgress: logs.filter(isInProgress).length,
        completed: logs.filter(isCompleted).length,
        needsReview: logs.filter((log) => Boolean(getOps(log).needsReview)).length
    };
};

const getStoreHealth = (store, settingsStore) => {
    const storageHealth = typeof store.health === 'function' ? store.health() : {
        storage: {
            firestoreEnabled: Boolean(store?.firestoreEnabled)
        }
    };

    return {
        ...storageHealth,
        ...(typeof settingsStore?.health === 'function' ? settingsStore.health() : {})
    };
};

const handleStoreError = (reply, error) => {
    if (error?.code === 'CALL_LOG_STORE_UNAVAILABLE') {
        reply.code(error.statusCode || 503);
        return {
            error: 'call_log_store_unavailable',
            message: 'Call log storage is unavailable',
            operation: error.operation || 'unknown'
        };
    }

    if (error?.code === 'RUNTIME_SETTINGS_STORE_UNAVAILABLE') {
        reply.code(error.statusCode || 503);
        return {
            error: 'runtime_settings_store_unavailable',
            message: 'Runtime settings storage is unavailable',
            operation: error.operation || 'unknown'
        };
    }

    throw error;
};

const getSettings = async (settingsStore) => {
    if (!settingsStore) return {};
    if (typeof settingsStore.get === 'function') return settingsStore.get();
    return settingsStore;
};

const updateSettings = async (settingsStore, patch, options) => {
    if (typeof settingsStore?.update === 'function') return settingsStore.update(patch, options);
    return {
        ...patch,
        updatedAt: options?.updatedAt || new Date().toISOString(),
        updatedBy: options?.actor || 'admin'
    };
};

export async function registerAdminRoutes(fastify, {
    store = new CallLogStore(),
    settingsStore = new RuntimeSettingsStore(),
    config,
    auth = createAdminBasicAuth(),
    auditLog = defaultAuditLog
} = {}) {
    const preHandler = requireAdmin(auth, auditLog);

    fastify.get('/api/admin/summary', { preHandler }, async (_request, reply) => {
        try {
            return await getSummary(store);
        } catch (error) {
            return handleStoreError(reply, error);
        }
    });

    fastify.get('/api/admin/call-logs', { preHandler }, async (request, reply) => {
        try {
            const logs = await store.list({
                limit: request.query?.limit
            });
            return {
                items: logs.map((record) => sanitizeCallLog(record)),
                count: logs.length
            };
        } catch (error) {
            return handleStoreError(reply, error);
        }
    });

    fastify.get('/api/admin/call-logs/:callSid', { preHandler }, async (request, reply) => {
        try {
            const record = await store.get(request.params.callSid);
            if (!record) {
                reply.code(404);
                return { error: 'not_found' };
            }

            return sanitizeCallLog(record, { includeTranscript: true });
        } catch (error) {
            return handleStoreError(reply, error);
        }
    });

    fastify.patch('/api/admin/call-logs/:callSid/ops', { preHandler }, async (request, reply) => {
        const body = request.body || {};
        if (!isPlainObject(body.ops)) {
            reply.code(400);
            return {
                error: 'invalid_ops',
                message: 'Request body must include an ops object'
            };
        }

        const actor = request.adminAuth?.actor || 'admin';
        let updated;
        try {
            updated = await store.updateOps(request.params.callSid, body.ops, { actor });
        } catch (error) {
            return handleStoreError(reply, error);
        }

        if (!updated) {
            reply.code(404);
            return { error: 'not_found' };
        }

        auditLog('admin.call_log.ops_update', {
            actor,
            target: request.params.callSid,
            metadata: {
                keys: Object.keys(body.ops)
            }
        });

        return sanitizeCallLog(updated, { includeTranscript: true });
    });

    fastify.get('/api/admin/runtime-config', { preHandler }, async (_request, reply) => {
        try {
            const runtimeConfig = await getConfig(config, {
                runtimeSettings: await getSettings(settingsStore)
            });
            return sanitizeRuntimeConfig(runtimeConfig);
        } catch (error) {
            return handleStoreError(reply, error);
        }
    });

    fastify.patch('/api/admin/runtime-config', { preHandler }, async (request, reply) => {
        const body = request.body || {};
        if (!isPlainObject(body)) {
            reply.code(400);
            return {
                error: 'invalid_runtime_config',
                message: 'Request body must be an object'
            };
        }

        const validation = validateRealtimeSettingsPatch(body);
        if (!validation.ok) {
            reply.code(400);
            return {
                error: 'invalid_runtime_config',
                message: 'Unsupported runtime setting',
                details: validation.errors
            };
        }

        const actor = request.adminAuth?.actor || 'admin';
        let updatedSettings;
        try {
            updatedSettings = await updateSettings(settingsStore, validation.patch, { actor });
        } catch (error) {
            return handleStoreError(reply, error);
        }

        auditLog('admin.runtime_config.update', {
            actor,
            target: 'runtime-config',
            metadata: {
                keys: Object.keys(validation.patch)
            }
        });

        const runtimeConfig = await getConfig(config, {
            runtimeSettings: updatedSettings
        });
        return sanitizeRuntimeConfig(runtimeConfig);
    });

    fastify.get('/api/admin/privacy/logging-policy', { preHandler }, async (_request, reply) => {
        try {
            const runtimeConfig = sanitizeRuntimeConfig(await getConfig(config, {
                runtimeSettings: await getSettings(settingsStore)
            }));
            return {
                logging: runtimeConfig.logging,
                policy: {
                    listResponsesIncludeTranscript: false,
                    detailResponsesRequireAdminAuth: true,
                    phoneNumbersAreMaskedInAdminResponses: true,
                    opsResponsesPersistToFirestore: true,
                    runtimeModelSelectionPersistsToFirestore: true
                }
            };
        } catch (error) {
            return handleStoreError(reply, error);
        }
    });

    fastify.get('/api/admin/health', { preHandler }, async () => ({
        ok: true,
        adminAuthConfigured: true,
        ...getStoreHealth(store, settingsStore)
    }));
}
