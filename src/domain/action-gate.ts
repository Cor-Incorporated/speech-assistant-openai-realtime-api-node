// ActionGate — the single checkpoint every side-effecting operation passes.
// Checks (per design):
//   1. arguments passed runtime schema validation;
//   2. the action kind and target are allowed;
//   3. business policy and required caller confirmations are satisfied;
//   4. the decision is on the current call/revision and the call is live;
//   5. the same business action has not already run (ledger).

import type { ActionLedger } from '../infrastructure/action-ledger.js';

export type ActionKind = 'handoff_start' | 'call_end' | 'notification_send' | 'context_write';

export interface ActionRequest {
    /** Stable business idempotency key — never the provider's event ID. */
    actionId: string;
    kind: ActionKind;
    /** Context/slot revision the action was decided on. */
    targetRevision: number;
    /** e.g. handoff destination, validated upstream. */
    target: string;
}

export type CallLifecycle = 'active' | 'closing' | 'ended' | 'transferred';

export interface GateFacts {
    schemaOk: boolean;
    allowedKinds: readonly ActionKind[];
    allowedTargets: readonly string[];
    policyAllows: boolean;
    confirmationSatisfied: boolean;
    currentRevision: number;
    callLifecycle: CallLifecycle;
}

export type GateVerdict =
    | { allow: true; actionId: string }
    | { allow: false; reason: string };

/**
 * Synchronous part of the gate — facts the caller already knows.
 * The ledger check is async and handled by `evaluateAction`.
 */
export function checkSyncFacts(request: ActionRequest, facts: GateFacts): GateVerdict {
    if (!facts.schemaOk) {
        return { allow: false, reason: 'schema_invalid' };
    }
    if (!facts.allowedKinds.includes(request.kind)) {
        return { allow: false, reason: 'action_kind_not_allowed' };
    }
    if (!facts.allowedTargets.includes(request.target)) {
        return { allow: false, reason: 'action_target_not_allowed' };
    }
    if (!facts.policyAllows) {
        return { allow: false, reason: 'policy_denied' };
    }
    if (!facts.confirmationSatisfied) {
        return { allow: false, reason: 'confirmation_missing' };
    }
    if (facts.callLifecycle === 'ended' || facts.callLifecycle === 'transferred') {
        return { allow: false, reason: 'call_not_active' };
    }
    if (request.targetRevision !== facts.currentRevision) {
        return { allow: false, reason: 'stale_revision' };
    }
    return { allow: true, actionId: request.actionId };
}

/**
 * Full gate evaluation including the durable ledger claim. The caller should
 * only execute the side effect when the verdict is `allow` AND `claim` is
 * 'prepared' (this worker won the idempotency claim).
 */
export async function evaluateAction(
    request: ActionRequest,
    facts: GateFacts,
    ledger: ActionLedger
): Promise<GateVerdict & { claim?: 'prepared' | 'duplicate' }> {
    const sync = checkSyncFacts(request, facts);
    if (!sync.allow) return sync;

    const attempt = await ledger.canAttempt(request.actionId);
    if (!attempt.attemptable) {
        return { allow: false, reason: `duplicate_action:${attempt.reason}` };
    }

    const prepared = await ledger.prepare(request.actionId, request.kind, request.targetRevision);
    if (prepared.status === 'duplicate') {
        return { allow: false, reason: 'duplicate_action:claimed_elsewhere' };
    }

    return { allow: true, actionId: request.actionId, claim: 'prepared' };
}
