// Persistence boundary for the Cor. knowledge store.
// The service layer only ever talks to this interface — the Firestore
// implementation lives in firestore-repository.ts and the in-memory one
// below backs unit tests and local development.

import type {
    KnowledgeRecord,
    KnowledgeRelease,
    KnowledgeReview,
    KnowledgeRevision,
    KnowledgeRuntimeSettings,
    PublicationState,
    PublishedKnowledgeItem,
    SourceRecord
} from './schemas.js';

export class VersionConflictError extends Error {
    readonly code = 'VERSION_CONFLICT';
    readonly statusCode = 412;
    constructor(message: string) {
        super(message);
        this.name = 'VersionConflictError';
    }
}

export class NotFoundError extends Error {
    readonly code = 'NOT_FOUND';
    readonly statusCode = 404;
    constructor(message: string) {
        super(message);
        this.name = 'NotFoundError';
    }
}

export interface ListKnowledgeFilter {
    state?: PublicationState;
    category?: string;
    includeDeleted?: boolean;
    limit?: number;
    cursor?: string;
}

export interface ListResult<T> {
    items: T[];
    nextCursor: string | null;
    /** True when the page limit truncated the result — callers must not
     * present a partial scan as the complete set. */
    hasMore: boolean;
}

export interface KnowledgeRepository {
    // ---- sources -------------------------------------------------------
    getSource(sourceId: string): Promise<SourceRecord | null>;
    putSource(record: SourceRecord, expectedVersion?: number): Promise<SourceRecord>;
    listSources(options?: { includeDeleted?: boolean }): Promise<SourceRecord[]>;

    // ---- knowledge root -------------------------------------------------
    getKnowledge(knowledgeId: string): Promise<KnowledgeRecord | null>;
    getKnowledgeByKey(key: string): Promise<KnowledgeRecord | null>;
    /** Optimistic lock: when expectedVersion is given the write only lands
     * if the stored recordVersion still matches — 412 on a stale edit. */
    putKnowledge(record: KnowledgeRecord, expectedVersion?: number): Promise<KnowledgeRecord>;
    /** Insert only when neither id nor key exists. Returns the existing
     * record when one is already there. */
    createKnowledgeIfAbsent(record: KnowledgeRecord): Promise<{ created: boolean; record: KnowledgeRecord }>;
    listKnowledge(filter?: ListKnowledgeFilter): Promise<ListResult<KnowledgeRecord>>;

    // ---- revisions ------------------------------------------------------
    getRevision(knowledgeId: string, revision: number): Promise<KnowledgeRevision | null>;
    /** Insert-only — a stored revision is immutable. */
    putRevision(knowledgeId: string, revision: KnowledgeRevision): Promise<KnowledgeRevision>;
    /** The only mutable part of a revision: approval metadata recording who
     * approved this exact content hash. The stored contentHash must match —
     * approval can never be recorded against different content. */
    updateRevisionApproval(knowledgeId: string, revision: KnowledgeRevision): Promise<KnowledgeRevision>;
    listRevisions(knowledgeId: string): Promise<KnowledgeRevision[]>;

    // ---- releases --------------------------------------------------------
    /** Write the manifest + all published items atomically. An existing
     * releaseId is never overwritten — a failed release can be deleted
     * before it is pointed at, but never edited in place. */
    createRelease(release: KnowledgeRelease, items: PublishedKnowledgeItem[]): Promise<void>;
    getRelease(releaseId: string): Promise<KnowledgeRelease | null>;
    getReleaseItems(releaseId: string): Promise<PublishedKnowledgeItem[]>;
    listReleases(limit?: number): Promise<KnowledgeRelease[]>;

    // ---- runtime settings -------------------------------------------------
    getRuntimeSettings(): Promise<KnowledgeRuntimeSettings>;
    /** Compare-and-swap on the settings document. */
    updateRuntimeSettings(
        update: (current: KnowledgeRuntimeSettings) => KnowledgeRuntimeSettings
    ): Promise<KnowledgeRuntimeSettings>;

    // ---- reviews -----------------------------------------------------------
    getReview(reviewId: string): Promise<KnowledgeReview | null>;
    putReview(review: KnowledgeReview, expectedVersion?: number): Promise<KnowledgeReview>;
    listReviews(filter?: { state?: string; knowledgeId?: string }): Promise<KnowledgeReview[]>;

    // ---- reception policies -------------------------------------------------
    // Policies stay in the seed's snake_case shape — the admin UI reads them
    // through a projection. Stored generically so importer/route paths share
    // one create-only write.
    getPolicy(policyId: string): Promise<Record<string, unknown> | null>;
    putPolicy(policy: Record<string, unknown> & { policy_id: string }): Promise<Record<string, unknown>>;
    listPolicies(): Promise<Array<Record<string, unknown>>>;

