import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ActionLedger,
    InMemoryLedgerStore
} from '../dist-backend/infrastructure/action-ledger.js';
import { evaluateAction } from '../dist-backend/domain/action-gate.js';

const facts = {
    schemaOk: true,
    allowedKinds: ['handoff_start'],
    allowedTargets: ['general'],
    policyAllows: true,
    confirmationSatisfied: true,
    currentRevision: 3,
    callLifecycle: 'active'
};

const request = {
    actionId: 'call-1:handoff:rev3',
    kind: 'handoff_start',
    targetRevision: 3,
    target: 'general'
};

test('two workers claiming the same business action → one runs (FAULT-008)', async () => {
    // A shared store simulates two app instances racing on one action ID.
    const store = new InMemoryLedgerStore();
    const ledgerA = new ActionLedger(store);
    const ledgerB = new ActionLedger(store);

    const [verdictA, verdictB] = await Promise.all([
        evaluateAction(request, facts, ledgerA),
        evaluateAction(request, facts, ledgerB)
    ]);

    const allowed = [verdictA, verdictB].filter((verdict) => verdict.allow);
    const denied = [verdictA, verdictB].filter((verdict) => !verdict.allow);
    assert.equal(allowed.length, 1);
    assert.equal(denied.length, 1);
    assert.match(denied[0].reason, /duplicate_action/);
});

test('a completed action is never re-executed on event resend', async () => {
    const ledger = new ActionLedger(new InMemoryLedgerStore());

    const first = await evaluateAction(request, facts, ledger);
    assert.equal(first.allow, true);
    await ledger.markRunning(request.actionId);
    await ledger.complete(request.actionId, 'succeeded');

    const resent = await evaluateAction(request, facts, ledger);
    assert.equal(resent.allow, false);
    assert.match(resent.reason, /duplicate_action:already_succeeded/);
});

test('outcome_unknown requires reconcile before any retry (FAULT-009)', async () => {
    const ledger = new ActionLedger(new InMemoryLedgerStore());

    await evaluateAction(request, facts, ledger);
    await ledger.markRunning(request.actionId);
    // Timeout before the external ack — the real-world result is unknown.
    await ledger.complete(request.actionId, 'outcome_unknown');

    const blindRetry = await evaluateAction(request, facts, ledger);
    assert.equal(blindRetry.allow, false);
    assert.match(blindRetry.reason, /outcome_unknown_requires_reconcile/);

    // After reconciling against the real world the action may complete.
    await ledger.reconcile(request.actionId, 'succeeded');
    const afterReconcile = await evaluateAction(request, facts, ledger);
    assert.equal(afterReconcile.allow, false);
    assert.match(afterReconcile.reason, /already_succeeded/);
});

test('a failed action may be retried deliberately', async () => {
    const ledger = new ActionLedger(new InMemoryLedgerStore());

    await evaluateAction(request, facts, ledger);
    await ledger.markRunning(request.actionId);
    await ledger.complete(request.actionId, 'failed');

    const retry = await evaluateAction(request, facts, ledger);
    // The prepare claim already exists — retry is a fresh decision the caller
    // takes via canAttempt, not an automatic re-execution.
    assert.equal(retry.allow, false);
    assert.match(retry.reason, /claimed_elsewhere|already_in_flight|duplicate/);

    const attempt = await ledger.canAttempt(request.actionId);
    assert.equal(attempt.attemptable, true);
    assert.equal(attempt.reason, 'retry_after_failure');
});

test('stale revision is rejected before the ledger is even consulted', async () => {
    const ledger = new ActionLedger(new InMemoryLedgerStore());
    const verdict = await evaluateAction(
        { ...request, targetRevision: 2 },
        facts,
        ledger
    );
    assert.equal(verdict.allow, false);
    assert.equal(verdict.reason, 'stale_revision');
    assert.equal(await ledger.get(request.actionId), null);
});

test('ended or transferred calls accept no new actions', async () => {
    const ledger = new ActionLedger(new InMemoryLedgerStore());
    for (const callLifecycle of ['ended', 'transferred']) {
        const verdict = await evaluateAction(
            request,
            { ...facts, callLifecycle },
            ledger
        );
        assert.equal(verdict.allow, false);
        assert.equal(verdict.reason, 'call_not_active');
    }
});

test('schema, policy and confirmation failures are rejected in order', async () => {
    const ledger = new ActionLedger(new InMemoryLedgerStore());

    assert.equal(
        (await evaluateAction(request, { ...facts, schemaOk: false }, ledger)).reason,
        'schema_invalid'
    );
    assert.equal(
        (await evaluateAction(request, { ...facts, policyAllows: false }, ledger)).reason,
        'policy_denied'
    );
    assert.equal(
        (await evaluateAction(request, { ...facts, confirmationSatisfied: false }, ledger)).reason,
        'confirmation_missing'
    );
    assert.equal(
        (await evaluateAction(
            { ...request, target: 'unlisted' },
            { ...facts, allowedTargets: ['general'] },
            ledger
        )).reason,
        'action_target_not_allowed'
    );
});
