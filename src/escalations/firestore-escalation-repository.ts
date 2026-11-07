// Firestore-backed escalation repository. Escalations are durable — a
// restart must never lose an unacknowledged critical case.
//
//   escalationCases/{caseId}
//   escalationCases/{caseId}/events/{eventId}

import { Firestore, type CollectionReference, type DocumentData } from '@google-cloud/firestore';
import { escalationMatchesFilter, escalationPageScope, type EscalationCase, type EscalationRepository, type EscalationListFilter } from './escalation-service.js';
import { VersionConflictError } from '../knowledge/repository.js';
import { firestoreRecordPage } from '../pagination/record-page.js';

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

    async list(filter: EscalationListFilter = {}) {
        return firestoreRecordPage<EscalationCase>(this.cases(), {
            ...filter,
            scope: escalationPageScope(filter),
            orderField: 'createdAt',
            include: (record) => escalationMatchesFilter(record, filter)
        });
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
