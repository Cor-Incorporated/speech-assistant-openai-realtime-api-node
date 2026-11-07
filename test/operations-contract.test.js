import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createAdminBasicAuth } from '../lib/admin-routes.js';
import { registerAdminV2Routes } from '../lib/admin-v2-routes.js';
import { NotificationOutbox } from '../lib/notification-outbox.js';
import { InMemoryKnowledgeRepository } from '../dist-backend/knowledge/repository.js';
import { KnowledgeService } from '../dist-backend/knowledge/knowledge-service.js';
import { EscalationService, InMemoryEscalationRepository, VersionConflictError } from '../dist-backend/escalations/escalation-service.js';

const actor = { subject: 'review-supervisor', roles: ['supervisor', 'knowledge_editor'], sharedAccount: false };
const authorization = `Basic ${Buffer.from('review:synthetic-test-secret').toString('base64')}`;
const draft = {
    key: 'review.hours', title: '営業時間', category: 'hours', locale: 'ja-JP', keywords: ['営業時間'],
    audience: 'public', handling: 'answer_after_approval', riskLevel: 'normal', value: { weekday: '10:00-18:00' },
    answerJa: '平日10時から18時です。', answerType: 'fact', evidenceState: 'official_site_observed',
    sourceRefs: [{ sourceId: 'PUB-01' }], asOf: '2026-11-07', validity: { effectiveFrom: null, expiresAt: null, nextReviewAt: null }
};

async function fixture(t, options = {}) {
    const repository = new InMemoryEscalationRepository();
    const service = new EscalationService(repository, options.clock);
    const knowledgeRepository = new InMemoryKnowledgeRepository();
    const app = Fastify({ logger: false });
    await app.register(registerAdminV2Routes, {
        adminAuth: createAdminBasicAuth({ user: 'review', password: 'synthetic-test-secret' }),
        subjectMap: { review: actor },
        knowledgeService: new KnowledgeService(knowledgeRepository),
        knowledgeRepository,
        escalationService: service,
        notifyEscalation: options.notifyEscalation ?? null
    });
    await app.ready();
    t.after(() => app.close());
    const api = async (method, url, payload, headers = {}) => {
        const response = await app.inject({ method, url, headers: { authorization, ...headers }, ...(payload === undefined ? {} : { payload }) });
        return { status: response.statusCode, etag: response.headers.etag, body: response.json() };
    };
    return { app, api, service, repository, knowledgeRepository };
}

test('stale knowledge deletion is rejected before deletion or runtime revocation', async (t) => {
    const { api, knowledgeRepository } = await fixture(t);
    const created = await api('POST', '/api/admin/v2/knowledge', draft);
    const id = created.body.knowledge.knowledgeId;
    const updated = await api('PATCH', `/api/admin/v2/knowledge/${id}`, { ...draft, title: '他の担当者の更新' }, { 'if-match': created.etag });
    assert.equal(updated.status, 200);
    const settingsBefore = await knowledgeRepository.getRuntimeSettings();
    const stale = await api('DELETE', `/api/admin/v2/knowledge/${id}`, { reason: '古いタブから削除' }, { 'if-match': created.etag });
    assert.equal(stale.status, 412);
    assert.equal((await api('GET', `/api/admin/v2/knowledge/${id}`)).body.knowledge.deletedAt, null);
    assert.deepEqual(await knowledgeRepository.getRuntimeSettings(), settingsBefore);
    assert.equal((await api('DELETE', `/api/admin/v2/knowledge/${id}`, { reason: '最新内容を確認して削除' }, { 'if-match': updated.etag })).status, 200);
});

test('notification API does not claim delivery without an adapter or on provider failure; retries share the provider key', async (t) => {
    const unavailable = await fixture(t);
    const first = await unavailable.service.create(actor, { importance: 'high' });
    assert.equal((await unavailable.api('POST', `/api/admin/v2/escalations/${first.caseId}/notify-requests`)).status, 503);
    assert.equal((await unavailable.repository.get(first.caseId)).notifiedAt, null);

    const requests = [];
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'synthetic', from: 'test@example.test', to: 'ops@example.test',
        fetchImpl: async (_url, request) => {
            requests.push(request);
            return requests.length === 1 ? new Response('{"message":"temporary"}', { status: 503 }) : new Response('{"id":"synthetic-mail"}');
        }
    });
    const { api, service, repository } = await fixture(t, {
        notifyEscalation: (record) => outbox.enqueue({ kind: `escalation-request:${record.caseId}`, callId: record.callId || record.caseId, subject: 'test', text: 'test' })
    });
    const record = await service.create(actor, { importance: 'critical' });
    const url = `/api/admin/v2/escalations/${record.caseId}/notify-requests`;
    assert.equal((await api('POST', url)).status, 502);
    assert.equal((await repository.get(record.caseId)).notifiedAt, null);
    const accepted = await api('POST', url);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.notification.status, 'accepted');
    assert.equal(accepted.body.escalation.state, 'notified');
    assert.equal((await api('POST', url)).status, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
    assert.equal(repository.getEvents().filter((event) => event.action === 'escalation.notify').length, 1);
});

