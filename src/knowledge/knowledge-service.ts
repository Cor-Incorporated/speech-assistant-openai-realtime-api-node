// Knowledge lifecycle: draft → in_review → approved → published, plus
// withdraw / soft-delete / restore. Every write goes through permission +
// version checks and records an audit event — the API layer must not be
// able to bypass this service.

import { randomUUID } from 'node:crypto';
import { hasPermission, type Actor, type Permission } from '../admin/permissions.js';
import type {
    KnowledgeRepository,
    ListKnowledgeFilter,
    ListResult
} from './repository.js';
import { NotFoundError, VersionConflictError } from './repository.js';
import {
    KNOWLEDGE_SCHEMA_VERSION,
    knowledgeContentHash,
    releaseManifestHash,
    type KnowledgeDraftInput,
    type KnowledgeRecord,
    type KnowledgeRelease,
    type KnowledgeReview,
    type KnowledgeRevision,
    type KnowledgeRuntimeSettings,
    type PublishedKnowledgeItem,
    type ReleaseEntry,
    type SourceRecord,
    validateDraftInput
} from './schemas.js';

export class ServiceError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly fieldErrors: Record<string, string> | undefined;
    constructor(statusCode: number, code: string, message: string, fieldErrors?: Record<string, string>) {
        super(message);
        this.name = 'ServiceError';
        this.statusCode = statusCode;
        this.code = code;
        this.fieldErrors = fieldErrors;
    }
}

const forbidden = (action: string): ServiceError =>
    new ServiceError(403, 'FORBIDDEN', `missing permission for ${action}`);

const requirePermission = (actor: Actor, permission: Permission, action: string): void => {
    if (!hasPermission(actor, permission)) throw forbidden(action);
};

const nowIso = (): string => new Date().toISOString();

export interface Clock {
    now(): string;
}

const systemClock: Clock = { now: nowIso };

/** The whitelist: only these fields may ever reach a published item or the
 * voice tool. operatorNote / reviewQuestion / internal bookkeeping stay out. */
const toPublishedItem = (
    record: KnowledgeRecord,
    revision: KnowledgeRevision
): PublishedKnowledgeItem => ({
    knowledgeId: record.knowledgeId,
    key: record.key,
    revision: revision.revision,
    contentHash: revision.contentHash,
    title: record.title,
    category: record.category,
    locale: record.locale,
    keywords: [...record.keywords],
    answerJa: revision.answerJa,
    answerType: revision.answerType,
    value: JSON.parse(JSON.stringify(revision.value)) as Record<string, unknown>,
    evidenceState: revision.evidenceState,
    sourceIds: revision.sourceRefs.map((ref) => ref.sourceId),
    asOf: revision.asOf,
    expiresAt: revision.validity.expiresAt,
    requiresHumanReview: record.handling !== 'answer_after_approval'
});

const isWithinValidity = (revision: KnowledgeRevision, at: string): boolean => {
    const { effectiveFrom, expiresAt } = revision.validity;
    if (effectiveFrom && at < effectiveFrom) return false;
    if (expiresAt && at > expiresAt) return false;
    return true;
};

export class KnowledgeService {
    constructor(
        private readonly repo: KnowledgeRepository,
        private readonly clock: Clock = systemClock
    ) {}

    private async audit(actor: Actor, action: string, target: string, result: string, metadata?: Record<string, unknown>) {
        await this.repo.appendAuditEvent({
            eventId: `audit_${randomUUID()}`,
            actor: actor.subject,
            action,
            target,
            result,
            ...(metadata ? { metadata } : {}),
            timestamp: this.clock.now()
        });
    }

    // ------------------------------------------------------------------
    // Draft lifecycle
    // ------------------------------------------------------------------

