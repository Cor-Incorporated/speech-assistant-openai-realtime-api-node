// Admin v2 API — knowledge/calls/escalations/sources/reviews/releases.
// Contract (UI_API_SPEC §3):
//   * server-side permission checks per route — the UI never decides
//   * If-Match (recordVersion ETag) required on PATCH/DELETE/publish/restore
//   * Idempotency-Key on POST /calls
//   * Origin check on writes (Basic auth is browser-attached → CSRF surface)
//   * error body: {code, message, fieldErrors, requestId}
//   * GET never has side effects; PII masked for viewer role

import crypto from 'node:crypto';
import { seedItemToDraft } from '../dist-backend/knowledge/schemas.js';

const VALID_ROLES = new Set([
    'viewer', 'operator', 'knowledge_editor', 'knowledge_approver',
    'supervisor', 'privacy_admin', 'ingestion_service'
]);

// ---------------------------------------------------------------------------
// Actor derivation — Basic auth proves the credential; the subject map tells
// us who this person is. Unknown users get viewer + sharedAccount (least
// privilege): they cannot approve/publish/purge/acknowledge.
// ---------------------------------------------------------------------------

const parseSubjectMap = (raw) => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [user, spec] of Object.entries(parsed)) {
            if (!spec || typeof spec !== 'object') continue;
            const roles = Array.isArray(spec.roles) ? spec.roles.filter((r) => VALID_ROLES.has(r)) : [];
            out[user] = {
                subject: typeof spec.subject === 'string' && spec.subject ? spec.subject : user,
                roles,
                sharedAccount: spec.sharedAccount !== false // default shared
            };
        }
        return out;
    } catch {
        return {};
    }
};

const deriveActor = (username, subjectMap) => {
    const entry = subjectMap[username];
    if (entry) return entry;
    return { subject: username, roles: ['viewer'], sharedAccount: true };
};

// ---------------------------------------------------------------------------
// Request guards
// ---------------------------------------------------------------------------

const requestHost = (request) =>
    String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();

/** Basic credentials ride the browser automatically — a cross-site form or
 * fetch must not be able to write. Same-origin Origin/Referer is required
 * when present; a JSON content-type is required on bodied writes (a plain
 * HTML form cannot set it without a CORS preflight). */
const checkWriteGuards = (request, reply) => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const origin = request.headers.origin || request.headers.referer;
    if (origin) {
        try {
            const host = new URL(origin).host;
            if (host !== requestHost(request)) {
                reply.code(403).send({ code: 'CSRF_ORIGIN', message: 'cross-origin write rejected', requestId: request.id });
                return false;
            }
        } catch {
            reply.code(403).send({ code: 'CSRF_ORIGIN', message: 'invalid origin', requestId: request.id });
            return false;
        }
    }

    const hasBody = Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding'];
    if (hasBody && !String(request.headers['content-type'] || '').includes('application/json')) {
        reply.code(415).send({ code: 'UNSUPPORTED_MEDIA', message: 'writes require application/json', requestId: request.id });
        return false;
    }
    return true;
};

// Simple per-IP write limiter — enough to stop a runaway client, not a DDoS.
const createWriteLimiter = ({ maxPerMinute = 60 } = {}) => {
    const buckets = new Map();
    return (request, reply) => {
        const method = request.method.toUpperCase();
        if (method === 'GET' || method === 'HEAD') return true;
        const key = request.ip || 'unknown';
        const now = Date.now();
        const bucket = buckets.get(key) ?? { count: 0, resetAt: now + 60_000 };
        if (now > bucket.resetAt) {
            bucket.count = 0;
            bucket.resetAt = now + 60_000;
        }
        bucket.count += 1;
        buckets.set(key, bucket);
        if (bucket.count > maxPerMinute) {
            reply.code(429).send({ code: 'RATE_LIMITED', message: 'write rate limit exceeded', requestId: request.id });
            return false;
        }
        return true;
    };
};

// ---------------------------------------------------------------------------
// ETag / If-Match — opaque token carrying recordVersion
// ---------------------------------------------------------------------------