test('two service and outbox instances retain ACK during an in-flight notification and send once', async () => {
    const rows = new Map();
    let transactions = Promise.resolve();
    const firestore = {
        collection: () => ({ doc: (id) => ({ id }) }),
        runTransaction: (work) => {
            const result = transactions.then(() => work({
                get: async (doc) => ({ exists: rows.has(doc.id), data: () => rows.get(doc.id) }),
                set: (doc, value) => rows.set(doc.id, structuredClone(value))
            }));
            transactions = result.catch(() => {});
            return result;
        }
    };
    const repository = new InMemoryEscalationRepository();
    const first = new EscalationService(repository);
    const second = new EscalationService(repository);
    let release, started;
    const waiting = new Promise((resolve) => { release = resolve; });
    const sending = new Promise((resolve) => { started = resolve; });
    let sends = 0;
    const options = {
        enabled: true, apiKey: 'synthetic', from: 'test@example.test', to: 'ops@example.test', firestoreEnabled: true, firestore,
        fetchImpl: async () => { sends += 1; started(); await waiting; return new Response('{"id":"one-mail"}'); }
    };
    const delivery = (outbox) => (record) => outbox.enqueue({ kind: `escalation-request:${record.caseId}`, callId: record.callId || record.caseId, subject: 'test', text: 'test' });
    const record = await first.create(actor, { importance: 'critical' });
    const pending = first.requestNotification(actor, record.caseId, delivery(new NotificationOutbox(options)));
    await sending;
    const concurrent = await second.requestNotification(actor, record.caseId, delivery(new NotificationOutbox(options)));
    assert.equal(concurrent.notification.status, 'sending');
    assert.equal(concurrent.escalation.notifiedAt, null);
    await second.acknowledge(actor, record.caseId);
    release();
    const accepted = await pending;
    assert.equal(accepted.escalation.state, 'acknowledged');
    assert.equal(accepted.escalation.acknowledgedBy, actor.subject);
    assert.ok(accepted.escalation.notifiedAt);
    assert.equal(sends, 1);
});

test('notification CAS retries retain connected state and idempotent ACK does not regress it', async () => {
    const repository = new InMemoryEscalationRepository();
    const service = new EscalationService(repository);
    const record = await service.create(actor, { importance: 'high' });
    const originalPut = repository.put.bind(repository);
    let conflicts = 0;
    repository.put = async (updated, expectedVersion) => {
        if (updated.notifiedAt && conflicts++ === 0) {
            await originalPut({ ...record, state: 'connected', recordVersion: record.recordVersion + 1 });
            throw new VersionConflictError('concurrent transport transition');
        }
        return originalPut(updated, expectedVersion);
    };
    const result = await service.requestNotification(actor, record.caseId, async () => ({ ok: true, status: 'accepted' }));
    assert.equal(result.escalation.state, 'connected');
    assert.equal((await service.acknowledge(actor, record.caseId)).state, 'connected');
});

test('notification identity preserves smoke exclusion and separates cases sharing one call', async (t) => {
    const requests = [];
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'synthetic', from: 'test@example.test', to: 'ops@example.test',
        fetchImpl: async (_url, request) => {
            requests.push(request);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return new Response(JSON.stringify({ id: `synthetic-mail-${requests.length}` }));
        }
    });
    const { api, service, repository } = await fixture(t, {
        notifyEscalation: (record) => outbox.enqueue({ kind: `escalation-request:${record.caseId}`, callId: record.callId || record.caseId, subject: 'test', text: 'test' })
    });
    const first = await service.create(actor, { importance: 'high', callId: 'CA_SHARED_REVIEW' });
    const second = await service.create(actor, { importance: 'high', callId: 'CA_SHARED_REVIEW' });
    const path = (record) => `/api/admin/v2/escalations/${record.caseId}/notify-requests`;
    const concurrent = await Promise.all([api('POST', path(first)), api('POST', path(first))]);
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
    assert.equal((await api('POST', path(first))).status, 200);
    assert.equal(requests.length, 1);
    assert.equal((await api('POST', path(second))).status, 200);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
    const smoke = await service.create(actor, { importance: 'high', callId: 'CA_SMOKE_REVIEW' });
    const skipped = await api('POST', path(smoke));
    assert.equal(skipped.body.notification.reason, 'smoke_call');
    assert.equal(skipped.body.notification.ok, false);
    assert.equal((await repository.get(smoke.caseId)).notifiedAt, null);
    assert.equal(requests.length, 2);
});