    async createDraft(actor: Actor, rawInput: unknown, knowledgeId = `COR-K-${randomUUID()}`): Promise<KnowledgeRecord> {
        requirePermission(actor, 'knowledge.edit', 'knowledge.create');
        const validated = validateDraftInput(rawInput);
        if (!validated.ok) {
            throw new ServiceError(
                422,
                'VALIDATION',
                'invalid knowledge draft',
                Object.fromEntries(validated.issues.map((i) => [i.field, i.message]))
            );
        }
        const input = validated.value;
        const existing = await this.repo.getKnowledgeByKey(input.key);
        if (existing && !existing.deletedAt) {
            throw new ServiceError(409, 'KEY_CONFLICT', `key ${input.key} is already used by ${existing.knowledgeId}`);
        }

        const now = this.clock.now();
        const record: KnowledgeRecord = {
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            knowledgeId,
            key: input.key,
            title: input.title,
            category: input.category,
            locale: input.locale,
            keywords: [...input.keywords],
            audience: input.audience,
            handling: input.handling,
            riskLevel: input.riskLevel,
            state: 'draft',
            draftRevision: 1,
            publishedRevision: null,
            recordVersion: 1,
            deletedAt: null,
            deletedBy: null,
            deletionReason: null,
            createdAt: now,
            createdBy: actor.subject,
            updatedAt: now,
            updatedBy: actor.subject
        };

        const revision = this.buildRevision(record, 1, input, actor.subject, now);
        const { created, record: stored } = await this.repo.createKnowledgeIfAbsent(record);
        if (!created) {
            throw new ServiceError(409, 'ALREADY_EXISTS', `knowledge ${knowledgeId} or key ${input.key} already exists`);
        }
        await this.repo.putRevision(knowledgeId, revision);
        await this.audit(actor, 'knowledge.create', knowledgeId, 'success', { key: input.key });
        return stored;
    }

    /** Editing always produces a new draft revision — the published revision
     * is never touched, and any earlier approval does not carry over. */
    async updateDraft(actor: Actor, knowledgeId: string, rawInput: unknown, expectedVersion?: number): Promise<KnowledgeRecord> {
        requirePermission(actor, 'knowledge.edit', 'knowledge.update');
        const validated = validateDraftInput(rawInput);
        if (!validated.ok) {
            throw new ServiceError(
                422,
                'VALIDATION',
                'invalid knowledge draft',
                Object.fromEntries(validated.issues.map((i) => [i.field, i.message]))
            );
        }
        const input = validated.value;
        const record = await this.mustGet(actor, knowledgeId);
        if (record.deletedAt) throw new ServiceError(409, 'DELETED', `knowledge ${knowledgeId} is deleted`);
        if (input.key !== record.key) {
            const keyOwner = await this.repo.getKnowledgeByKey(input.key);
            if (keyOwner && keyOwner.knowledgeId !== knowledgeId && !keyOwner.deletedAt) {
                throw new ServiceError(409, 'KEY_CONFLICT', `key ${input.key} is already used by ${keyOwner.knowledgeId}`);
            }
        }

        const now = this.clock.now();
        const nextRevision = (record.draftRevision ?? 0) + 1;
        const updated: KnowledgeRecord = {
            ...record,
            key: input.key,
            title: input.title,
            category: input.category,
            locale: input.locale,
            keywords: [...input.keywords],
            audience: input.audience,
            handling: input.handling,
            riskLevel: input.riskLevel,
            // An edit after approval/publication reopens the draft — the
            // already-published revision keeps serving until a new release.
            state: record.state === 'published' ? 'published' : 'draft',
            draftRevision: nextRevision,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };

        await this.repo.putKnowledge(updated, expectedVersion ?? record.recordVersion);
        await this.repo.putRevision(knowledgeId, this.buildRevision(updated, nextRevision, input, actor.subject, now));
        await this.audit(actor, 'knowledge.update', knowledgeId, 'success', { revision: nextRevision });
        return updated;
    }

    private buildRevision(
        record: KnowledgeRecord,
        revisionNumber: number,
        input: KnowledgeDraftInput,
        createdBy: string,
        now: string
    ): KnowledgeRevision {
        const sourceIds = input.sourceRefs.map((ref) => ref.sourceId);
        return {
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            revision: revisionNumber,
            contentHash: knowledgeContentHash({
                key: input.key,
                value: input.value,
                answerJa: input.answerJa,
                answerType: input.answerType,
                evidenceState: input.evidenceState,
                sourceIds,
                asOf: input.asOf,
                validity: input.validity
            }),
            value: JSON.parse(JSON.stringify(input.value)) as Record<string, unknown>,
            answerJa: input.answerJa,
            answerType: input.answerType,
            evidenceState: input.evidenceState,
            sourceRefs: input.sourceRefs.map((ref) => ({ ...ref })),
            asOf: input.asOf,
            checkedOn: input.checkedOn,
            validity: { ...input.validity },
            approval: { approvedBy: null, approvedAt: null, reason: null, revision: null, contentHash: null },
            operatorNote: input.operatorNote,
            reviewQuestion: input.reviewQuestion,
            createdAt: now,
            createdBy
        };
    }

    // ------------------------------------------------------------------
    // Review / approval
    // ------------------------------------------------------------------

