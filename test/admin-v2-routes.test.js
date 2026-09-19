// Admin v2 API integration tests — real Fastify + real routes over
// in-memory repositories. Covers the API contract: auth, permissions,
// ETag/If-Match, idempotency, CSRF origin guard, PII projection,
// knowledge lifecycle end-to-end, and escalation ACK semantics.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { createAdminBasicAuth } from '../lib/admin-routes.js';
import { registerAdminV2Routes } from '../lib/admin-v2-routes.js';
import { InMemoryKnowledgeRepository } from '../dist-backend/knowledge/repository.js';
import { KnowledgeService } from '../dist-backend/knowledge/knowledge-service.js';
import { KnowledgeReader } from '../dist-backend/knowledge/knowledge-reader.js';
import { InMemoryCallRepository } from '../dist-backend/calls/call-repository.js';
import { CallService } from '../dist-backend/calls/call-service.js';
import { EscalationService, InMemoryEscalationRepository } from '../dist-backend/escalations/escalation-service.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'test-secret';
const basic = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`;

const subjectMap = {
    [ADMIN_USER]: {
        subject: 'admin@cor.example',
        roles: ['operator', 'knowledge_editor', 'knowledge_approver', 'supervisor'],
        sharedAccount: false // dev-mode individual subject for testing
    }
};

const draft = (overrides = {}) => ({
    key: 'company.hours',
    title: '営業時間',
    category: 'hours',
    locale: 'ja-JP',
    keywords: ['営業時間'],
    audience: 'public',
    handling: 'answer_after_approval',
    riskLevel: 'normal',
    value: { weekday: '10:00-18:00' },
    answerJa: '営業時間は平日10時から18時です。',
    answerType: 'fact',
    evidenceState: 'official_site_observed',
    sourceRefs: [{ sourceId: 'PUB-01' }],
    asOf: '2026-09-19',
    validity: { effectiveFrom: null, expiresAt: null, nextReviewAt: null },
    ...overrides
});

describe('admin v2 API', () => {
    let app;
    let baseUrl;
    let knowledgeService;
    let callService;
    let escalationService;
    let knowledgeRepo;

    before(async () => {
        knowledgeRepo = new InMemoryKnowledgeRepository();
        knowledgeService = new KnowledgeService(knowledgeRepo);
        callService = new CallService(new InMemoryCallRepository());
        escalationService = new EscalationService(new InMemoryEscalationRepository());
        const adminAuth = createAdminBasicAuth({ user: ADMIN_USER, password: ADMIN_PASS });

        app = Fastify({ logger: false });
        // Same registration path as index.js — a non-async plugin times out
        // under fastify.register, so the test must exercise it too.
        app.register(registerAdminV2Routes, {
            adminAuth,
            knowledgeService,
            callService,
            escalationService,
            knowledgeReader: new KnowledgeReader(knowledgeRepo),
            knowledgeRepository: knowledgeRepo,
            subjectMap
        });
        await app.listen({ port: 0, host: '127.0.0.1' });
        baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    });

    after(async () => {
        await app.close();
    });

    const api = async (method, path, { body, headers = {} } = {}) => {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                authorization: basic,
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                ...headers
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        let json = null;
        try {
            json = await response.json();
        } catch {
            // empty body
        }
        return { status: response.status, json, headers: response.headers, etag: response.headers.get('etag') };
    };

    it('rejects unauthenticated requests', async () => {
        const response = await fetch(`${baseUrl}/api/admin/v2/knowledge`);
        assert.equal(response.status, 401);
    });

    it('knowledge: draft → approve → publish → release readable', async () => {
        const created = await api('POST', '/api/admin/v2/knowledge', { body: draft() });
        assert.equal(created.status, 201);
        const knowledge = created.json.knowledge;
        assert.equal(knowledge.state, 'draft');

        const revisions = await api('GET', `/api/admin/v2/knowledge/${knowledge.knowledgeId}/revisions`);
        assert.equal(revisions.json.items.length, 1);
        const contentHash = revisions.json.items[0].contentHash;

        const approved = await api('POST', `/api/admin/v2/knowledge/${knowledge.knowledgeId}/approve`, {
            body: { revision: 1, contentHash, reason: '内容確認済み' }
        });
        assert.equal(approved.status, 200);
        assert.equal(approved.json.knowledge.state, 'approved');

        const release = await api('POST', '/api/admin/v2/knowledge-releases', { body: {} });
        assert.equal(release.status, 201);
        const releaseId = release.json.release.releaseId;

        const fetched = await api('GET', `/api/admin/v2/knowledge-releases/${releaseId}`);
        assert.equal(fetched.status, 200);
        assert.equal(fetched.json.current, true);
        assert.equal(fetched.json.items.length, 1);
        assert.equal(fetched.json.items[0].answerJa, '営業時間は平日10時から18時です。');
        // whitelist: no operatorNote field exists on published items
        assert.ok(!('operatorNote' in fetched.json.items[0]));
    });

    it('knowledge PATCH requires If-Match and enforces version', async () => {
        const created = await api('POST', '/api/admin/v2/knowledge', { body: draft({ key: 'company.name' }) });
        const id = created.json.knowledge.knowledgeId;

        const missing = await api('PATCH', `/api/admin/v2/knowledge/${id}`, { body: draft({ key: 'company.name' }) });
        assert.equal(missing.status, 428);

        const etag = created.etag;
        const stale = await api('PATCH', `/api/admin/v2/knowledge/${id}`, {
            body: draft({ key: 'company.name', title: 'x' }),
            headers: { 'if-match': '"kn-v99"' }
        });
        assert.equal(stale.status, 412);

        const ok = await api('PATCH', `/api/admin/v2/knowledge/${id}`, {
            body: draft({ key: 'company.name', title: '会社名（正式）' }),
            headers: { 'if-match': etag }
        });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.knowledge.draftRevision, 2);
    });

    it('knowledge preview returns whitelist only and never claims voice use', async () => {
        const created = await api('POST', '/api/admin/v2/knowledge', {
            body: draft({ key: 'preview.item', operatorNote: 'internal only' })
        });
        const id = created.json.knowledge.knowledgeId;
        const preview = await api('POST', '/api/admin/v2/knowledge/preview', { body: { knowledgeId: id } });
        assert.equal(preview.status, 200);
        assert.equal(preview.json.appliedToVoice, false);
        assert.ok(!('operatorNote' in (preview.json.wouldPublish ?? {})));
    });

    it('calls: manual create → patch with If-Match → corrections history → delete → restore', async () => {
        const created = await api('POST', '/api/admin/v2/calls', {
            body: { summary: 'テスト受付', callerName: '田中', contact: '09011112222' },
            headers: { 'idempotency-key': 'call-it-1' }
        });
        assert.equal(created.status, 201);
        const call = created.json.call;
        assert.equal(call.origin, 'manual');
        const etag = created.etag;

        // idempotent replay
        const replay = await api('POST', '/api/admin/v2/calls', {
            body: { summary: 'テスト受付', callerName: '田中', contact: '09011112222' },
            headers: { 'idempotency-key': 'call-it-1' }
        });
        assert.equal(replay.status, 200);
        assert.equal(replay.json.call.callId, call.callId);

        const patched = await api('PATCH', `/api/admin/v2/calls/${call.callId}`, {
            body: { ops: { status: 'needs_callback' }, changeReason: '折り返し対応へ' },
            headers: { 'if-match': etag }
        });
        assert.equal(patched.status, 200);
        assert.equal(patched.json.call.ops.status, 'needs_callback');

        const history = await api('GET', `/api/admin/v2/calls/${call.callId}/history`);
        assert.equal(history.status, 200);
        assert.ok(history.json.corrections.length >= 1);

        const deleted = await api('DELETE', `/api/admin/v2/calls/${call.callId}`, {
            body: { reason: 'テストデータのため' },
            headers: { 'if-match': patched.etag }
        });
        assert.equal(deleted.status, 200);
        assert.ok(deleted.json.call.deletedAt);

        const restored = await api('POST', `/api/admin/v2/calls/${call.callId}/restore`);
        assert.equal(restored.status, 200);
        assert.equal(restored.json.call.deletedAt, null);
    });

    it('calls PATCH without If-Match → 428', async () => {
        const created = await api('POST', '/api/admin/v2/calls', { body: { summary: 'x' } });
        const res = await api('PATCH', `/api/admin/v2/calls/${created.json.call.callId}`, {
            body: { ops: { status: 'done' }, changeReason: 'r' }
        });
        assert.equal(res.status, 428);
    });

    it('CSRF: cross-origin write is rejected', async () => {
        const response = await fetch(`${baseUrl}/api/admin/v2/calls`, {
            method: 'POST',
            headers: {
                authorization: basic,
                'content-type': 'application/json',
                origin: 'https://evil.example.com'
            },
            body: JSON.stringify({ summary: 'x' })
        });
        assert.equal(response.status, 403);
        const json = await response.json();
        assert.equal(json.code, 'CSRF_ORIGIN');
    });

    it('escalations: notify does NOT equal acknowledge; ACK binds to the subject', async () => {
        const created = await api('POST', '/api/admin/v2/escalations', {
            body: { importance: 'critical', summary: '情報漏えいの可能性' }
        });
        assert.equal(created.status, 201);
        const esc = created.json.escalation;

        const notified = await api('POST', `/api/admin/v2/escalations/${esc.caseId}/notify-requests`);
        assert.equal(notified.status, 200);
        assert.equal(notified.json.escalation.state, 'notified');
        assert.equal(notified.json.escalation.acknowledgedBy, null);

        const acked = await api('POST', `/api/admin/v2/escalations/${esc.caseId}/acknowledge`);
        assert.equal(acked.status, 200);
        assert.equal(acked.json.escalation.state, 'acknowledged');
        assert.equal(acked.json.escalation.acknowledgedBy, 'admin@cor.example');

        const list = await api('GET', '/api/admin/v2/escalations?unacknowledged=true');
        assert.equal(list.json.items.length, 0);
    });

    it('imports: dry-run reports plan; execute is create-only and keeps draft', async () => {
        const manifest = {
            application_format: 'cor-seed-v1',
            allowed_collections: ['corKnowledge'],
            records: [{
                collection: 'corKnowledge',
                document_id: 'COR-K-IMP1',
                data: { knowledgeId: 'COR-K-IMP1', key: 'import.test', draftRevision: 1, publishedRevision: null, recordVersion: 1, state: 'draft', deletedAt: null },
                children: [{
                    collection: 'revisions',
                    document_id: 'r1',
                    data: {
                        knowledge_id: 'COR-K-IMP1', key: 'import.test', title: 'インポート試験',
                        category: 'company', locale: 'ja-JP', value: { x: 1 },
                        answer_ja: 'テスト回答', evidence_state: 'official_site_observed',
                        publication_state: 'draft', audience: 'public', handling: 'answer_after_approval',
                        risk_level: 'normal', as_of: '2026-09-19', checked_on: '2026-09-19',
                        validity: { effective_from: null, expires_at: null },
                        approval: { approved_by: null, approved_at: null, approval_reason: null },
                        revision: 1, source_ids: [], source_locator: null, operator_note: null,
                        review_question: null, keywords: [], synthetic: true,
                        content_hash: 'abc123'
                    }
                }]
            }]
        };
        const dry = await api('POST', '/api/admin/v2/knowledge-imports/dry-run', { body: { manifest } });
        assert.equal(dry.status, 200);
        assert.equal(dry.json.summary.create, 1);

        const exec = await api('POST', `/api/admin/v2/knowledge-imports/${dry.json.importId}/execute`);
        assert.equal(exec.status, 200);
        assert.equal(exec.json.created, 1);

        const record = await api('GET', '/api/admin/v2/knowledge/COR-K-IMP1');
        assert.equal(record.json.knowledge.state, 'draft');
    });
});