test('a notification finishing after a transport or resolution update retains the newer state', async () => {
    for (const state of ['acknowledged', 'connecting', 'connected', 'resolved', 'unavailable']) {
        const repository = new InMemoryEscalationRepository();
        const service = new EscalationService(repository);
        const record = await service.create(actor, { importance: 'critical' });
        const result = await service.requestNotification(actor, record.caseId, async () => {
            await repository.put({ ...record, state, recordVersion: 2 });
            return { ok: true, status: 'accepted' };
        });
        assert.equal(result.escalation.state, state);
        assert.ok(result.escalation.notifiedAt);
    }
});

test('notification API distinguishes in-progress from accepted and authorizes before delivery', async (t) => {
    const { api, service } = await fixture(t, { notifyEscalation: async () => ({ ok: false, status: 'sending', reason: 'delivery_in_progress' }) });
    const record = await service.create(actor, { importance: 'critical' });
    const response = await api('POST', `/api/admin/v2/escalations/${record.caseId}/notify-requests`);
    assert.equal(response.status, 202);
    assert.equal(response.body.escalation.notifiedAt, null);
    let sends = 0;
    await assert.rejects(service.requestNotification({ subject: 'operator', roles: ['operator'], sharedAccount: false }, record.caseId, async () => {
        sends += 1;
        return { ok: true, status: 'accepted' };
    }), (error) => error.code === 'FORBIDDEN');
    assert.equal(sends, 0);
});

test('overdue filtering precedes pagination and excludes ACK/connected/resolved records', async (t) => {
    const { api, service, repository } = await fixture(t, { clock: { now: () => '2026-11-07T01:00:00.000Z' } });
    const overdue = await service.create(actor, { importance: 'critical', ownerSubject: 'person-1', ackDeadlineAt: '2026-11-07T00:01:00.000Z' });
    await service.create(actor, { importance: 'critical', ackDeadlineAt: '2026-11-07T02:00:00.000Z' });
    for (const state of ['acknowledged', 'connecting', 'connected', 'resolved']) {
        const record = await service.create(actor, { importance: 'high', ackDeadlineAt: '2026-11-07T00:01:00.000Z' });
        await repository.put({ ...record, state });
    }
    const listed = await api('GET', '/api/admin/v2/escalations?overdue=true&limit=1');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items.map((record) => record.caseId), [overdue.caseId]);
    assert.equal(listed.body.items[0].ackOverdue, true);
    if (listed.body.nextCursor) {
        const rest = await api('GET', `/api/admin/v2/escalations?overdue=true&limit=200&cursor=${encodeURIComponent(listed.body.nextCursor)}`);
        assert.equal(rest.body.items.length, 0);
        assert.equal(rest.body.hasMore, false);
    }
    const detail = await api('GET', `/api/admin/v2/escalations/${overdue.caseId}`);
    assert.equal(detail.body.escalation.ackOverdue, true);
    assert.equal((await api('PATCH', `/api/admin/v2/escalations/${overdue.caseId}`, { ackDeadlineAt: '2026-02-30T00:00:00Z' }, { 'if-match': detail.etag })).status, 422);
    assert.equal((await api('PATCH', `/api/admin/v2/escalations/${overdue.caseId}`, { ownerRole: 'viewer' }, { 'if-match': detail.etag })).status, 422);
    assert.equal((await api('PATCH', `/api/admin/v2/escalations/${overdue.caseId}`, { ownerSubject: '' }, { 'if-match': detail.etag })).status, 422);
    const assigned = await api('PATCH', `/api/admin/v2/escalations/${overdue.caseId}`, { ownerSubject: 'person-2', ackDeadlineAt: null }, { 'if-match': detail.etag });
    assert.equal(assigned.status, 200);
    assert.equal((await api('PATCH', `/api/admin/v2/escalations/${overdue.caseId}`, { ownerSubject: 'stale' }, { 'if-match': detail.etag })).status, 412);
    assert.equal((await api('POST', `/api/admin/v2/escalations/${overdue.caseId}/resolve`, { note: ' ' })).status, 422);
});