const etagFor = (prefix, record) => `"${prefix}-v${record.recordVersion}"`;

const parseIfMatch = (request, prefix) => {
    const header = request.headers['if-match'];
    if (!header) return { ok: false, status: 428, error: 'IF_MATCH_REQUIRED' };
    const match = String(header).trim().match(/^"?([a-z]+)-v(\d+)"?$/);
    if (!match || match[1] !== prefix) {
        return { ok: false, status: 412, error: 'IF_MATCH_INVALID' };
    }
    return { ok: true, version: Number(match[2]) };
};

// ---------------------------------------------------------------------------
// Error mapping — internal stacks never leave the process boundary
// ---------------------------------------------------------------------------

const sendError = (request, reply, error) => {
    const status = error.statusCode ?? (error.code === 'VERSION_CONFLICT' ? 412 : 500);
    const body = {
        code: error.code ?? 'INTERNAL',
        message: status === 500 ? 'internal error' : error.message,
        requestId: request.id
    };
    if (error.fieldErrors) body.fieldErrors = error.fieldErrors;
    return reply.code(status).send(body);
};

// ---------------------------------------------------------------------------
// PII projection — viewer sees the shape of the work, not the person
// ---------------------------------------------------------------------------

const maskPhone = (value) => {
    if (!value) return value;
    const digits = String(value).replace(/\D/g, '');
    return digits.length > 4 ? `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}` : '****';
};

