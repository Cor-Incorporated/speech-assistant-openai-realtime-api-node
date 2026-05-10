import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createAdminBasicAuth, registerAdminRoutes } from '../lib/admin-routes.js';
import { CallLogStore } from '../lib/call-log-store.js';
import { getRuntimeConfig } from '../lib/runtime-config.js';

const authHeader = (user = 'admin', password = 'secret', scheme = 'Basic') => ({
    authorization: `${scheme} ${Buffer.from(`${user}:${password}`).toString('base64')}`
});

class FakeStore {
    constructor(records = []) {
        this.records = new Map(records.map((record) => [record.callSid, structuredClone(record)]));
    }

    async list() {
        return [...this.records.values()].map((record) => structuredClone(record));
    }

    async get(callSid) {
        const record = this.records.get(callSid);
        return record ? structuredClone(record) : null;
    }

    async updateOps(callSid, ops, { actor = 'admin' } = {}) {
        const record = this.records.get(callSid);
        if (!record) return null;

        record.ops = {
            ...(record.ops || {}),
            ...ops
        };
        record.opsUpdatedBy = actor;
        this.records.set(callSid, record);
        return structuredClone(record);
    }
}

const sampleRecord = {
    callSid: 'call-1',
    from: '+819012345678',
    to: '+81311112222',
    customerPhoneNumber: '09099998888',
    startedAt: '2026-05-10T10:00:00.000Z',
    status: 'completed',
    summary: '予約相談 090-1234-5678',
    callbackRequired: true,
    accountSid: 'ACinternal',
    streamSid: 'MZinternal',
    internalOperatorNote: 'do not expose this field',
    transcript: 'raw transcript should not appear in list. Phone 090-1234-5678 and +819011112222',
    turns: [{ role: 'user', text: 'hello from 080-1111-2222' }],
    extraction: {
        customerName: 'Test User',
        customerPhoneNumber: '08011112222',
        alternatePhoneNumber: '090-2222-3333',
        summary: '予約相談 090-1234-5678'
    },
    ops: {
        status: 'new'
    }
};

const makeFirestore = ({ records = [], listError = null } = {}) => {
    const byId = new Map(records.map((record) => [record.callSid, structuredClone(record)]));
    return {
        collection() {
            return {
                orderBy() {
                    return {
                        limit() {
                            return {
                                async get() {
                                    if (listError) throw listError;
                                    return {
                                        docs: [...byId.values()].map((record) => {
                                            const { callSid, ...data } = record;
                                            return {
                                                id: callSid,
                                                data: () => structuredClone(data)
                                            };
                                        })
                                    };
                                }
                            };
                        }
                    };
                },
                doc(callSid) {
                    return {
                        async get() {
                            const record = byId.get(callSid);
                            if (!record) return { exists: false };
                            const { callSid: id, ...data } = record;
                            return {
                                id,
                                exists: true,
                                data: () => structuredClone(data)
                            };
                        },
                        async set(value) {
                            const current = byId.get(callSid) || { callSid };
                            byId.set(callSid, {
                                ...current,
                                ...structuredClone(value)
                            });
                        }
                    };
                }
            };
        }
    };
};

const buildApp = async (options = {}) => {
    const app = Fastify();
    await app.register(registerAdminRoutes, {
        auth: createAdminBasicAuth({ user: 'admin', password: 'secret' }),
        store: new FakeStore([sampleRecord]),
        config: getRuntimeConfig({
            env: {
                REALTIME_MODEL: 'gpt-realtime-test',
                TRANSCRIPTION_MODEL: 'gpt-transcribe-test',
                EXTRACTION_MODEL: 'gpt-extract-test',
                VOICE: 'marin',
                VAD_TYPE: 'server_vad',
                LOG_TRANSCRIPTS: 'false',
                LOG_REALTIME_EVENTS: 'true',
                LOG_OPENAI_RESPONSES: 'false',
                CALL_LOG_FIRESTORE_ENABLED: 'true',
                CALL_LOG_SHEETS_ENABLED: 'false',
                SYSTEM_MESSAGE: 'private prompt body',
                FIRST_MESSAGE: 'こんにちは'
            }
        }),
        auditLog: () => {},
        ...options
    });
    return app;
};