    async submitForReview(actor: Actor, knowledgeId: string, revision: number): Promise<KnowledgeRecord> {
        requirePermission(actor, 'knowledge.edit', 'knowledge.submit_review');
        const record = await this.mustGet(actor, knowledgeId);
        if (record.deletedAt) throw new ServiceError(409, 'DELETED', `knowledge ${knowledgeId} is deleted`);
        if (record.draftRevision !== revision) {
            throw new ServiceError(409, 'REVISION_MISMATCH', `draft is at revision ${record.draftRevision}, not ${revision}`);
        }
        const updated = await this.transition(actor, record, 'in_review');
        await this.audit(actor, 'knowledge.submit_review', knowledgeId, 'success', { revision });
        return updated;
    }

    /** Approval binds to revision + content hash. Editing afterwards creates
     * a new revision and this approval can never be reused for it. */
    async approve(actor: Actor, knowledgeId: string, args: { revision: number; contentHash: string; reason: string }): Promise<KnowledgeRecord> {
        requirePermission(actor, 'knowledge.approve', 'knowledge.approve');
        const record = await this.mustGet(actor, knowledgeId);
        if (record.deletedAt) throw new ServiceError(409, 'DELETED', `knowledge ${knowledgeId} is deleted`);
        const revision = await this.repo.getRevision(knowledgeId, args.revision);
        if (!revision) throw new NotFoundError(`revision ${args.revision} of ${knowledgeId} not found`);
        if (revision.contentHash !== args.contentHash) {
            throw new ServiceError(409, 'HASH_MISMATCH', 'the approved content hash does not match the revision');
        }
        if (!args.reason || !args.reason.trim()) {
            throw new ServiceError(422, 'VALIDATION', 'approval reason is required', { reason: 'required' });
        }

        const now = this.clock.now();
        const approvedRevision: KnowledgeRevision = {
            ...revision,
            approval: {
                approvedBy: actor.subject,
                approvedAt: now,
                reason: args.reason,
                revision: args.revision,
                contentHash: args.contentHash
            }
        };
        // Approval is the only mutable revision field — the content hash
        // match inside the repository makes it impossible to record the
        // approval against different content.
        await this.repo.updateRevisionApproval(knowledgeId, approvedRevision);

        const updated = await this.transition(actor, record, 'approved');
        await this.audit(actor, 'knowledge.approve', knowledgeId, 'success', {
            revision: args.revision,
            contentHash: args.contentHash
        });
        return updated;
    }

    // ------------------------------------------------------------------
    // Publish / withdraw
    // ------------------------------------------------------------------

