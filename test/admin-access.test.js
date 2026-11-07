import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { registerAdminRoutes } from '../lib/admin-routes.js';
import { registerAdminV2Routes } from '../lib/admin-v2-routes.js';
import { createAdminPermissionGuard, deriveAdminActor, parseAdminSubjectMap } from '../lib/admin-access.js';
import { CallService } from '../dist-backend/calls/call-service.js';
import { InMemoryCallRepository } from '../dist-backend/calls/call-repository.js';
import { KnowledgeService } from '../dist-backend/knowledge/knowledge-service.js';
import { InMemoryKnowledgeRepository } from '../dist-backend/knowledge/repository.js';
import { EscalationService, InMemoryEscalationRepository } from '../dist-backend/escalations/escalation-service.js';

const subjectMap = Object.fromEntries(['viewer', 'operator', 'supervisor', 'knowledge_editor'].map(role => [role, {
    subject: `test-${role}`, roles: [role], sharedAccount: false
}]));
// Synthetic authentication isolates role authorization; strict real Basic
// parsing is exercised by admin-routes.test.js.
const auth = { authenticate: async request => request.headers.authorization
    ? { ok: true, actor: request.headers.authorization } : { ok: false, configured: true } };
const headers = actor => ({ authorization: actor });
const operator = subjectMap.operator;

const setup = async t => {
    const app = Fastify();
    const repo = new InMemoryCallRepository();
    const calls = new CallService(repo);
    const { record } = await calls.createManual(operator, {
        summary: 'PRIVATE_SUMMARY', callerName: 'PRIVATE_NAME', contact: '09000001111',
        memo: 'PRIVATE_MEMO', intent: 'PRIVATE_INTENT', callbackRequestedWindow: 'PRIVATE_WINDOW'
    });
    await calls.patch(operator, record.callId, {
        effective: { callerName: 'PRIVATE_NEW_NAME', callbackNumber: '09000002222' },
        ops: { tags: ['PRIVATE_TAG'] }, changeReason: 'PRIVATE_REASON'
    }, record.recordVersion);
    await repo.appendEvent({ eventId: 'test-private-event', callId: record.callId, actor: 'test-operator',
        action: 'call.test', result: 'success', metadata: { transcript: 'PRIVATE_TRANSCRIPT' }, timestamp: new Date().toISOString() });
    const mutations = { ops: 0, cleanup: 0, runtime: 0, retry: 0 };
    const legacy = { callSid: 'CA_SYNTHETIC', customerName: 'PRIVATE_NAME', from: '09000001111', transcript: 'PRIVATE_TRANSCRIPT' };
    app.register(formbody);
    app.register(registerAdminRoutes, {
        auth, subjectMap, auditLog: () => {},
        store: {
            list: async () => [legacy], get: async () => legacy,
            summary: async () => ({ total: 1 }),
            updateOps: async () => { mutations.ops++; return legacy; },
            deleteTestOrEmptyLogs: async () => { mutations.cleanup++; return { deleted: 0, items: [] }; }
        },
        settingsStore: { get: async () => ({}), update: async () => { mutations.runtime++; return {}; } },
        config: async () => ({})
    });
    const escalations = new EscalationService(new InMemoryEscalationRepository());
    const escalation = await escalations.create(subjectMap.supervisor, { summary: 'PRIVATE_ESCALATION', importance: 'critical' });
    await escalations.resolve(subjectMap.supervisor, escalation.caseId, { note: 'PRIVATE_RESOLUTION' });
    app.register(registerAdminV2Routes, {
        adminAuth: auth, subjectMap, callService: calls,
        knowledgeService: new KnowledgeService(new InMemoryKnowledgeRepository()),
        escalationService: escalations
    });
    app.post('/test/retry', { preHandler: createAdminPermissionGuard({ auth, subjectMap, permission: 'notifications.retry' }) }, async () => {
        mutations.retry++; return { ok: true };
    });
    await app.ready();
    t.after(() => app.close());
    return { app, record, mutations, escalation };
};

