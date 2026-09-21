// Durable action ledger for side-effect idempotency.
// The provider's event/call IDs and the business action's idempotency key are
// different things: the same business action may arrive under two provider
// IDs after a resend or reconnect, and must execute once.

import { Firestore, type CollectionReference, type DocumentData } from '@google-cloud/firestore';

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

/**
 * Firestore-backed store — the same named database as the call log writers.
 * `insertIfAbsent` runs inside a transaction so two Cloud Run instances
 * racing on the same business action produce exactly one 'prepared' winner;
 * the loser reads back the winner's record as 'duplicate'.
 */
export class FirestoreLedgerStore implements ActionLedgerStore {
    private firestore: Firestore | null;
    private readonly projectId: string | undefined;
    private readonly databaseId: string | undefined;
    private readonly collectionName: string;

    constructor(options: { firestore?: Firestore; projectId?: string; databaseId?: string; collection?: string } = {}) {
        this.firestore = options.firestore ?? null;
        this.projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_PROJECT_ID;
        this.databaseId = options.databaseId ?? process.env.CALL_LOG_FIRESTORE_DATABASE_ID;
        this.collectionName = options.collection ?? 'actionLedger';
    }

    private db(): Firestore {
        if (!this.firestore) {
            const settings: { projectId?: string; databaseId?: string } = {};
            if (this.projectId) settings.projectId = this.projectId;
            if (this.databaseId) settings.databaseId = this.databaseId;
            this.firestore = new Firestore(settings);
        }
        return this.firestore;
    }

    private col(): CollectionReference<DocumentData> {
        return this.db().collection(this.collectionName);
    }

    async get(actionId: string): Promise<ActionRecord | null> {
        const snap = await this.col().doc(actionId).get();
        return snap.exists ? (snap.data() as ActionRecord) : null;
    }

    async insertIfAbsent(
        record: ActionRecord
    ): Promise<{ inserted: boolean; record: ActionRecord }> {
        const ref = this.col().doc(record.actionId);
        return this.db().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists) {
                return { inserted: false, record: snap.data() as ActionRecord };
            }
            tx.set(ref, record);
            return { inserted: true, record };
        });
    }

    async update(actionId: string, patch: Partial<ActionRecord>): Promise<ActionRecord | null> {
        const ref = this.col().doc(actionId);
        return this.db().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return null;
            const updated = { ...(snap.data() as ActionRecord), ...patch, actionId };
            tx.set(ref, updated);
            return updated;
        });
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