    // ---- audit ----------------------------------------------------------
    appendAuditEvent(event: {
        eventId: string;
        actor: string;
        action: string;
        target: string;
        result: string;
        metadata?: Record<string, unknown>;
        timestamp: string;
    }): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation — deterministic, used by unit tests and the
// local emulator-free development path.
// ---------------------------------------------------------------------------

const DEFAULT_RUNTIME_SETTINGS: KnowledgeRuntimeSettings = {
    currentReleaseId: null,
    revocationEpoch: 0,
    revokedKnowledgeIds: [],
    updatedAt: '1970-01-01T00:00:00.000Z'
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class InMemoryKnowledgeRepository implements KnowledgeRepository {
    private readonly sources = new Map<string, SourceRecord>();
    private readonly knowledge = new Map<string, KnowledgeRecord>();
    private readonly revisions = new Map<string, Map<number, KnowledgeRevision>>();
    private readonly releases = new Map<string, KnowledgeRelease>();
    private readonly releaseItems = new Map<string, PublishedKnowledgeItem[]>();
    private readonly reviews = new Map<string, KnowledgeReview>();
    private readonly policies = new Map<string, Record<string, unknown>>();
    private readonly audit: Array<Record<string, unknown>> = [];
    private runtimeSettings: KnowledgeRuntimeSettings = clone(DEFAULT_RUNTIME_SETTINGS);

    async getSource(sourceId: string): Promise<SourceRecord | null> {
        const record = this.sources.get(sourceId);
        return record ? clone(record) : null;
    }

    async putSource(record: SourceRecord, expectedVersion?: number): Promise<SourceRecord> {
        const existing = this.sources.get(record.sourceId);
        if (expectedVersion !== undefined && (existing?.recordVersion ?? 0) !== expectedVersion) {
            throw new VersionConflictError(
                `source ${record.sourceId}: expected version ${expectedVersion}, found ${existing?.recordVersion ?? 'none'}`
            );
        }
        this.sources.set(record.sourceId, clone(record));
        return clone(record);
    }

    async listSources(options: { includeDeleted?: boolean } = {}): Promise<SourceRecord[]> {
        return [...this.sources.values()]
            .filter((s) => options.includeDeleted || !s.deletedAt)
            .map(clone)
            .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    }

    async getKnowledge(knowledgeId: string): Promise<KnowledgeRecord | null> {
        const record = this.knowledge.get(knowledgeId);
        return record ? clone(record) : null;
    }

    async getKnowledgeByKey(key: string): Promise<KnowledgeRecord | null> {
        for (const record of this.knowledge.values()) {
            if (record.key === key) return clone(record);
        }
        return null;
    }

    async putKnowledge(record: KnowledgeRecord, expectedVersion?: number): Promise<KnowledgeRecord> {
        const existing = this.knowledge.get(record.knowledgeId);
        if (expectedVersion !== undefined && (existing?.recordVersion ?? 0) !== expectedVersion) {
            throw new VersionConflictError(
                `knowledge ${record.knowledgeId}: expected version ${expectedVersion}, found ${existing?.recordVersion ?? 'none'}`
            );
        }
        this.knowledge.set(record.knowledgeId, clone(record));
        return clone(record);
    }

    async createKnowledgeIfAbsent(
        record: KnowledgeRecord
    ): Promise<{ created: boolean; record: KnowledgeRecord }> {
        const existing = this.knowledge.get(record.knowledgeId);
        if (existing) return { created: false, record: clone(existing) };
        for (const other of this.knowledge.values()) {
            if (other.key === record.key && !other.deletedAt) {
                return { created: false, record: clone(other) };
            }
        }
        this.knowledge.set(record.knowledgeId, clone(record));
        return { created: true, record: clone(record) };
    }

    async listKnowledge(filter: ListKnowledgeFilter = {}): Promise<ListResult<KnowledgeRecord>> {
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
        let items = [...this.knowledge.values()];
        if (!filter.includeDeleted) items = items.filter((r) => !r.deletedAt);
        if (filter.state) items = items.filter((r) => r.state === filter.state);
        if (filter.category) items = items.filter((r) => r.category === filter.category);
        items.sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId));

        const startIndex = filter.cursor
            ? items.findIndex((r) => r.knowledgeId === filter.cursor) + 1
            : 0;
        const start = startIndex > 0 ? startIndex : filter.cursor ? items.length : 0;
        const page = items.slice(start, start + limit);
        const hasMore = start + limit < items.length;
        return {
            items: page.map(clone),
            nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.knowledgeId : null,
            hasMore
        };
    }

    async getRevision(knowledgeId: string, revision: number): Promise<KnowledgeRevision | null> {
        const record = this.revisions.get(knowledgeId)?.get(revision);
        return record ? clone(record) : null;
    }