test('viewer and unmapped credentials cannot bypass v2 permissions through legacy routes', async t => {
    const { app, record, mutations } = await setup(t);
    for (const actor of ['viewer', 'unmapped', 'knowledge_editor']) {
        for (const url of ['/api/admin/call-logs', '/api/admin/call-logs/CA_SYNTHETIC']) {
            const result = await app.inject({ url, headers: headers(actor) });
            assert.equal(result.statusCode, 403, `${actor} ${url}`);
            assert.doesNotMatch(result.body, /PRIVATE_|0900000/);
        }
        for (const [method, url, payload] of [
            ['PATCH', '/api/admin/call-logs/CA_SYNTHETIC/ops', { ops: { status: 'done' } }],
            ['DELETE', '/api/admin/call-logs/test-or-empty', undefined],
            ['PATCH', '/api/admin/runtime-config', { realtimeModel: 'gpt-realtime-2.1-mini' }],
            ['POST', '/test/retry', undefined]
        ]) {
            const result = await app.inject({ method, url, payload, headers: headers(actor) });
            assert.equal(result.statusCode, 403, `${actor} ${method} ${url}`);
        }
    }
    const denied = await app.inject({ method: 'PATCH', url: `/api/admin/v2/calls/${record.callId}`,
        headers: { ...headers('viewer'), 'if-match': '"call-v2"' }, payload: { ops: { status: 'done' }, changeReason: 'x' } });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(mutations, { ops: 0, cleanup: 0, runtime: 0, retry: 0 });
    const summary = await app.inject({ url: '/api/admin/summary', headers: headers('viewer') });
    assert.equal(summary.statusCode, 200);
});

test('viewer responses redact current text, correction values/reasons and audit metadata', async t => {
    const { app, record } = await setup(t);
    for (const url of ['/api/admin/v2/calls', `/api/admin/v2/calls/${record.callId}`, `/api/admin/v2/calls/${record.callId}/history`]) {
        const result = await app.inject({ url, headers: headers('viewer') });
        assert.equal(result.statusCode, 200);
        assert.doesNotMatch(result.body, /PRIVATE_|0900000/, url);
    }
    for (const url of [`/api/admin/v2/calls/${record.callId}`, `/api/admin/v2/calls/${record.callId}/history`, '/api/admin/call-logs/CA_SYNTHETIC']) {
        const result = await app.inject({ url, headers: headers('operator') });
        assert.equal(result.statusCode, 200);
        assert.match(result.body, /PRIVATE_/);
    }
});

test('legacy operator writes require same-origin JSON and preserve authorized functionality', async t => {
    const { app, mutations } = await setup(t);
    const url = '/api/admin/call-logs/CA_SYNTHETIC/ops';
    const rejected = await app.inject({ method: 'PATCH', url, headers: { ...headers('operator'), origin: 'https://foreign.invalid' }, payload: { ops: { status: 'done' } } });
    assert.equal(rejected.statusCode, 403);
    const form = await app.inject({ method: 'POST', url: '/test/retry', headers: { ...headers('operator'), 'content-type': 'application/x-www-form-urlencoded' }, payload: 'retry=true' });
    assert.equal(form.statusCode, 415);
    assert.equal(mutations.retry, 0);
    const ok = await app.inject({ method: 'PATCH', url, headers: headers('operator'), payload: { ops: { status: 'done' } } });
    assert.equal(ok.statusCode, 200);
    assert.equal(mutations.ops, 1);
    const deniedCleanup = await app.inject({ method: 'DELETE', url: '/api/admin/call-logs/test-or-empty', headers: headers('operator') });
    assert.equal(deniedCleanup.statusCode, 403);
    const cleanup = await app.inject({ method: 'DELETE', url: '/api/admin/call-logs/test-or-empty', headers: headers('supervisor') });
    assert.equal(cleanup.statusCode, 200);
    const retry = await app.inject({ method: 'POST', url: '/test/retry', headers: headers('operator') });
    assert.equal(retry.statusCode, 200);
    assert.equal(mutations.retry, 1);
});

test('subject derivation cannot inherit prototype properties as roles', () => {
    assert.deepEqual(deriveAdminActor('constructor', {}), { subject: 'constructor', roles: ['viewer'], sharedAccount: true });
    assert.deepEqual(parseAdminSubjectMap('{"user":{"roles":["invalid","viewer"]}}').user.roles, ['viewer']);
});


test('viewer cannot recover call PII through escalation summaries or resolution notes', async t => {
    const { app, escalation } = await setup(t);
    for (const url of ['/api/admin/v2/escalations', `/api/admin/v2/escalations/${escalation.caseId}`]) {
        const viewer = await app.inject({ url, headers: headers('viewer') });
        assert.equal(viewer.statusCode, 200);
        assert.doesNotMatch(viewer.body, /PRIVATE_/, url);
        const operator = await app.inject({ url, headers: headers('operator') });
        assert.equal(operator.statusCode, 200);
        assert.match(operator.body, /PRIVATE_ESCALATION/);
        assert.match(operator.body, /PRIVATE_RESOLUTION/);
    }
});
