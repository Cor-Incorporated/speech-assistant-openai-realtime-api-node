import assert from 'node:assert/strict';
import test from 'node:test';
import {
    checkSyncFacts,
    evaluateAction
} from '../dist-backend/domain/action-gate.js';
import {
    ActionLedger,
    InMemoryLedgerStore
} from '../dist-backend/infrastructure/action-ledger.js';

const request = {
    actionId: 'call-1:handoff:r3',
    kind: 'handoff_start',
    targetRevision: 3,
    target: 'general'
};

const baseFacts = {
    schemaOk: true,
    allowedKinds: ['handoff_start', 'call_end', 'notification_send'],
    allowedTargets: ['contract', 'general'],
    policyAllows: true,
    confirmationSatisfied: true,
    currentRevision: 3,
    callLifecycle: 'active'
};

test('schema validation is the first check — nothing proceeds on bad input', () => {
    const verdict = checkSyncFacts(request, { ...baseFacts, schemaOk: false });
    assert.deepEqual(verdict, { allow: false, reason: 'schema_invalid' });
});

test('action kind and target must be on the allowlists (FAULT-007)', () => {
    assert.equal(
        checkSyncFacts(
            { ...request, kind: 'wire_transfer' },
            baseFacts
        ).reason,
        'action_kind_not_allowed'
    );
    // 'finance' must not normalize into 'general' — the gate denies it.
    assert.equal(
        checkSyncFacts(
            { ...request, target: 'finance' },
            baseFacts
        ).reason,
        'action_target_not_allowed'
    );
});

test('policy denial and missing confirmation are distinct reasons', () => {
    assert.equal(
        checkSyncFacts(request, { ...baseFacts, policyAllows: false }).reason,
        'policy_denied'
    );
    // FAULT-012: a format-valid phone number is not caller confirmation —
    // the gate still requires the confirmation fact.
    assert.equal(
        checkSyncFacts(request, { ...baseFacts, confirmationSatisfied: false }).reason,
        'confirmation_missing'
    );
});

test('ended or transferred calls cannot run new side effects', () => {
    for (const callLifecycle of ['ended', 'transferred']) {
        const verdict = checkSyncFacts(request, { ...baseFacts, callLifecycle });
        assert.equal(verdict.reason, 'call_not_active');
    }
    assert.equal(
        checkSyncFacts(request, { ...baseFacts, callLifecycle: 'closing' }).allow,
        true
    );
});

test('stale revision is denied even when everything else passes', () => {
    const verdict = checkSyncFacts(request, { ...baseFacts, currentRevision: 4 });
    assert.equal(verdict.reason, 'stale_revision');
});

test('full evaluation claims the ledger once; a second worker sees duplicate (FAULT-008)', async () => {
    const store = new InMemoryLedgerStore();
    const workerA = new ActionLedger(store);
    const workerB = new ActionLedger(store);

    const first = await evaluateAction(request, baseFacts, workerA);
    assert.equal(first.allow, true);
    assert.equal(first.claim, 'prepared');

    const second = await evaluateAction(request, baseFacts, workerB);
    assert.equal(second.allow, false);
    assert.match(second.reason, /^duplicate_action:/);
});

test('sync denial never reaches the ledger', async () => {
    const ledger = new ActionLedger(new InMemoryLedgerStore());
    const verdict = await evaluateAction(
        request,
        { ...baseFacts, schemaOk: false },
        ledger
    );
    assert.equal(verdict.allow, false);
    assert.equal(await ledger.get(request.actionId), null);
});