    /** Build an immutable release from every approved + publishable item and
     * only then flip currentReleaseId. A failure anywhere before the flip
     * leaves the previous release serving — there is no half-written state. */
    async publish(actor: Actor, args: { knowledgeIds?: string[]; releaseId?: string } = {}): Promise<KnowledgeRelease> {
        requirePermission(actor, 'knowledge.publish', 'knowledge.publish');
        const now = this.clock.now();

        const { items: records } = await this.repo.listKnowledge({ limit: 200 });
        const candidates = args.knowledgeIds
            ? records.filter((r) => args.knowledgeIds!.includes(r.knowledgeId))
            : records;

        const entries: ReleaseEntry[] = [];
        const items: PublishedKnowledgeItem[] = [];
        const skipped: Array<{ knowledgeId: string; reason: string }> = [];

        for (const record of candidates) {
            if (record.deletedAt) {
                skipped.push({ knowledgeId: record.knowledgeId, reason: 'deleted' });
                continue;
            }
            if (record.audience !== 'public') {
                skipped.push({ knowledgeId: record.knowledgeId, reason: 'admin_only' });
                continue;
            }
            if (record.state !== 'approved' && record.state !== 'published') {
                skipped.push({ knowledgeId: record.knowledgeId, reason: `state:${record.state}` });
                continue;
            }
            const revisionNumber = record.draftRevision;
            if (!revisionNumber) {
                skipped.push({ knowledgeId: record.knowledgeId, reason: 'no_revision' });
                continue;
            }
            const revision = await this.repo.getRevision(record.knowledgeId, revisionNumber);
            if (!revision) {
                skipped.push({ knowledgeId: record.knowledgeId, reason: 'revision_missing' });
                continue;
            }
            const approval = revision.approval;
            if (approval.revision !== revisionNumber || approval.contentHash !== revision.contentHash) {
                skipped.push({ knowledgeId: record.knowledgeId, reason: 'unapproved_revision' });
                continue;
            }
            if (!isWithinValidity(revision, now)) {
                skipped.push({ knowledgeId: record.knowledgeId, reason: 'outside_validity' });
                continue;
            }
            entries.push({
                knowledgeId: record.knowledgeId,
                key: record.key,
                revision: revisionNumber,
                contentHash: revision.contentHash
            });
            items.push(toPublishedItem(record, revision));
        }

        if (entries.length === 0) {
            throw new ServiceError(422, 'NOTHING_TO_PUBLISH', 'no approved publishable knowledge items', {
                skipped: `${skipped.length} item(s) not publishable`
            });
        }

        const releaseId = args.releaseId ?? `rel_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
        const release: KnowledgeRelease = {
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            releaseId,
            createdAt: now,
            createdBy: actor.subject,
            manifestHash: releaseManifestHash(entries),
            entries: entries.sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId))
        };

        // Manifest + items land atomically; the pointer flips afterwards.
        await this.repo.createRelease(release, items);
        const settings = await this.repo.updateRuntimeSettings((current) => ({
            ...current,
            currentReleaseId: releaseId,
            updatedAt: now
        }));

        for (const record of candidates) {
            if (entries.some((e) => e.knowledgeId === record.knowledgeId) && record.state !== 'published') {
                await this.transition(actor, record, 'published', { publishedRevision: record.draftRevision });
            }
        }

        await this.audit(actor, 'knowledge.publish', releaseId, 'success', {
            itemCount: entries.length,
            manifestHash: release.manifestHash,
            skipped: skipped.length
        });
        void settings;
        return release;
    }

    /** Withdraw pulls an item from future releases AND records it in the
     * revocation registry so in-flight calls stop serving it — a normal
     * publish alone cannot retract a dangerous answer. */
    async withdraw(actor: Actor, knowledgeId: string, args: { reason: string; emergency?: boolean } ): Promise<KnowledgeRecord> {
        requirePermission(actor, 'knowledge.withdraw', 'knowledge.withdraw');
        if (!args.reason?.trim()) {
            throw new ServiceError(422, 'VALIDATION', 'withdraw reason is required', { reason: 'required' });
        }
        const record = await this.mustGet(actor, knowledgeId);
        const now = this.clock.now();
        const updated = await this.transition(actor, record, 'withdrawn');

        if (args.emergency || record.state === 'published') {
            await this.repo.updateRuntimeSettings((current) => ({
                ...current,
                revocationEpoch: current.revocationEpoch + 1,
                revokedKnowledgeIds: [...new Set([...current.revokedKnowledgeIds, knowledgeId])],
                updatedAt: now
            }));
        }
        await this.audit(actor, 'knowledge.withdraw', knowledgeId, 'success', {
            reason: args.reason,
            emergency: args.emergency === true
        });
        return updated;
    }

    // ------------------------------------------------------------------
    // Delete / restore
    // ------------------------------------------------------------------

    async softDelete(actor: Actor, knowledgeId: string, args: { reason: string }): Promise<KnowledgeRecord> {
        requirePermission(actor, 'knowledge.edit', 'knowledge.delete');
        if (!args.reason?.trim()) {
            throw new ServiceError(422, 'VALIDATION', 'deletion reason is required', { reason: 'required' });
        }
        const record = await this.mustGet(actor, knowledgeId);
        const now = this.clock.now();
        const updated: KnowledgeRecord = {
            ...record,
            state: record.state === 'published' ? 'withdrawn' : record.state,
            deletedAt: now,
            deletedBy: actor.subject,
            deletionReason: args.reason,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };
        await this.repo.putKnowledge(updated, record.recordVersion);
        await this.repo.updateRuntimeSettings((current) => ({
            ...current,
            revocationEpoch: current.revocationEpoch + 1,
            revokedKnowledgeIds: [...new Set([...current.revokedKnowledgeIds, knowledgeId])],
            updatedAt: now
        }));
        await this.audit(actor, 'knowledge.delete', knowledgeId, 'success', { reason: args.reason });
        return updated;
    }

    /** Restore returns the item to draft — it is never silently republished. */
    async restore(actor: Actor, knowledgeId: string, expectedVersion?: number): Promise<KnowledgeRecord> {
        requirePermission(actor, 'knowledge.edit', 'knowledge.restore');
        const record = await this.mustGet(actor, knowledgeId, { includeDeleted: true });
        if (!record.deletedAt) throw new ServiceError(409, 'NOT_DELETED', `knowledge ${knowledgeId} is not deleted`);
        const now = this.clock.now();
        const updated: KnowledgeRecord = {
            ...record,
            state: 'draft',
            deletedAt: null,
            deletedBy: null,
            deletionReason: null,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };
        await this.repo.putKnowledge(updated, expectedVersion ?? record.recordVersion);
        await this.audit(actor, 'knowledge.restore', knowledgeId, 'success', {});
        return updated;
    }

    // ------------------------------------------------------------------
    // Sources / reviews
    // ------------------------------------------------------------------

    async putSource(actor: Actor, record: SourceRecord, expectedVersion?: number): Promise<SourceRecord> {
        requirePermission(actor, 'sources.edit', 'sources.update');
        const stored = await this.repo.putSource({ ...record, updatedAt: this.clock.now(), updatedBy: actor.subject }, expectedVersion);
        await this.audit(actor, 'knowledge.source_update', record.sourceId, 'success', {});
        return stored;
    }

    /** Deleting a source that is still referenced must not leave published
     * knowledge without its stated evidence — callers get the dependent
     * list back to resolve or withdraw first. */
    async deleteSource(actor: Actor, sourceId: string, expectedVersion?: number): Promise<{ dependents: string[] }> {
        requirePermission(actor, 'sources.edit', 'sources.delete');
        const dependents: string[] = [];
        const { items } = await this.repo.listKnowledge({ limit: 200 });
        for (const record of items) {
            const revisions = await this.repo.listRevisions(record.knowledgeId);
            const head = revisions.find((r) => r.revision === record.draftRevision);
            if (head?.sourceRefs.some((ref) => ref.sourceId === sourceId)) {
                dependents.push(record.knowledgeId);
            }
        }
        if (dependents.length > 0) {
            throw new ServiceError(409, 'SOURCE_IN_USE', `source ${sourceId} is referenced by knowledge: ${dependents.join(', ')}`, {
                dependents: dependents.join(',')
            });
        }
        const source = await this.repo.getSource(sourceId);
        if (!source) throw new NotFoundError(`source ${sourceId} not found`);
        await this.repo.putSource(
            { ...source, deletedAt: this.clock.now(), updatedAt: this.clock.now(), updatedBy: actor.subject, recordVersion: source.recordVersion + 1 },
            expectedVersion ?? source.recordVersion
        );
        await this.audit(actor, 'knowledge.source_delete', sourceId, 'success', {});
        return { dependents };
    }

    async resolveReview(actor: Actor, reviewId: string, args: { resolvedValue: string; expectedVersion?: number }): Promise<KnowledgeReview> {
        requirePermission(actor, 'reviews.resolve', 'reviews.resolve');
        const review = await this.repo.getReview(reviewId);
        if (!review) throw new NotFoundError(`review ${reviewId} not found`);
        const now = this.clock.now();
        const updated: KnowledgeReview = {
            ...review,
            state: 'resolved',
            resolvedValue: args.resolvedValue,
            resolvedBy: actor.subject,
            resolvedAt: now,
            recordVersion: review.recordVersion + 1,
            updatedAt: now
        };
        await this.repo.putReview(updated, args.expectedVersion ?? review.recordVersion);
        await this.audit(actor, 'knowledge.review_resolve', reviewId, 'success', { knowledgeId: review.knowledgeId });
        return updated;
    }

    // ------------------------------------------------------------------
    // Reads (permission-filtered; draft visibility requires knowledge.read)
    // ------------------------------------------------------------------

    async get(actor: Actor, knowledgeId: string, options: { includeDeleted?: boolean } = {}): Promise<KnowledgeRecord | null> {
        requirePermission(actor, 'knowledge.read', 'knowledge.read');
        const record = await this.repo.getKnowledge(knowledgeId);
        if (!record || (record.deletedAt && !options.includeDeleted)) return null;
        return record;
    }

    async list(actor: Actor, filter: ListKnowledgeFilter = {}): Promise<ListResult<KnowledgeRecord>> {
        requirePermission(actor, 'knowledge.read', 'knowledge.list');
        return this.repo.listKnowledge(filter);
    }

    async runtimeSettings(): Promise<KnowledgeRuntimeSettings> {
        return this.repo.getRuntimeSettings();
    }

    private async mustGet(_actor: Actor, knowledgeId: string, options: { includeDeleted?: boolean } = {}): Promise<KnowledgeRecord> {
        const record = await this.repo.getKnowledge(knowledgeId);
        if (!record || (record.deletedAt && !options.includeDeleted)) {
            throw new NotFoundError(`knowledge ${knowledgeId} not found`);
        }
        return record;
    }

    private async transition(
        actor: Actor,
        record: KnowledgeRecord,
        state: KnowledgeRecord['state'],
        extra: Partial<KnowledgeRecord> = {}
    ): Promise<KnowledgeRecord> {
        const now = this.clock.now();
        const updated: KnowledgeRecord = {
            ...record,
            ...extra,
            state,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };
        await this.repo.putKnowledge(updated, record.recordVersion);
        return updated;
    }
}

export { NotFoundError, VersionConflictError };