test('admin routes return 503 when Basic Auth credentials are not configured', async () => {
    const app = await buildApp({
        auth: createAdminBasicAuth({ user: '', password: '' })
    });

    const response = await app.inject({
        method: 'GET',
        url: '/api/admin/summary'
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'admin_auth_unconfigured');
});

test('admin routes handle Basic Auth credentials strictly', async () => {
    const app = await buildApp();

    const missing = await app.inject({
        method: 'GET',
        url: '/api/admin/summary'
    });
    assert.equal(missing.statusCode, 401);
    assert.match(missing.headers['www-authenticate'], /Basic/);

    const invalid = await app.inject({
        method: 'GET',
        url: '/api/admin/summary',
        headers: authHeader('admin', 'wrong')
    });
    assert.equal(invalid.statusCode, 401);

    const malformed = await app.inject({
        method: 'GET',
        url: '/api/admin/summary',
        headers: {
            authorization: `${authHeader().authorization} extra`
        }
    });
    assert.equal(malformed.statusCode, 401);

    const lowercaseScheme = await app.inject({
        method: 'GET',
        url: '/api/admin/summary',
        headers: authHeader('admin', 'secret', 'basic')
    });
    assert.equal(lowercaseScheme.statusCode, 200);
});

test('call log list masks phone fields and PII text while omitting transcript bodies', async () => {
    const app = await buildApp();

    const response = await app.inject({
        method: 'GET',
        url: '/api/admin/call-logs',
        headers: authHeader()
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.count, 1);
    assert.equal(body.items[0].fromDisplay, '+****5678');
    assert.equal(body.items[0].toDisplay, '+****2222');
    assert.equal(body.items[0].customerPhoneDisplay, '****8888');
    assert.equal(body.items[0].summary, '予約相談 ****5678');
    assert.equal(body.items[0].from, undefined);
    assert.equal(body.items[0].to, undefined);
    assert.equal(body.items[0].customerPhoneNumber, undefined);
    assert.equal(body.items[0].accountSid, undefined);
    assert.equal(body.items[0].streamSid, undefined);
    assert.equal(body.items[0].internalOperatorNote, undefined);
    assert.equal(body.items[0].transcript, undefined);
    assert.equal(body.items[0].turns, undefined);
    assert.equal(body.items[0].extraction.customerPhoneNumber, undefined);
    assert.equal(body.items[0].extraction.customerPhoneDisplay, '****2222');
    assert.equal(body.items[0].extraction.summary, '予約相談 ****5678');
    assert.equal(body.items[0].extraction.alternatePhoneNumber, '****3333');
    assert.doesNotMatch(response.body, /raw transcript/);
    assert.doesNotMatch(response.body, /090-1234-5678/);
    assert.doesNotMatch(response.body, /090-2222-3333/);
});

test('call log detail is protected and redacts phone PII in transcript text', async () => {
    const app = await buildApp();

    const response = await app.inject({
        method: 'GET',
        url: '/api/admin/call-logs/call-1',
        headers: authHeader()
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.callSid, 'call-1');
    assert.match(body.transcript, /Phone \*\*\*\*5678 and \+\*\*\*\*2222/);
    assert.equal(body.turns[0].text, 'hello from ****2222');
    assert.equal(body.from, undefined);
    assert.equal(body.to, undefined);
    assert.equal(body.accountSid, undefined);
    assert.equal(body.streamSid, undefined);
    assert.equal(body.internalOperatorNote, undefined);
    assert.equal(body.fromDisplay, '+****5678');
    assert.equal(body.customerPhoneDisplay, '****8888');
    assert.doesNotMatch(response.body, /090-1234-5678/);
    assert.doesNotMatch(response.body, /\+819011112222/);
    assert.doesNotMatch(response.body, /080-1111-2222/);
});

test('ops patch only merges ops metadata and audits the update', async () => {
    const store = new FakeStore([sampleRecord]);
    const auditEvents = [];
    const app = await buildApp({
        store,
        auditLog: (action, details) => auditEvents.push({ action, details })
    });

    const response = await app.inject({
        method: 'PATCH',
        url: '/api/admin/call-logs/call-1/ops',
        headers: {
            ...authHeader(),
            'content-type': 'application/json'
        },
        payload: {
            ops: {
                status: 'needs_callback',
                memo: 'call 090-4444-5555 tomorrow'
            },
            transcript: 'overwritten',
            summary: 'overwritten'
        }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ops.status, 'needs_callback');
    assert.equal(body.ops.memo, 'call ****5555 tomorrow');
    assert.match(body.transcript, /Phone \*\*\*\*5678/);
    assert.equal(body.summary, '予約相談 ****5678');

    const stored = await store.get('call-1');
    assert.equal(stored.transcript, sampleRecord.transcript);
    assert.equal(stored.summary, sampleRecord.summary);
    assert.equal(stored.ops.status, 'needs_callback');
    assert.equal(stored.ops.memo, 'call 090-4444-5555 tomorrow');
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].action, 'admin.call_log.ops_update');
    assert.deepEqual(auditEvents[0].details.metadata.keys, ['status', 'memo']);
});

test('empty Firestore collection returns an empty admin API payload', async () => {
    const store = new CallLogStore({
        firestoreEnabled: true,
        firestore: makeFirestore()
    });
    const app = await buildApp({ store });

    const logs = await app.inject({
        method: 'GET',
        url: '/api/admin/call-logs',
        headers: authHeader()
    });

    assert.equal(logs.statusCode, 200);
    assert.deepEqual(logs.json(), {
        items: [],
        count: 0
    });

    const summary = await app.inject({
        method: 'GET',
        url: '/api/admin/summary',
        headers: authHeader()
    });

    assert.equal(summary.statusCode, 200);
    assert.deepEqual(summary.json(), {
        total: 0,
        callbackRequired: 0,
        inProgress: 0,
        completed: 0
    });
});

test('Firestore read failures return a controlled unavailable response', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = new CallLogStore({
        firestoreEnabled: true,
        firestore: makeFirestore({
            listError: new Error('permission denied for sensitive-project')
        })
    });
    const app = await buildApp({ store });

    const response = await app.inject({
        method: 'GET',
        url: '/api/admin/call-logs',
        headers: authHeader()
    });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
        error: 'call_log_store_unavailable',
        message: 'Call log storage is unavailable',
        operation: 'list'
    });
    assert.doesNotMatch(response.body, /permission denied/);
    assert.doesNotMatch(response.body, /sensitive-project/);
});

