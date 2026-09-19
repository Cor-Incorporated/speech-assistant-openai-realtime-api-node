// Firestore-backed call repository — the SAME named database as the
// existing call log store. Collections:
//   callLogsV2/{callId}                      — record root (projection)
//   callLogsV2/{callId}/corrections/{id}     — versioned human corrections
//   callLogsV2/{callId}/events/{id}          — audit/operation events
//   adminIdempotency/{key}                   — create idempotency keys
// A separate root keeps v2 records distinct from the legacy callLogs
// collection the telephony writer still owns; a projection job can merge
// views later without a destructive migration now.

import { Firestore, type CollectionReference, type DocumentData } from '@google-cloud/firestore';
import type { CallCorrection, CallRecord } from './call-schemas.js';
import type { CallRepository, ListCallsFilter, ListCallsResult } from './call-repository.js';
import { CallNotFoundError, VersionConflictError } from './call-repository.js';

const SEVERITY_ORDER = ['low', 'normal', 'high', 'critical'] as const;

export interface FirestoreCallRepositoryOptions {
    firestore?: Firestore;
    projectId?: string;
    databaseId?: string;
    collection?: string;
    idempotencyCollection?: string;
}

export class FirestoreCallRepository implements CallRepository {
    private firestore: Firestore | null;
    private readonly projectId: string;
    private readonly databaseId: string;
    private readonly collectionName: string;
    private readonly idempotencyCollection: string;

    constructor(options: FirestoreCallRepositoryOptions = {}) {
        this.firestore = options.firestore ?? null;
        this.projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_PROJECT_ID ?? '';
        this.databaseId = options.databaseId ?? process.env.CALL_LOG_FIRESTORE_DATABASE_ID ?? '';
        this.collectionName = options.collection ?? 'callLogsV2';
        this.idempotencyCollection = options.idempotencyCollection ?? 'adminIdempotency';
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

    private calls(): CollectionReference<DocumentData> {
        return this.db().collection(this.collectionName);
    }

    private correctionsCol(callId: string): CollectionReference<DocumentData> {
        return this.calls().doc(callId).collection('corrections');
    }

    private eventsCol(callId: string): CollectionReference<DocumentData> {
        return this.calls().doc(callId).collection('events');
    }

    async get(callId: string): Promise<CallRecord | null> {
        const doc = await this.calls().doc(callId).get();
        return doc.exists ? (doc.data() as CallRecord) : null;
    }

    async createIfAbsent(record: CallRecord): Promise<{ created: boolean; record: CallRecord }> {
        const ref = this.calls().doc(record.callId);
        return this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (doc.exists) return { created: false, record: doc.data() as CallRecord };
            tx.create(ref, record);
            return { created: true, record };
        });
    }

    async put(record: CallRecord, expectedVersion?: number): Promise<CallRecord> {
        const ref = this.calls().doc(record.callId);
        await this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (expectedVersion !== undefined && (doc.data()?.recordVersion ?? 0) !== expectedVersion) {
                throw new VersionConflictError(`call ${record.callId}: expected ${expectedVersion}`);
            }
            tx.set(ref, record);
        });
        return record;
    }

    async list(filter: ListCallsFilter = {}): Promise<ListCallsResult> {
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
        const snapshot = await this.calls().orderBy('startedAt', 'desc').limit(500).get();
        let items = snapshot.docs.map((doc) => doc.data() as CallRecord);
        if (!filter.includeDeleted) items = items.filter((r) => !r.deletedAt);
        if (filter.businessState) items = items.filter((r) => r.ops.status === filter.businessState);
        if (filter.origin) items = items.filter((r) => r.origin === filter.origin);
        if (filter.severityMin) {
            const min = SEVERITY_ORDER.indexOf(filter.severityMin);
            items = items.filter((r) => {
                const idx = SEVERITY_ORDER.indexOf(r.severity.importance as typeof SEVERITY_ORDER[number]);
                return idx >= min;
            });
        }
        const startIndex = filter.cursor ? items.findIndex((r) => r.callId === filter.cursor) + 1 : 0;
        const start = startIndex > 0 ? startIndex : filter.cursor ? items.length : 0;
        const page = items.slice(start, start + limit);
        const truncated = snapshot.docs.length === 500;
        const hasMore = start + limit < items.length || truncated;
        return {
            items: page,
            nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.callId : null,
            hasMore,
            partial: hasMore || truncated
        };
    }

    async addCorrection(correction: CallCorrection): Promise<CallCorrection> {
        const ref = this.correctionsCol(correction.callId).doc(correction.correctionId);
        await ref.create(correction).catch((error: unknown) => {
            if ((error as { code?: number }).code === 6) {
                throw new VersionConflictError(`correction ${correction.correctionId} already exists`);
            }
            throw error;
        });
        return correction;
    }

    async getCorrection(callId: string, correctionId: string): Promise<CallCorrection | null> {
        const doc = await this.correctionsCol(callId).doc(correctionId).get();
        return doc.exists ? (doc.data() as CallCorrection) : null;
    }

    async updateCorrectionFlags(correction: CallCorrection): Promise<CallCorrection> {
        const ref = this.correctionsCol(correction.callId).doc(correction.correctionId);
        return this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (!doc.exists) throw new CallNotFoundError(correction.callId);
            tx.update(ref, { active: correction.active, supersededBy: correction.supersededBy });
            return { ...correction };
        });
    }

    async listCorrections(callId: string): Promise<CallCorrection[]> {
        const snapshot = await this.correctionsCol(callId).orderBy('createdAt').get();
        return snapshot.docs.map((doc) => doc.data() as CallCorrection);
    }

    async appendEvent(event: {
        eventId: string;
        callId: string | null;
        actor: string;
        action: string;
        result: string;
        metadata?: Record<string, unknown>;
        timestamp: string;
    }): Promise<void> {
        const target = event.callId
            ? this.eventsCol(event.callId).doc(event.eventId)
            : this.db().collection('adminAuditEvents').doc(event.eventId);
        await target.create(event);
    }

    async listEvents(callId: string): Promise<Array<Record<string, unknown>>> {
        const snapshot = await this.eventsCol(callId).orderBy('timestamp').limit(200).get();
        return snapshot.docs.map((doc) => doc.data() as Record<string, unknown>);
    }

    async getIdempotency(key: string): Promise<{ callId: string; bodyHash: string } | null> {
        const doc = await this.db().collection(this.idempotencyCollection).doc(key).get();
        return doc.exists ? (doc.data() as { callId: string; bodyHash: string }) : null;
    }

    async putIdempotency(key: string, callId: string, bodyHash: string): Promise<void> {
        await this.db().collection(this.idempotencyCollection).doc(key).set({ callId, bodyHash });
    }
}
