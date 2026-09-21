// Runtime bridge to the shared ActionGate/ActionLedger (src/domain,
// src/infrastructure). Every Twilio REST side effect on the call path —
// hangup completion and transfer TwiML updates — must pass through this
// boundary so revision, lifecycle, policy and idempotency checks happen in
// one place rather than beside each call site.
//
// The compiled TypeScript layer is loaded lazily via dynamic import (same
// pattern as lib/jev-shadow.js) so index.js still starts when dist-backend
// has not been built. When the gate cannot load and CALL_GATE_REQUIRED=true
// (default), side effects are DENIED — an unguarded action is worse than a
// blocked one. Set CALL_GATE_REQUIRED=false only for local development.

const toGateLifecycle = (phase) => {
    switch (phase) {
        case 'handoff': return 'transferred';
        case 'closing': return 'closing';
        case 'closed': return 'ended';
        default: return 'active'; // starting | active
    }
};

export function createActionGateRuntime({ env = process.env, logger = console } = {}) {
    const required = (env.CALL_GATE_REQUIRED ?? 'true') !== 'false';
    let loading = null;
    let warned = false;

    const load = () => {
        loading ??= Promise.all([
            import('../dist-backend/domain/action-gate.js'),
            import('../dist-backend/infrastructure/action-ledger.js')
        ]).then(([gateModule, ledgerModule]) => {
            // REVIEW-R03: the ledger must be durable in production — an
            // in-process Map loses the idempotency claim on restart and
            // cannot be shared between Cloud Run instances.
            const store = env.CALL_LOG_FIRESTORE_ENABLED === 'true'
                ? new ledgerModule.FirestoreLedgerStore()
                : new ledgerModule.InMemoryLedgerStore();
            return {
                evaluateAction: gateModule.evaluateAction,
                ledger: new ledgerModule.ActionLedger(store)
            };
        }).catch((error) => {
            if (!warned) {
                warned = true;
                logger.warn(
                    `ActionGate unavailable (${error?.message || error}); ` +
                    `${required ? 'side effects will be denied' : 'side effects run ungated (CALL_GATE_REQUIRED=false)'}`
                );
            }
            return null;
        });
        return loading;
    };

    /**
     * Evaluate a side effect against the gate. Returns {allow, reason, claim}.
     * The caller is responsible for ledger.markRunning / ledger.complete.
     */
    const evaluate = async ({ actionId, kind, targetRevision, target, facts }) => {
        const loaded = await load();
        if (!loaded) {
            return required
                ? { allow: false, reason: 'gate_unavailable' }
                : { allow: true, actionId, claim: 'ungated' };
        }
        const verdict = await loaded.evaluateAction(
            { actionId, kind, targetRevision, target },
            {
                schemaOk: facts.schemaOk !== false,
                allowedKinds: facts.allowedKinds,
                allowedTargets: facts.allowedTargets,
                policyAllows: facts.policyAllows === true,
                confirmationSatisfied: facts.confirmationSatisfied !== false,
                currentRevision: facts.currentRevision,
                callLifecycle: toGateLifecycle(facts.lifecyclePhase)
            },
            loaded.ledger
        );
        return { ...verdict, ledger: loaded.ledger };
    };

    // Warm the module cache at startup so a missing build surfaces in boot
    // logs, not during the first live call.
    void load();

    return { evaluate };
}
