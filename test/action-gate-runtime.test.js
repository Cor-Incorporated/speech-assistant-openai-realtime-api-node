// REVIEW-R03: the JS runtime bridge must pass the ActionLedger into the
// compiled evaluateAction — calling it with two arguments threw a TypeError
// and silently denied every side-effecting action (handoff, call end).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionGateRuntime } from '../lib/action-gate-runtime.js';

const baseRequest = {
    actionId: 'call-rt:handoff:r1',
    kind: 'handoff_start',
    targetRevision: 1,
    target: 'contract'
};

const baseFacts = {
    allowedKinds: ['handoff_start', 'call_end', 'notification_send', 'context_write'],
    allowedTargets: ['contract', 'general'],
    policyAllows: true,
    confirmationSatisfied: true,
    currentRevision: 1,
    lifecyclePhase: 'active'
};

test('bridge evaluates an allowed side effect without throwing', async () => {
    const gate = createActionGateRuntime({ env: { CALL_GATE_REQUIRED: 'true' } });
    const result = await gate.evaluate({ ...baseRequest, facts: baseFacts });
    assert.equal(result.allow, true);
    assert.equal(result.claim, 'prepared');
    assert.ok(result.ledger, 'verdict must carry the ledger so callers can markRunning/complete');
});

test('a second evaluation of the same actionId is denied as duplicate', async () => {
    const gate = createActionGateRuntime({ env: { CALL_GATE_REQUIRED: 'true' } });
    const first = await gate.evaluate({ ...baseRequest, facts: baseFacts });
    assert.equal(first.allow, true);
    const second = await gate.evaluate({ ...baseRequest, facts: baseFacts });
    assert.equal(second.allow, false);
    assert.match(second.reason, /^duplicate_action:/);
});

test('denial happens before the ledger claim — bad facts leave no residue', async () => {
    const gate = createActionGateRuntime({ env: { CALL_GATE_REQUIRED: 'true' } });
    const denied = await gate.evaluate({
        ...baseRequest,
        actionId: 'call-rt:handoff:denied',
        facts: { ...baseFacts, policyAllows: false }
    });
    assert.equal(denied.allow, false);
    assert.equal(denied.reason, 'policy_denied');
    // The same actionId under fixed facts must still be attemptable.
    const retry = await gate.evaluate({
        ...baseRequest,
        actionId: 'call-rt:handoff:denied',
        facts: baseFacts
    });
    assert.equal(retry.allow, true);
});

test('call_end and notification_send evaluate through the same bridge', async () => {
    const gate = createActionGateRuntime({ env: { CALL_GATE_REQUIRED: 'true' } });
    for (const kind of ['call_end', 'notification_send', 'context_write']) {
        const result = await gate.evaluate({
            actionId: `call-rt:${kind}:r1`,
            kind,
            targetRevision: 1,
            target: 'contract',
            facts: baseFacts
        });
        assert.equal(result.allow, true, `${kind} should be allowed`);
    }
});