const projectCall = (record, canSeePii) => {
    if (canSeePii) return record;
    return {
        ...record,
        fromNumberMasked: record.fromNumberMasked ? maskPhone(record.fromNumberMasked) : null,
        effective: {
            ...record.effective,
            callerName: record.effective?.callerName ? '***' : null,
            callerNameKana: record.effective?.callerNameKana ? '***' : null,
            callbackNumber: record.effective?.callbackNumber ? maskPhone(record.effective.callbackNumber) : null,
            memo: record.effective?.memo ? '***' : null
        },
        extraction: {}
    };
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function registerAdminV2Routes(fastify, {
    adminAuth,
    knowledgeService,
    callService,
    escalationService,
    knowledgeReader = null,
    subjectMap = parseSubjectMap(process.env.ADMIN_V2_SUBJECT_MAP),
    knowledgeRepository = null,
    importManifest = null,           // optional path to the seed manifest for /knowledge-imports
    writeRateLimit = 60
} = {}) {
    const limiter = createWriteLimiter({ maxPerMinute: writeRateLimit });

    const authenticate = async (request, reply) => {
        const result = await adminAuth.authenticate(request);
        if (!result.ok) {
            if (result.configured === false) {
                reply.code(503).send({ code: 'ADMIN_AUTH_UNCONFIGURED', message: 'admin credentials not configured', requestId: request.id });
            } else {
                reply.header('WWW-Authenticate', 'Basic realm="Cor Voice Admin"').code(401)
                    .send({ code: 'UNAUTHORIZED', message: 'invalid credentials', requestId: request.id });
            }
            return null;
        }
        const actor = deriveActor(result.actor, subjectMap);
        request.v2Actor = actor;
        return actor;
    };

    const canSeePii = (actor) => actor.roles.some((r) => ['operator', 'supervisor', 'privacy_admin'].includes(r));

    const guard = async (request, reply) => {
        const actor = await authenticate(request, reply);
        if (!actor) return null;
        if (!checkWriteGuards(request, reply)) return null;
        if (!limiter(request, reply)) return null;
        return actor;
    };

    const noStore = (reply) => reply.header('Cache-Control', 'no-store');
    const handle = (fn) => async (request, reply) => {
        try {
            return await fn(request, reply);
        } catch (error) {
            return sendError(request, reply, error);
        }
    };

    // =====================================================================
    // Calls
    // =====================================================================

    fastify.post('/api/admin/v2/calls', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const { record, replayed } = await callService.createManual(actor, request.body, {
            idempotencyKey: request.headers['idempotency-key'] || undefined
        });
        noStore(reply);
        return reply.code(replayed ? 200 : 201)
            .header('ETag', etagFor('call', record))
            .send({ call: projectCall(record, canSeePii(actor)), replayed });
    }));

    fastify.get('/api/admin/v2/calls', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const query = request.query ?? {};
        const result = await callService.list(actor, {
            businessState: query.businessState || undefined,
            origin: query.origin || undefined,
            includeDeleted: query.includeDeleted === 'true',
            severityMin: query.severityMin || undefined,
            limit: query.limit ? Number(query.limit) : undefined,
            cursor: query.cursor || undefined
        });
        noStore(reply);
        return reply.send({
            items: result.items.map((r) => projectCall(r, canSeePii(actor))),
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            partial: result.partial,
            filter: { businessState: query.businessState ?? null, origin: query.origin ?? null, includeDeleted: query.includeDeleted === 'true' },
            asOf: new Date().toISOString()
        });
    }));

    fastify.get('/api/admin/v2/calls/:id', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const record = await callService.get(actor, request.params.id, {
            includeDeleted: request.query?.includeDeleted === 'true'
        });
        if (!record) return reply.code(404).send({ code: 'NOT_FOUND', message: 'call not found', requestId: request.id });
        noStore(reply);
        return reply.header('ETag', etagFor('call', record)).send({
            call: projectCall(record, canSeePii(actor)),
            corrections: await callService.listCorrections(actor, record.callId)
        });
    }));

    fastify.patch('/api/admin/v2/calls/:id', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const ifMatch = parseIfMatch(request, 'call');
        if (!ifMatch.ok) {
            return reply.code(ifMatch.status).send({ code: ifMatch.error, message: 'If-Match header with the current ETag is required', requestId: request.id });
        }
        const updated = await callService.patch(actor, request.params.id, request.body, ifMatch.version);
        noStore(reply);
        return reply.header('ETag', etagFor('call', updated)).send({ call: projectCall(updated, canSeePii(actor)) });
    }));

    fastify.delete('/api/admin/v2/calls/:id', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const ifMatch = parseIfMatch(request, 'call');
        if (!ifMatch.ok) {
            return reply.code(ifMatch.status).send({ code: ifMatch.error, message: 'If-Match required', requestId: request.id });
        }
        const reason = request.body?.reason;
        const updated = await callService.softDelete(actor, request.params.id, { reason, expectedVersion: ifMatch.version });
        noStore(reply);
        return reply.send({ call: projectCall(updated, canSeePii(actor)) });
    }));

    fastify.post('/api/admin/v2/calls/:id/restore', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const updated = await callService.restore(actor, request.params.id);
        noStore(reply);
        return reply.header('ETag', etagFor('call', updated)).send({ call: projectCall(updated, canSeePii(actor)) });
    }));

    fastify.delete('/api/admin/v2/calls/:id/corrections/:correctionId', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const reason = request.body?.reason ?? request.query?.reason;
        const updated = await callService.revertCorrection(actor, request.params.id, request.params.correctionId, { reason });
        noStore(reply);
        return reply.header('ETag', etagFor('call', updated)).send({ call: projectCall(updated, canSeePii(actor)) });
    }));

    fastify.get('/api/admin/v2/calls/:id/history', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const record = await callService.get(actor, request.params.id, { includeDeleted: true });
        if (!record) return reply.code(404).send({ code: 'NOT_FOUND', message: 'call not found', requestId: request.id });
        noStore(reply);
        return reply.send({
            corrections: await callService.listCorrections(actor, record.callId),
            events: await callService.listEvents(actor, record.callId)
        });
    }));

    // =====================================================================
    // Knowledge
    // =====================================================================

    fastify.post('/api/admin/v2/knowledge', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const record = await knowledgeService.createDraft(actor, request.body);
        noStore(reply);
        return reply.code(201).header('ETag', etagFor('kn', record)).send({ knowledge: record });
    }));

    fastify.get('/api/admin/v2/knowledge', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const query = request.query ?? {};
        const result = await knowledgeService.list(actor, {
            state: query.state || undefined,
            category: query.category || undefined,
            includeDeleted: query.includeDeleted === 'true',
            limit: query.limit ? Number(query.limit) : undefined,
            cursor: query.cursor || undefined
        });
        noStore(reply);
        return reply.send({ items: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore, asOf: new Date().toISOString() });
    }));

    fastify.get('/api/admin/v2/knowledge/:id', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const record = await knowledgeService.get(actor, request.params.id, { includeDeleted: true });
        if (!record) return reply.code(404).send({ code: 'NOT_FOUND', message: 'knowledge not found', requestId: request.id });
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const draft = record.draftRevision ? await repo.getRevision(record.knowledgeId, record.draftRevision) : null;
        const published = record.publishedRevision ? await repo.getRevision(record.knowledgeId, record.publishedRevision) : null;
        noStore(reply);
        return reply.header('ETag', etagFor('kn', record)).send({ knowledge: record, draftRevision: draft, publishedRevision: published });
    }));

    fastify.patch('/api/admin/v2/knowledge/:id', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const ifMatch = parseIfMatch(request, 'kn');
        if (!ifMatch.ok) {
            return reply.code(ifMatch.status).send({ code: ifMatch.error, message: 'If-Match required', requestId: request.id });
        }
        const updated = await knowledgeService.updateDraft(actor, request.params.id, request.body, ifMatch.version);
        noStore(reply);
        return reply.header('ETag', etagFor('kn', updated)).send({ knowledge: updated });
    }));

    fastify.delete('/api/admin/v2/knowledge/:id', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const ifMatch = parseIfMatch(request, 'kn');
        if (!ifMatch.ok) {
            return reply.code(ifMatch.status).send({ code: ifMatch.error, message: 'If-Match required', requestId: request.id });
        }
        const updated = await knowledgeService.softDelete(actor, request.params.id, { reason: request.body?.reason });
        noStore(reply);
        return reply.send({ knowledge: updated });
    }));

    fastify.post('/api/admin/v2/knowledge/:id/restore', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const updated = await knowledgeService.restore(actor, request.params.id);
        noStore(reply);
        return reply.header('ETag', etagFor('kn', updated)).send({ knowledge: updated });
    }));

    fastify.get('/api/admin/v2/knowledge/:id/revisions', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        await knowledgeService.get(actor, request.params.id, { includeDeleted: true });
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const revisions = await repo.listRevisions(request.params.id);
        noStore(reply);
        return reply.send({ items: revisions });
    }));

    fastify.post('/api/admin/v2/knowledge/:id/submit-review', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const revision = Number(request.body?.revision);
        if (!Number.isInteger(revision)) {
            return reply.code(422).send({ code: 'VALIDATION', message: 'revision is required', requestId: request.id });
        }
        const updated = await knowledgeService.submitForReview(actor, request.params.id, revision);
        noStore(reply);
        return reply.send({ knowledge: updated });
    }));

    fastify.post('/api/admin/v2/knowledge/:id/approve', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const { revision, contentHash, reason } = request.body ?? {};
        const updated = await knowledgeService.approve(actor, request.params.id, { revision, contentHash, reason });
        noStore(reply);
        return reply.send({ knowledge: updated });
    }));

    fastify.post('/api/admin/v2/knowledge/:id/withdraw', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const { reason, emergency } = request.body ?? {};
        const updated = await knowledgeService.withdraw(actor, request.params.id, { reason, emergency: emergency === true });
        noStore(reply);
        return reply.send({ knowledge: updated });
    }));

    /** Deterministic preview — shows exactly what the published whitelist
     * would contain for a record, and/or a bounded draft search. Never
     * calls an external AI and never claims the draft is live on voice. */
    fastify.post('/api/admin/v2/knowledge/preview', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const { knowledgeId, query } = request.body ?? {};
        const repo = knowledgeRepository ?? knowledgeService.repo;

        if (knowledgeId) {
            const record = await knowledgeService.get(actor, knowledgeId, { includeDeleted: true });
            if (!record) return reply.code(404).send({ code: 'NOT_FOUND', message: 'knowledge not found', requestId: request.id });
            const revision = record.draftRevision ? await repo.getRevision(record.knowledgeId, record.draftRevision) : null;
            const publishablePreview = revision && record.audience === 'public'
                ? {
                    knowledgeId: record.knowledgeId,
                    key: record.key,
                    revision: revision.revision,
                    answerJa: revision.answerJa,
                    answerType: revision.answerType,
                    value: revision.value,
                    evidenceState: revision.evidenceState,
                    sourceIds: revision.sourceRefs.map((r) => r.sourceId),
                    asOf: revision.asOf,
                    expiresAt: revision.validity.expiresAt,
                    requiresHumanReview: record.handling !== 'answer_after_approval'
                }
                : null;
            noStore(reply);
            return reply.send({
                knowledgeId,
                state: record.state,
                audience: record.audience,
                appliedToVoice: false,
                wouldPublish: publishablePreview,
                excludedFields: ['operatorNote', 'reviewQuestion', 'internal'],
                note: 'このプレビューは公開候補の内容です。公開releaseに含まれるまで電話応答には使われません。'
            });
        }

        if (query) {
            const { items } = await knowledgeService.list(actor, { limit: 200 });
            const normalized = String(query).normalize('NFKC').toLowerCase();
            const matches = items
                .filter((r) => !r.deletedAt)
                .map((r) => {
                    const haystack = `${r.key} ${r.title} ${r.category} ${(r.keywords ?? []).join(' ')}`.normalize('NFKC').toLowerCase();
                    return haystack.includes(normalized) ? { knowledgeId: r.knowledgeId, key: r.key, title: r.title, state: r.state } : null;
                })
                .filter(Boolean)
                .slice(0, 10);
            noStore(reply);
            return reply.send({ query, appliedToVoice: false, matches, note: 'draftを含む検索プレビュー。公開済み知識のみが電話で使われます。' });
        }

        return reply.code(422).send({ code: 'VALIDATION', message: 'knowledgeId or query is required', requestId: request.id });
    }));

    // =====================================================================
    // Releases
    // =====================================================================

    fastify.post('/api/admin/v2/knowledge-releases', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const release = await knowledgeService.publish(actor, { knowledgeIds: request.body?.knowledgeIds });
        noStore(reply);
        return reply.code(201).send({ release });
    }));

    fastify.get('/api/admin/v2/knowledge-releases/:id', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const release = await repo.getRelease(request.params.id);
        if (!release) return reply.code(404).send({ code: 'NOT_FOUND', message: 'release not found', requestId: request.id });
        const items = await repo.getReleaseItems(release.releaseId);
        const settings = await repo.getRuntimeSettings();
        noStore(reply);
        return reply.send({ release, items, current: settings.currentReleaseId === release.releaseId });
    }));

    fastify.get('/api/admin/v2/knowledge-releases', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const releases = await repo.listReleases(Number(request.query?.limit) || 20);
        const settings = await repo.getRuntimeSettings();
        noStore(reply);
        return reply.send({ items: releases, currentReleaseId: settings.currentReleaseId, revocationEpoch: settings.revocationEpoch });
    }));

    // =====================================================================
    // Sources / reviews
    // =====================================================================

    fastify.get('/api/admin/v2/knowledge-sources', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const sources = await repo.listSources({ includeDeleted: request.query?.includeDeleted === 'true' });
        noStore(reply);
        return reply.send({ items: sources });
    }));

    fastify.post('/api/admin/v2/knowledge-sources', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const body = request.body ?? {};
        const sourceId = body.sourceId || `SRC-${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        const record = {
            schemaVersion: 1,
            sourceId,
            sourceType: body.sourceType,
            title: body.title,
            url: body.url ?? null,
            publishedOn: body.publishedOn ?? null,
            checkedOn: body.checkedOn ?? null,
            observation: body.observation ?? null,
            publicationCaveat: body.publicationCaveat ?? null,
            recordVersion: 1,
            deletedAt: null,
            createdAt: now,
            createdBy: actor.subject,
            updatedAt: now,
            updatedBy: actor.subject
        };
        const stored = await knowledgeService.putSource(actor, record);
        noStore(reply);
        return reply.code(201).header('ETag', etagFor('src', stored)).send({ source: stored });
    }));

    fastify.delete('/api/admin/v2/knowledge-sources/:id', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const result = await knowledgeService.deleteSource(actor, request.params.id);
        noStore(reply);
        return reply.send({ deleted: request.params.id, dependents: result.dependents });
    }));

    fastify.get('/api/admin/v2/knowledge-reviews', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const reviews = await repo.listReviews({ state: request.query?.state || undefined });
        noStore(reply);
        return reply.send({ items: reviews });
    }));

    fastify.patch('/api/admin/v2/knowledge-reviews/:id', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const ifMatch = parseIfMatch(request, 'rev');
        if (!ifMatch.ok) {
            return reply.code(ifMatch.status).send({ code: ifMatch.error, message: 'If-Match required', requestId: request.id });
        }
        const resolvedValue = request.body?.resolvedValue;
        const updated = await knowledgeService.resolveReview(actor, request.params.id, { resolvedValue, expectedVersion: ifMatch.version });
        noStore(reply);
        return reply.send({ review: updated });
    }));

    // =====================================================================
    // Imports — dry-run validates + reports collisions; execute is
    // create-only and requires the imports.execute permission.
    // =====================================================================

    const pendingImports = new Map(); // importId → {manifest, plan, createdAt}

    const planImport = async (manifest, actor) => {
        const allowed = new Set(manifest.allowed_collections ?? []);
        const plans = [];
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const now = new Date().toISOString();

        for (const record of manifest.records ?? []) {
            const { collection, document_id: docId, data } = record;
            if (!allowed.has(collection)) {
                plans.push({ collection, docId, action: 'refused', reason: 'not in manifest allowed_collections' });
                continue;
            }
            if (collection === 'corKnowledgeSources') {
                const existing = await repo.getSource(docId);
                plans.push({ collection, docId, action: existing ? 'skip' : 'create', doc: data });
            } else if (collection === 'corKnowledgeReviews') {
                const existing = await repo.getReview(docId);
                plans.push({ collection, docId, action: existing ? 'skip' : 'create', doc: data });
            } else if (collection === 'corKnowledge') {
                const existing = await repo.getKnowledge(docId);
                if (existing) {
                    plans.push({ collection, docId, action: 'skip' });
                } else {
                    const child = (record.children ?? []).find((c) => c.collection === 'revisions');
                    if (!child) {
                        plans.push({ collection, docId, action: 'invalid', reason: 'missing revisions child' });
                        continue;
                    }
                    const converted = seedItemToDraft(child.data);
                    if (!converted.ok) {
                        plans.push({ collection, docId, action: 'invalid', reason: converted.issues.map((i) => `${i.field}: ${i.message}`).join('; ') });
                        continue;
                    }
                    plans.push({ collection, docId, action: 'create', root: record.data, child: converted.value });
                }
            } else if (collection === 'receptionPolicies') {
                plans.push({ collection, docId, action: 'create', doc: { ...data, enabled: false, publication_state: 'draft' } });
            } else {
                plans.push({ collection, docId, action: 'refused', reason: 'collection outside importer whitelist' });
            }
        }
        return plans;
    };

    fastify.post('/api/admin/v2/knowledge-imports/dry-run', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const manifest = request.body?.manifest ?? request.body;
        if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.records)) {
            return reply.code(422).send({ code: 'VALIDATION', message: 'manifest with records[] is required', requestId: request.id });
        }
        const plans = await planImport(manifest, actor);
        const summary = {};
        for (const p of plans) summary[p.action] = (summary[p.action] ?? 0) + 1;
        const importId = `imp_${crypto.randomUUID()}`;
        pendingImports.set(importId, { manifest, plans, createdAt: new Date().toISOString(), actor: actor.subject });
        noStore(reply);
        return reply.send({ importId, summary, plans: plans.map(({ doc, root, child, ...rest }) => rest), expiresIn: 'session' });
    }));

    fastify.post('/api/admin/v2/knowledge-imports/:id/execute', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        if (!actor.roles.includes('knowledge_approver') && !actor.roles.includes('supervisor')) {
            return reply.code(403).send({ code: 'FORBIDDEN', message: 'imports.execute requires approver or supervisor', requestId: request.id });
        }
        const pending = pendingImports.get(request.params.id);
        if (!pending) return reply.code(404).send({ code: 'NOT_FOUND', message: 'import plan not found — run dry-run first', requestId: request.id });
        if (pending.plans.some((p) => p.action === 'invalid' || p.action === 'refused' || p.action === 'conflict')) {
            return reply.code(409).send({ code: 'IMPORT_BLOCKED', message: 'plan contains invalid/refused/conflict records', requestId: request.id });
        }
        const repo = knowledgeRepository ?? knowledgeService.repo;
        let created = 0;
        for (const plan of pending.plans) {
            if (plan.action !== 'create') continue;
            if (plan.collection === 'corKnowledgeSources') {
                const { seedSourceToRecord } = await import('../dist-backend/knowledge/schemas.js');
                const converted = seedSourceToRecord(plan.doc, { createdBy: actor.subject, createdAt: new Date().toISOString() });
                if (converted.ok) { await repo.putSource(converted.value); created += 1; }
            } else if (plan.collection === 'corKnowledgeReviews') {
                const { seedReviewToRecord } = await import('../dist-backend/knowledge/schemas.js');
                const converted = seedReviewToRecord(plan.doc, { createdAt: new Date().toISOString() });
                if (converted.ok) { await repo.putReview(converted.value); created += 1; }
            } else if (plan.collection === 'corKnowledge' && plan.child) {
                const now = new Date().toISOString();
                const { draft, knowledgeId, revision } = plan.child;
                const record = {
                    schemaVersion: 1,
                    knowledgeId,
                    key: draft.key,
                    title: draft.title,
                    category: draft.category,
                    locale: draft.locale,
                    keywords: draft.keywords,
                    audience: draft.audience,
                    handling: draft.handling,
                    riskLevel: draft.riskLevel,
                    state: 'draft',
                    draftRevision: revision,
                    publishedRevision: null,
                    recordVersion: 1,
                    deletedAt: null,
                    deletedBy: null,
                    deletionReason: null,
                    createdAt: now,
                    createdBy: actor.subject,
                    updatedAt: now,
                    updatedBy: actor.subject
                };
                const { created: wasCreated } = await repo.createKnowledgeIfAbsent(record);
                if (wasCreated) {
                    const { knowledgeContentHash } = await import('../dist-backend/knowledge/schemas.js');
                    const sourceIds = draft.sourceRefs.map((r) => r.sourceId);
                    await repo.putRevision(knowledgeId, {
                        schemaVersion: 1,
                        revision,
                        contentHash: knowledgeContentHash({ key: draft.key, value: draft.value, answerJa: draft.answerJa, answerType: draft.answerType, evidenceState: draft.evidenceState, sourceIds, asOf: draft.asOf, validity: draft.validity }),
                        value: draft.value,
                        answerJa: draft.answerJa,
                        answerType: draft.answerType,
                        evidenceState: draft.evidenceState,
                        sourceRefs: draft.sourceRefs,
                        asOf: draft.asOf,
                        checkedOn: draft.checkedOn,
                        validity: draft.validity,
                        approval: { approvedBy: null, approvedAt: null, reason: null, revision: null, contentHash: null },
                        operatorNote: draft.operatorNote,
                        reviewQuestion: draft.reviewQuestion,
                        createdAt: now,
                        createdBy: actor.subject
                    });
                    created += 1;
                }
            } else if (plan.collection === 'receptionPolicies' && repo.putPolicy) {
                await repo.putPolicy(plan.doc);
                created += 1;
            }
        }
        pendingImports.delete(request.params.id);
        noStore(reply);
        return reply.send({ importId: request.params.id, created, publication: 'all items remain draft' });
    }));

    // =====================================================================
    // Escalations
    // =====================================================================

    fastify.get('/api/admin/v2/escalations', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const query = request.query ?? {};
        const result = await escalationService.list(actor, {
            state: query.state || undefined,
            unacknowledgedOnly: query.unacknowledged === 'true',
            limit: query.limit ? Number(query.limit) : undefined,
            cursor: query.cursor || undefined
        });
        noStore(reply);
        return reply.send(result);
    }));

    fastify.get('/api/admin/v2/escalations/:id', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const record = await escalationService.get(actor, request.params.id);
        if (!record) return reply.code(404).send({ code: 'NOT_FOUND', message: 'escalation not found', requestId: request.id });
        noStore(reply);
        return reply.header('ETag', etagFor('esc', record)).send({ escalation: record });
    }));

    fastify.post('/api/admin/v2/escalations', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const record = await escalationService.create(actor, request.body ?? {});
        noStore(reply);
        return reply.code(201).header('ETag', etagFor('esc', record)).send({ escalation: record });
    }));

    fastify.patch('/api/admin/v2/escalations/:id', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const ifMatch = parseIfMatch(request, 'esc');
        if (!ifMatch.ok) {
            return reply.code(ifMatch.status).send({ code: ifMatch.error, message: 'If-Match required', requestId: request.id });
        }
        const { ownerRole, ownerSubject, ackDeadlineAt } = request.body ?? {};
        const updated = await escalationService.assign(actor, request.params.id, { ownerRole, ownerSubject, ackDeadlineAt, expectedVersion: ifMatch.version });
        noStore(reply);
        return reply.header('ETag', etagFor('esc', updated)).send({ escalation: updated });
    }));

    fastify.post('/api/admin/v2/escalations/:id/acknowledge', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const updated = await escalationService.acknowledge(actor, request.params.id);
        noStore(reply);
        return reply.header('ETag', etagFor('esc', updated)).send({ escalation: updated });
    }));

    fastify.post('/api/admin/v2/escalations/:id/resolve', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const updated = await escalationService.resolve(actor, request.params.id, { note: request.body?.note ?? '' });
        noStore(reply);
        return reply.send({ escalation: updated });
    }));

    fastify.post('/api/admin/v2/escalations/:id/notify-requests', {
        preHandler: async (request, reply) => { await guard(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        // Recording a notification request — the actual send goes through the
        // existing notification outbox. Sent ≠ acknowledged.
        const updated = await escalationService.markNotified(actor, request.params.id);
        noStore(reply);
        return reply.send({ escalation: updated, note: '通知送信を記録しました。受諾は別の本人ACK操作が必要です。' });
    }));

    // =====================================================================
    // Status — for the settings/diagnostics page
    // =====================================================================

    fastify.get('/api/admin/v2/status', {
        preHandler: async (request, reply) => { await authenticate(request, reply); }
    }, handle(async (request, reply) => {
        const actor = request.v2Actor;
        const repo = knowledgeRepository ?? knowledgeService.repo;
        const settings = await repo.getRuntimeSettings();
        const { items: knowledge } = await knowledgeService.list(actor, { limit: 200 });
        noStore(reply);
        return reply.send({
            actor: { subject: actor.subject, roles: actor.roles, sharedAccount: actor.sharedAccount },
            knowledge: {
                total: knowledge.length,
                currentReleaseId: settings.currentReleaseId,
                revocationEpoch: settings.revocationEpoch,
                byState: knowledge.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {})
            },
            voiceProvider: process.env.VOICE_PROVIDER ?? 'realtime',
            routingProvider: process.env.ROUTING_PROVIDER ?? 'legacy'
        });
    }));
}
