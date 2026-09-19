// Firestore-backed knowledge repository.
// Uses the SAME named database the call log already uses — configuration
// comes from the existing env vars, never a new project or database.
//
// Collections (root names are configurable):
//   corKnowledgeSources/{sourceId}
//   corKnowledge/{knowledgeId}
//   corKnowledge/{knowledgeId}/revisions/{revisionId}
//   corKnowledgeReviews/{reviewId}
//   corKnowledgeReleases/{releaseId}
//   corKnowledgeReleases/{releaseId}/items/{knowledgeId}
//   runtimeSettings/knowledge
//   adminAuditEvents/{eventId}

import { Firestore, type CollectionReference, type DocumentData } from '@google-cloud/firestore';
import type {
    KnowledgeRecord,
    KnowledgeRelease,
    KnowledgeReview,
    KnowledgeRevision,
    KnowledgeRuntimeSettings,
    PublishedKnowledgeItem,
    SourceRecord
} from './schemas.js';
import { KNOWLEDGE_SCHEMA_VERSION } from './schemas.js';
import type {
    KnowledgeRepository,
    ListKnowledgeFilter,
    ListResult
} from './repository.js';
import { NotFoundError, VersionConflictError } from './repository.js';

const RUNTIME_SETTINGS_DOC = 'knowledge';
const DEFAULT_RUNTIME_SETTINGS: KnowledgeRuntimeSettings = {
    currentReleaseId: null,
    revocationEpoch: 0,
    revokedKnowledgeIds: [],
    updatedAt: '1970-01-01T00:00:00.000Z'
};

export interface FirestoreKnowledgeRepositoryOptions {
    firestore?: Firestore;
    projectId?: string;
    databaseId?: string;
    /** Root collection names — configurable, never hardcoded into callers. */
    collections?: Partial<{
        sources: string;
        knowledge: string;
        reviews: string;
        releases: string;
        policies: string;
        runtimeSettings: string;
        auditEvents: string;
    }>;
}

export class FirestoreKnowledgeRepository implements KnowledgeRepository {
    private readonly collections: Required<NonNullable<FirestoreKnowledgeRepositoryOptions['collections']>>;
    private firestore: Firestore | null;

    constructor(options: FirestoreKnowledgeRepositoryOptions = {}) {
        this.firestore = options.firestore ?? null;
        this.projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_PROJECT_ID ?? '';
        this.databaseId = options.databaseId ?? process.env.CALL_LOG_FIRESTORE_DATABASE_ID ?? '';
        this.collections = {
            sources: 'corKnowledgeSources',
            knowledge: 'corKnowledge',
            reviews: 'corKnowledgeReviews',
            releases: 'corKnowledgeReleases',
            policies: 'receptionPolicies',
            runtimeSettings: 'runtimeSettings',
            auditEvents: 'adminAuditEvents',
            ...options.collections
        };
    }

    private readonly projectId: string;
    private readonly databaseId: string;

    private db(): Firestore {
        if (!this.firestore) {
            const settings: { projectId?: string; databaseId?: string } = {};
            if (this.projectId) settings.projectId = this.projectId;
            if (this.databaseId) settings.databaseId = this.databaseId;
            this.firestore = new Firestore(settings);
        }
        return this.firestore;
    }

    private sources(): CollectionReference<DocumentData> {
        return this.db().collection(this.collections.sources);
    }

    private knowledge(): CollectionReference<DocumentData> {
        return this.db().collection(this.collections.knowledge);
    }

    private revisionsCol(knowledgeId: string): CollectionReference<DocumentData> {
        return this.knowledge().doc(knowledgeId).collection('revisions');
    }

    private reviews(): CollectionReference<DocumentData> {
        return this.db().collection(this.collections.reviews);
    }

    private policies(): CollectionReference<DocumentData> {
        return this.db().collection(this.collections.policies);
    }

    private releases(): CollectionReference<DocumentData> {
        return this.db().collection(this.collections.releases);
    }

    private releaseItemsCol(releaseId: string): CollectionReference<DocumentData> {
        return this.releases().doc(releaseId).collection('items');
    }

    // ------------------------------------------------------------------
    // sources
    // ------------------------------------------------------------------

    async getSource(sourceId: string): Promise<SourceRecord | null> {
        const doc = await this.sources().doc(sourceId).get();
        return doc.exists ? (doc.data() as SourceRecord) : null;
    }

