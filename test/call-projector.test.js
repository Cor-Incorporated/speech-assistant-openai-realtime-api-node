// REVIEW-R09: provider calls must land in callLogsV2 — with an escalation
// case when human follow-up is required — and be idempotent on duplicate
// close events. Notification ≠ acknowledgement.

import assert from 'node:assert/strict';
import test from 'node:test';
import { projectProviderCall } from '../dist-backend/calls/call-projector.js';
import { InMemoryCallRepository } from '../dist-backend/calls/call-repository.js';
import { InMemoryEscalationRepository } from '../dist-backend/escalations/escalation-service.js';

const baseInput = {
    callId: 'CA' + 'a'.repeat(32),
    streamSid: 'MZ' + '0'.repeat(32),
    transportState: 'ended',
    startedAt: '2026-09-21T00:00:00.000Z',
    endedAt: '2026-09-21T00:01:00.000Z',
    durationSeconds: 60,
    fromNumberMasked: '090****5678',
    toNumberMasked: '03****1234',
    extraction: {
        summary: '営業時間の問い合わせ',
        callerName: 'テスト太郎',
        callbackNumber: '09012345678',
        callbackRequestedWindow: null,
        intent: '営業時間の確認',
        memo: null,
        model: 'gpt-live-1',
        extractedAt: '2026-09-21T00:01:00.000Z'
    },
    callbackRequired: true,
    outcome: 'completed',
    severity: { urgency: 'normal', importance: 'normal', humanRequested: false, riskKinds: [] },
    handoff: { requested: false, destination: null, outcome: null },
    knowledgeReleaseIds: ['rel_20260919004348_9b492cc4'],
    notificationSent: false
};

test('a completed provider call projects into callLogsV2', async () => {
    const repo = new InMemoryCallRepository();
    const { record, escalation } = await projectProviderCall(repo, null, baseInput);

    assert.equal(record.callId, baseInput.callId);
    assert.equal(record.origin, 'provider');
    assert.equal(record.providerCallSid, baseInput.callId);
    assert.equal(record.transportState, 'ended');
    assert.equal(record.durationSeconds, 60);
    assert.equal(record.fromNumberMasked, '090****5678');
    assert.equal(record.extraction.summary, '営業時間の問い合わせ');
    assert.equal(record.effective.callerName, 'テスト太郎');
    assert.equal(record.ops.status, 'needs_callback');
    assert.equal(record.ops.callbackStatus, 'pending');
    assert.equal(escalation, null);
});

test('a handoff-requested call creates an escalation case linked to the call', async () => {
    const repo = new InMemoryCallRepository();
    const escRepo = new InMemoryEscalationRepository();
    const { record, escalation } = await projectProviderCall(repo, escRepo, {
        ...baseInput,
        outcome: 'transferred',
        severity: { urgency: 'high', importance: 'high', humanRequested: true, riskKinds: [] },
        handoff: { requested: true, destination: 'contract', outcome: 'connected' },
        notificationSent: true
    });

    assert.ok(escalation, 'escalation case must exist');
    assert.equal(escalation.callId, record.callId);
    assert.equal(escalation.state, 'notified'); // notified, NOT acknowledged
    assert.equal(escalation.acknowledgedBy, null);
    assert.equal(record.humanCase.caseId, escalation.caseId);
    assert.equal(record.humanCase.state, 'notified');
});

test('duplicate close events never double-create the call or the case', async () => {
    const repo = new InMemoryCallRepository();
    const escRepo = new InMemoryEscalationRepository();
    const input = {
        ...baseInput,
        severity: { importance: 'high', humanRequested: true },
        handoff: { requested: true, destination: 'general', outcome: 'timeout' }
    };
    await projectProviderCall(repo, escRepo, input);
    await projectProviderCall(repo, escRepo, input);
    const third = await projectProviderCall(repo, escRepo, input);

    const { items } = await repo.list({});
    assert.equal(items.length, 1);
    const cases = await escRepo.list({});
    assert.equal(cases.items.length, 1);
    assert.equal(third.record.recordVersion >= 3, true);
});

test('a start-time projection without extraction still creates the record', async () => {
    const repo = new InMemoryCallRepository();
    const { record } = await projectProviderCall(repo, null, {
        callId: 'CA' + 'b'.repeat(32),
        transportState: 'connected',
        startedAt: '2026-09-21T00:00:00.000Z',
        endedAt: null,
        durationSeconds: null,
        fromNumberMasked: null,
        toNumberMasked: null,
        callbackRequired: false,
        outcome: 'abandoned'
    });
    assert.equal(record.transportState, 'connected');
    assert.equal(record.ops.status, 'new');

    // Completion merges onto the same callId.
    const done = await projectProviderCall(repo, null, {
        ...baseInput,
        callId: record.callId
    });
    assert.equal(done.record.transportState, 'ended');
    assert.equal(done.record.extraction.summary, '営業時間の問い合わせ');
    const { items } = await repo.list({});
    assert.equal(items.length, 1);
});

test('notification never implies acknowledgement', async () => {
    const repo = new InMemoryCallRepository();
    const escRepo = new InMemoryEscalationRepository();
    const { escalation } = await projectProviderCall(repo, escRepo, {
        ...baseInput,
        severity: { importance: 'high' },
        handoff: { requested: true, destination: 'general', outcome: 'failed' },
        notificationSent: true
    });
    assert.equal(escalation.state, 'notified');
    assert.equal(escalation.acknowledgedAt, null);
    assert.equal(escalation.acknowledgedBy, null);
});
