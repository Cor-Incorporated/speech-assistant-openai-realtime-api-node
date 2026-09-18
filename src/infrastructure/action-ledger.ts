// Durable action ledger for side-effect idempotency.
// The provider's event/call IDs and the business action's idempotency key are
// different things: the same business action may arrive under two provider
// IDs after a resend or reconnect, and must execute once.

export type ActionStatus = 'prepared' | 'running' | 'succeeded' | 'failed' | 'outcome_unknown';

export interface ActionRecord {
    /** Stable business key: callId + actionKind + slot/context revision. */
    actionId: string;
    kind: string;
    targetRevision: number;
    status: ActionStatus;
    attempts: number;
    createdAt: string;
    updatedAt: string;
    resultSummary?: string;
}

export interface ActionLedgerStore {
    get(actionId: string): Promise<ActionRecord | null>;
    /** Insert only when absent. Returns the winner's record either way. */
    insertIfAbsent(record: ActionRecord): Promise<{ inserted: boolean; record: ActionRecord }>;
    update(actionId: string, patch: Partial<ActionRecord>): Promise<ActionRecord | null>;
}

/**
 * In-memory store for local development and tests. A single Map can be shared
 * between two ledger instances to simulate two workers racing on the same
 * business action. Production should inject a Firestore/DB-backed store —
 * an in-process Set is not a completion guarantee across instances.
 */
export class InMemoryLedgerStore implements ActionLedgerStore {
    private readonly records = new Map<string, ActionRecord>();

    async get(actionId: string): Promise<ActionRecord | null> {
        const record = this.records.get(actionId);
        return record ? { ...record } : null;
    }

    async insertIfAbsent(
        record: ActionRecord
    ): Promise<{ inserted: boolean; record: ActionRecord }> {
        const existing = this.records.get(record.actionId);
        if (existing) {
            return { inserted: false, record: { ...existing } };
        }
        this.records.set(record.actionId, { ...record });
        return { inserted: true, record: { ...record } };
    }

    async update(actionId: string, patch: Partial<ActionRecord>): Promise<ActionRecord | null> {
        const existing = this.records.get(actionId);
        if (!existing) return null;
        const updated = { ...existing, ...patch, actionId };
        this.records.set(actionId, updated);
        return { ...updated };
    }
}

export type PrepareOutcome =
    | { status: 'prepared'; record: ActionRecord }
    | { status: 'duplicate'; record: ActionRecord };

/**
 * Ledger facade used by ActionGate. All side-effecting operations must go
 * through here — never directly from a voice/tool event handler.
 */
export class ActionLedger {
    constructor(private readonly store: ActionLedgerStore, private readonly now: () => string = () => new Date().toISOString()) {}

    async get(actionId: string): Promise<ActionRecord | null> {
        return this.store.get(actionId);
    }

    /**
     * Claim the right to run an action. Only the worker that inserts the
     * record may proceed; everyone else sees 'duplicate'.
     */
    async prepare(actionId: string, kind: string, targetRevision: number): Promise<PrepareOutcome> {
        const now = this.now();
        const { inserted, record } = await this.store.insertIfAbsent({
            actionId,
            kind,
            targetRevision,
            status: 'prepared',
            attempts: 0,
            createdAt: now,
            updatedAt: now
        });
        return { status: inserted ? 'prepared' : 'duplicate', record };
    }

    async markRunning(actionId: string): Promise<ActionRecord | null> {
        const current = await this.store.get(actionId);
        if (!current) return null;
        return this.store.update(actionId, {
            status: 'running',
            attempts: current.attempts + 1,
            updatedAt: this.now()
        });
    }

    async complete(
        actionId: string,
        outcome: 'succeeded' | 'failed' | 'outcome_unknown',
        resultSummary = ''
    ): Promise<ActionRecord | null> {
        return this.store.update(actionId, {
            status: outcome,
            resultSummary,
            updatedAt: this.now()
        });
    }

    /**
     * An outcome_unknown action must be reconciled against the real world
     * before any retry — a blind retry can double-execute the side effect.
     */
    async reconcile(
        actionId: string,
        finalStatus: 'succeeded' | 'failed'
    ): Promise<ActionRecord | null> {
        const current = await this.store.get(actionId);
        if (!current || current.status !== 'outcome_unknown') return current;
        return this.store.update(actionId, { status: finalStatus, updatedAt: this.now() });
    }

    /** May this action run now? Running/unknown/duplicate states block. */
    async canAttempt(actionId: string): Promise<{ attemptable: boolean; reason: string }> {
        const record = await this.store.get(actionId);
        if (!record) return { attemptable: true, reason: 'new' };
        switch (record.status) {
            case 'prepared':
            case 'running':
                return { attemptable: false, reason: 'already_in_flight' };
            case 'succeeded':
                return { attemptable: false, reason: 'already_succeeded' };
            case 'outcome_unknown':
                return { attemptable: false, reason: 'outcome_unknown_requires_reconcile' };
            case 'failed':
                return { attemptable: true, reason: 'retry_after_failure' };
        }
    }
}
