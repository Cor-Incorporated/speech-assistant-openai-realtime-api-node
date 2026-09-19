// Firestore-backed escalation repository. Escalations are durable — a
// restart must never lose an unacknowledged critical case.
//
//   escalationCases/{caseId}
//   escalationCases/{caseId}/events/{eventId}

import { Firestore, type CollectionReference, type DocumentData } from '@google-cloud/firestore';
import type { EscalationCase, EscalationRepository, EscalationState } from './escalation-service.js';
import { VersionConflictError } from '../knowledge/repository.js';

export interface FirestoreEscalationRepositoryOptions {
    firestore?: Firestore;
    projectId?: string;
    databaseId?: string;
    collection?: string;
}

export class FirestoreEscalationRepository implements EscalationRepository {
    private firestore: Firestore | null;
    private readonly projectId: string;
    private readonly databaseId: string;
    private readonly collectionName: string;

    constructor(options: FirestoreEscalationRepositoryOptions = {}) {
        this.firestore = options.firestore ?? null;
        this.projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_PROJECT_ID ?? '';
        this.databaseId = options.databaseId ?? process.env.CALL_LOG_FIRESTORE_DATABASE_ID ?? '';
        this.collectionName = options.collection ?? 'escalationCases';
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

    private cases(): CollectionReference<DocumentData> {
        return this.db().collection(this.collectionName);
    }

    async get(caseId: string): Promise<EscalationCase | null> {
        const doc = await this.cases().doc(caseId).get();
        return doc.exists ? (doc.data() as EscalationCase) : null;
    }

    async createIfAbsent(record: EscalationCase): Promise<{ created: boolean; record: EscalationCase }> {
        const ref = this.cases().doc(record.caseId);
        return this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (doc.exists) return { created: false, record: doc.data() as EscalationCase };
            tx.create(ref, record);
            return { created: true, record };
        });
    }

    async put(record: EscalationCase, expectedVersion?: number): Promise<EscalationCase> {
        const ref = this.cases().doc(record.caseId);
        await this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (expectedVersion !== undefined && (doc.data()?.recordVersion ?? 0) !== expectedVersion) {
                throw new VersionConflictError(`escalation ${record.caseId}: expected ${expectedVersion}`);
            }
            tx.set(ref, record);
        });
        return record;
    }

    async list(filter: { state?: EscalationState; unacknowledgedOnly?: boolean; limit?: number; cursor?: string } = {}) {
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
        const snapshot = await this.cases().orderBy('createdAt', 'desc').limit(500).get();
        let items = snapshot.docs.map((doc) => doc.data() as EscalationCase);
        if (filter.state) items = items.filter((c) => c.state === filter.state);
        if (filter.unacknowledgedOnly) {
            items = items.filter((c) => c.state !== 'acknowledged' && c.state !== 'resolved' && c.state !== 'connected');
        }
        items.sort((a, b) => {
            const aScore = (a.state === 'acknowledged' || a.state === 'resolved' ? 1 : 0);
            const bScore = (b.state === 'acknowledged' || b.state === 'resolved' ? 1 : 0);
            return aScore - bScore || b.createdAt.localeCompare(a.createdAt);
        });
        const startIndex = filter.cursor ? items.findIndex((c) => c.caseId === filter.cursor) + 1 : 0;
        const start = startIndex > 0 ? startIndex : filter.cursor ? items.length : 0;
        const page = items.slice(start, start + limit);
        const hasMore = start + limit < items.length || snapshot.docs.length === 500;
        return {
            items: page,
            nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.caseId : null,
            hasMore
        };
    }

    async appendEvent(event: {
        eventId: string;
        caseId: string;
        actor: string;
        action: string;
        result: string;
        metadata?: Record<string, unknown>;
        timestamp: string;
    }): Promise<void> {
        await this.cases().doc(event.caseId).collection('events').doc(event.eventId).create(event);
    }
}