test('runtime config response excludes raw secret values', async () => {
    const app = await buildApp({
        config: getRuntimeConfig({
            env: {
                OPENAI_API_KEY: 'sk-secret-value',
                TWILIO_AUTH_TOKEN: 'twilio-secret-value',
                GOOGLE_CLOUD_PROJECT: 'gcp-project-secret',
                GOOGLE_SHEETS_SPREADSHEET_ID: 'spreadsheet-secret',
                TWILIO_WEBHOOK_URL: 'https://secret.example/incoming-call',
                REALTIME_MODEL: 'gpt-realtime-test',
                TRANSCRIPTION_MODEL: 'gpt-transcribe-test',
                EXTRACTION_MODEL: 'gpt-extract-test',
                VOICE: 'marin',
                VAD_TYPE: 'server_vad',
                VAD_THRESHOLD: '0.7',
                LOG_TRANSCRIPTS: 'true',
                CALL_LOG_FIRESTORE_ENABLED: 'true',
                CALL_LOG_SHEETS_ENABLED: 'true',
                SYSTEM_MESSAGE: 'sensitive prompt text',
                FIRST_MESSAGE: 'hello 090-1234-5678'
            }
        })
    });

    const response = await app.inject({
        method: 'GET',
        url: '/api/admin/runtime-config',
        headers: authHeader()
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.models.realtime, 'gpt-realtime-test');
    assert.equal(body.voice, 'marin');
    assert.equal(body.vad.threshold, 0.7);
    assert.equal(body.logging.transcripts, true);
    assert.equal(body.storage.firestoreEnabled, true);
    assert.equal(body.storage.sheetsEnabled, true);
    assert.equal(body.prompt.source, 'env');
    assert.equal(body.prompt.length, 'sensitive prompt text'.length);
    assert.equal(body.firstMessage, 'hello ****5678');

    assert.doesNotMatch(response.body, /sk-secret-value/);
    assert.doesNotMatch(response.body, /twilio-secret-value/);
    assert.doesNotMatch(response.body, /gcp-project-secret/);
    assert.doesNotMatch(response.body, /spreadsheet-secret/);
    assert.doesNotMatch(response.body, /secret\.example/);
    assert.doesNotMatch(response.body, /sensitive prompt text/);
    assert.doesNotMatch(response.body, /090-1234-5678/);
});