    async putSource(record: SourceRecord, expectedVersion?: number): Promise<SourceRecord> {
        const ref = this.sources().doc(record.sourceId);
        await this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (expectedVersion !== undefined && (doc.data()?.recordVersion ?? 0) !== expectedVersion) {
                throw new VersionConflictError(`source ${record.sourceId}: expected ${expectedVersion}`);
            }
            tx.set(ref, record);
        });
        return record;
    }

    async listSources(options: { includeDeleted?: boolean } = {}): Promise<SourceRecord[]> {
        const snapshot = await this.sources().orderBy('sourceId').get();
        return snapshot.docs
            .map((doc) => doc.data() as SourceRecord)
            .filter((s) => options.includeDeleted || !s.deletedAt);
    }

    // ------------------------------------------------------------------
    // knowledge root
    // ------------------------------------------------------------------

    async getKnowledge(knowledgeId: string): Promise<KnowledgeRecord | null> {
        const doc = await this.knowledge().doc(knowledgeId).get();
        return doc.exists ? (doc.data() as KnowledgeRecord) : null;
    }

    async getKnowledgeByKey(key: string): Promise<KnowledgeRecord | null> {
        const snapshot = await this.knowledge().where('key', '==', key).limit(2).get();
        for (const doc of snapshot.docs) {
            const record = doc.data() as KnowledgeRecord;
            if (!record.deletedAt) return record;
        }
        return snapshot.docs.length > 0 ? (snapshot.docs[0]!.data() as KnowledgeRecord) : null;
    }

    async putKnowledge(record: KnowledgeRecord, expectedVersion?: number): Promise<KnowledgeRecord> {
        const ref = this.knowledge().doc(record.knowledgeId);
        await this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (expectedVersion !== undefined && (doc.data()?.recordVersion ?? 0) !== expectedVersion) {
                throw new VersionConflictError(
                    `knowledge ${record.knowledgeId}: expected ${expectedVersion}, found ${doc.data()?.recordVersion ?? 'none'}`
                );
            }
            tx.set(ref, record);
        });
        return record;
    }

    async createKnowledgeIfAbsent(
        record: KnowledgeRecord
    ): Promise<{ created: boolean; record: KnowledgeRecord }> {
        const ref = this.knowledge().doc(record.knowledgeId);
        return this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (doc.exists) {
                return { created: false, record: doc.data() as KnowledgeRecord };
            }
            tx.create(ref, record);
            return { created: true, record };
        });
    }

    async listKnowledge(filter: ListKnowledgeFilter = {}): Promise<ListResult<KnowledgeRecord>> {
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
        let query = this.knowledge().orderBy('knowledgeId');
        // deletedAt filtering: records without the field sort last on null —
        // for a small corpus we fetch the page window then filter locally,
        // reporting hasMore honestly rather than pretending a full count.
        const snapshot = await query.limit(500).get();
        let items = snapshot.docs.map((doc) => doc.data() as KnowledgeRecord);
        if (!filter.includeDeleted) items = items.filter((r) => !r.deletedAt);
        if (filter.state) items = items.filter((r) => r.state === filter.state);
        if (filter.category) items = items.filter((r) => r.category === filter.category);

        const startIndex = filter.cursor
            ? items.findIndex((r) => r.knowledgeId === filter.cursor) + 1
            : 0;
        const start = startIndex > 0 ? startIndex : filter.cursor ? items.length : 0;
        const page = items.slice(start, start + limit);
        const truncated = snapshot.docs.length === 500;
        const hasMore = start + limit < items.length || truncated;
        return {
            items: page,
            nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.knowledgeId : null,
            hasMore
        };
    }

    // ------------------------------------------------------------------
    // revisions
    // ------------------------------------------------------------------

    async getRevision(knowledgeId: string, revision: number): Promise<KnowledgeRevision | null> {
        const doc = await this.revisionsCol(knowledgeId).doc(String(revision)).get();
        return doc.exists ? (doc.data() as KnowledgeRevision) : null;
    }

    async putRevision(knowledgeId: string, revision: KnowledgeRevision): Promise<KnowledgeRevision> {
        const ref = this.revisionsCol(knowledgeId).doc(String(revision.revision));
        await ref.create(revision).catch((error: unknown) => {
            if ((error as { code?: number }).code === 6 /* ALREADY_EXISTS */) {
                throw new VersionConflictError(`revision ${revision.revision} of ${knowledgeId} already exists`);
            }
            throw error;
        });
        return revision;
    }

    async updateRevisionApproval(knowledgeId: string, revision: KnowledgeRevision): Promise<KnowledgeRevision> {
        const ref = this.revisionsCol(knowledgeId).doc(String(revision.revision));
        return this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (!doc.exists) throw new NotFoundError(`revision ${revision.revision} of ${knowledgeId} not found`);
            const stored = doc.data() as KnowledgeRevision;
            if (stored.contentHash !== revision.contentHash) {
                throw new VersionConflictError(`revision ${revision.revision}: content hash mismatch`);
            }
            tx.update(ref, { approval: revision.approval });
            return { ...stored, approval: revision.approval };
        });
    }

    async listRevisions(knowledgeId: string): Promise<KnowledgeRevision[]> {
        const snapshot = await this.revisionsCol(knowledgeId).orderBy('revision').get();
        return snapshot.docs.map((doc) => doc.data() as KnowledgeRevision);
    }

    // ------------------------------------------------------------------
    // releases — manifest + items write atomically; never updated in place
    // ------------------------------------------------------------------

    async createRelease(release: KnowledgeRelease, items: PublishedKnowledgeItem[]): Promise<void> {
        const ref = this.releases().doc(release.releaseId);
        await this.db().runTransaction(async (tx) => {
            const existing = await tx.get(ref);
            if (existing.exists) {
                throw new VersionConflictError(`release ${release.releaseId} already exists`);
            }
            tx.create(ref, release);
            for (const item of items) {
                tx.create(this.releaseItemsCol(release.releaseId).doc(item.knowledgeId), item);
            }
        });
    }

    async getRelease(releaseId: string): Promise<KnowledgeRelease | null> {
        const doc = await this.releases().doc(releaseId).get();
        return doc.exists ? (doc.data() as KnowledgeRelease) : null;
    }

    async getReleaseItems(releaseId: string): Promise<PublishedKnowledgeItem[]> {
        const snapshot = await this.releaseItemsCol(releaseId).orderBy('knowledgeId').get();
        return snapshot.docs.map((doc) => doc.data() as PublishedKnowledgeItem);
    }

    async listReleases(limit = 20): Promise<KnowledgeRelease[]> {
        const snapshot = await this.releases().orderBy('createdAt', 'desc').limit(limit).get();
        return snapshot.docs.map((doc) => doc.data() as KnowledgeRelease);
    }

    // ------------------------------------------------------------------
    // runtime settings — CAS via transaction
    // ------------------------------------------------------------------

    async getRuntimeSettings(): Promise<KnowledgeRuntimeSettings> {
        const doc = await this.db().collection(this.collections.runtimeSettings).doc(RUNTIME_SETTINGS_DOC).get();
        if (!doc.exists) return { ...DEFAULT_RUNTIME_SETTINGS };
        return { ...DEFAULT_RUNTIME_SETTINGS, ...(doc.data() as Partial<KnowledgeRuntimeSettings>) };
    }

    async updateRuntimeSettings(
        update: (current: KnowledgeRuntimeSettings) => KnowledgeRuntimeSettings
    ): Promise<KnowledgeRuntimeSettings> {
        const ref = this.db().collection(this.collections.runtimeSettings).doc(RUNTIME_SETTINGS_DOC);
        return this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            const current: KnowledgeRuntimeSettings = doc.exists
                ? { ...DEFAULT_RUNTIME_SETTINGS, ...(doc.data() as Partial<KnowledgeRuntimeSettings>) }
                : { ...DEFAULT_RUNTIME_SETTINGS };
            const next = { ...update(current), schemaVersion: KNOWLEDGE_SCHEMA_VERSION };
            tx.set(ref, next);
            return next;
        });
    }

    // ------------------------------------------------------------------
    // reviews
    // ------------------------------------------------------------------

    async getReview(reviewId: string): Promise<KnowledgeReview | null> {
        const doc = await this.reviews().doc(reviewId).get();
        return doc.exists ? (doc.data() as KnowledgeReview) : null;
    }

    async putReview(review: KnowledgeReview, expectedVersion?: number): Promise<KnowledgeReview> {
        const ref = this.reviews().doc(review.reviewId);
        await this.db().runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (expectedVersion !== undefined && (doc.data()?.recordVersion ?? 0) !== expectedVersion) {
                throw new VersionConflictError(`review ${review.reviewId}: expected ${expectedVersion}`);
            }
            tx.set(ref, review);
        });
        return review;
    }

    async listReviews(filter: { state?: string; knowledgeId?: string } = {}): Promise<KnowledgeReview[]> {
        const snapshot = await this.reviews().orderBy('reviewId').get();
        return snapshot.docs
            .map((doc) => doc.data() as KnowledgeReview)
            .filter((r) => (!filter.state || r.state === filter.state) && (!filter.knowledgeId || r.knowledgeId === filter.knowledgeId));
    }

    // ------------------------------------------------------------------
    // reception policies — create-only from the importer path
    // ------------------------------------------------------------------

    async getPolicy(policyId: string): Promise<Record<string, unknown> | null> {
        const doc = await this.policies().doc(policyId).get();
        return doc.exists ? (doc.data() as Record<string, unknown>) : null;
    }

    async putPolicy(policy: Record<string, unknown> & { policy_id: string }): Promise<Record<string, unknown>> {
        await this.policies().doc(policy.policy_id).set(policy);
        return policy;
    }

    async listPolicies(): Promise<Array<Record<string, unknown>>> {
        const snapshot = await this.policies().orderBy('policy_id').get();
        return snapshot.docs.map((doc) => doc.data() as Record<string, unknown>);
    }

    // ------------------------------------------------------------------
    // audit — append-only, never contains customer text or secrets
    // ------------------------------------------------------------------

    async appendAuditEvent(event: {
        eventId: string;
        actor: string;
        action: string;
        target: string;
        result: string;
        metadata?: Record<string, unknown>;
        timestamp: string;
    }): Promise<void> {
        await this.db().collection(this.collections.auditEvents).doc(event.eventId).create(event);
    }
}