    async putRevision(knowledgeId: string, revision: KnowledgeRevision): Promise<KnowledgeRevision> {
        let bucket = this.revisions.get(knowledgeId);
        if (!bucket) {
            bucket = new Map();
            this.revisions.set(knowledgeId, bucket);
        }
        if (bucket.has(revision.revision)) {
            throw new VersionConflictError(
                `knowledge ${knowledgeId}: revision ${revision.revision} already exists and is immutable`
            );
        }
        bucket.set(revision.revision, clone(revision));
        return clone(revision);
    }

    async updateRevisionApproval(knowledgeId: string, revision: KnowledgeRevision): Promise<KnowledgeRevision> {
        const bucket = this.revisions.get(knowledgeId);
        const stored = bucket?.get(revision.revision);
        if (!stored) {
            throw new NotFoundError(`revision ${revision.revision} of ${knowledgeId} not found`);
        }
        if (stored.contentHash !== revision.contentHash) {
            throw new VersionConflictError(
                `revision ${revision.revision} of ${knowledgeId}: content hash mismatch — approval cannot move to different content`
            );
        }
        const updated: KnowledgeRevision = { ...stored, approval: { ...revision.approval } };
        bucket!.set(revision.revision, clone(updated));
        return clone(updated);
    }

    async listRevisions(knowledgeId: string): Promise<KnowledgeRevision[]> {
        return [...(this.revisions.get(knowledgeId)?.values() ?? [])]
            .map(clone)
            .sort((a, b) => a.revision - b.revision);
    }

    async createRelease(release: KnowledgeRelease, items: PublishedKnowledgeItem[]): Promise<void> {
        if (this.releases.has(release.releaseId)) {
            throw new VersionConflictError(`release ${release.releaseId} already exists`);
        }
        this.releases.set(release.releaseId, clone(release));
        this.releaseItems.set(release.releaseId, items.map(clone));
    }

    async getRelease(releaseId: string): Promise<KnowledgeRelease | null> {
        const release = this.releases.get(releaseId);
        return release ? clone(release) : null;
    }

    async getReleaseItems(releaseId: string): Promise<PublishedKnowledgeItem[]> {
        return (this.releaseItems.get(releaseId) ?? []).map(clone);
    }

    async listReleases(limit = 20): Promise<KnowledgeRelease[]> {
        return [...this.releases.values()]
            .map(clone)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, limit);
    }

    async getRuntimeSettings(): Promise<KnowledgeRuntimeSettings> {
        return clone(this.runtimeSettings);
    }

    async updateRuntimeSettings(
        update: (current: KnowledgeRuntimeSettings) => KnowledgeRuntimeSettings
    ): Promise<KnowledgeRuntimeSettings> {
        this.runtimeSettings = clone(update(clone(this.runtimeSettings)));
        return clone(this.runtimeSettings);
    }

    async getReview(reviewId: string): Promise<KnowledgeReview | null> {
        const review = this.reviews.get(reviewId);
        return review ? clone(review) : null;
    }

    async putReview(review: KnowledgeReview, expectedVersion?: number): Promise<KnowledgeReview> {
        const existing = this.reviews.get(review.reviewId);
        if (expectedVersion !== undefined && (existing?.recordVersion ?? 0) !== expectedVersion) {
            throw new VersionConflictError(
                `review ${review.reviewId}: expected version ${expectedVersion}, found ${existing?.recordVersion ?? 'none'}`
            );
        }
        this.reviews.set(review.reviewId, clone(review));
        return clone(review);
    }

    async listReviews(filter: { state?: string; knowledgeId?: string } = {}): Promise<KnowledgeReview[]> {
        return [...this.reviews.values()]
            .filter((r) => (!filter.state || r.state === filter.state) && (!filter.knowledgeId || r.knowledgeId === filter.knowledgeId))
            .map(clone)
            .sort((a, b) => a.reviewId.localeCompare(b.reviewId));
    }

    async getPolicy(policyId: string): Promise<Record<string, unknown> | null> {
        const record = this.policies.get(policyId);
        return record ? clone(record) : null;
    }

    async putPolicy(policy: Record<string, unknown> & { policy_id: string }): Promise<Record<string, unknown>> {
        this.policies.set(policy.policy_id, clone(policy));
        return clone(policy);
    }

    async listPolicies(): Promise<Array<Record<string, unknown>>> {
        return [...this.policies.values()]
            .map(clone)
            .sort((a, b) => String(a.policy_id ?? '').localeCompare(String(b.policy_id ?? '')));
    }

    async appendAuditEvent(event: {
        eventId: string;
        actor: string;
        action: string;
        target: string;
        result: string;
        metadata?: Record<string, unknown>;
        timestamp: string;
    }): Promise<void> {
        this.audit.push(clone(event));
    }

    /** Test-only introspection — audit contents are never exposed via the
     * service API as raw customer text. */
    getAuditLog(): Array<Record<string, unknown>> {
        return clone(this.audit);
    }
}
