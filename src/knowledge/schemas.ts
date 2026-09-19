// Cor. knowledge data model — runtime schemas and wire converters.
// The distributed seed uses snake_case; the application API uses camelCase.
// Both directions go through the explicit converters below — the same
// meaning is never stored under two different keys.

import { createHash } from 'node:crypto';

export const KNOWLEDGE_SCHEMA_VERSION = 1;

export const PUBLICATION_STATES = [
    'draft',
    'in_review',
    'approved',
    'published',
    'withdrawn',
    'archived'
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export const EVIDENCE_STATES = [
    'official_site_observed',
    'owner_verified',
    'not_confirmed',
    'memory_unverified',
    'source_scope_conflict'
] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const KNOWLEDGE_AUDIENCES = ['public', 'admin_only'] as const;
export type KnowledgeAudience = (typeof KNOWLEDGE_AUDIENCES)[number];

export const KNOWLEDGE_HANDLINGS = [
    'answer_after_approval',
    'owner_review_required',
    'human_review_required'
] as const;
export type KnowledgeHandling = (typeof KNOWLEDGE_HANDLINGS)[number];

export const RISK_LEVELS = ['normal', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ANSWER_TYPES = ['fact', 'fallback'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export const KNOWLEDGE_CATEGORIES = [
    'company',
    'service',
    'price',
    'product',
    'contact',
    'hours',
    'security',
    'privacy',
    'contract',
    'portfolio',
    'research',
    'routing'
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const SOURCE_TYPES = [
    'official_web',
    'vendor_docs',
    'repository',
    'user_instruction',
    'user_memory',
    'security_guidance',
    'prior_audit'
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const REVIEW_STATES = ['open', 'in_progress', 'resolved', 'dismissed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

// ---------------------------------------------------------------------------
// Records (Firestore persistence shape — camelCase inside the application)
// ---------------------------------------------------------------------------

export interface SourceRecord {
    schemaVersion: number;
    sourceId: string;
    sourceType: SourceType;
    title: string;
    url: string | null;
    publishedOn: string | null;
    checkedOn: string | null;
    observation: string | null;
    publicationCaveat: string | null;
    recordVersion: number;
    deletedAt: string | null;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
}

export interface SourceRef {
    sourceId: string;
    locator: string | null;
    checkedOn: string | null;
}

export interface KnowledgeValidity {
    effectiveFrom: string | null;
    expiresAt: string | null;
    nextReviewAt: string | null;
}

export interface KnowledgeApproval {
    approvedBy: string | null;
    approvedAt: string | null;
    reason: string | null;
    /** The approval binds to exactly this revision + hash — an edit after
     * approval produces a new revision and the old approval never carries
     * over. */
    revision: number | null;
    contentHash: string | null;
}

export interface KnowledgeRevision {
    schemaVersion: number;
    revision: number;
    contentHash: string;
    value: Record<string, unknown>;
    answerJa: string | null;
    answerType: AnswerType;
    evidenceState: EvidenceState;
    sourceRefs: SourceRef[];
    asOf: string | null;
    checkedOn: string | null;
    validity: KnowledgeValidity;
    approval: KnowledgeApproval;
    /** Internal-only annotation. Never enters a release or a tool result. */
    operatorNote: string | null;
    reviewQuestion: string | null;
    createdAt: string;
    createdBy: string;
}

export interface KnowledgeRecord {
    schemaVersion: number;
    knowledgeId: string;
    key: string;
    title: string;
    category: KnowledgeCategory;
    locale: string;
    keywords: string[];
    audience: KnowledgeAudience;
    handling: KnowledgeHandling;
    riskLevel: RiskLevel;
    state: PublicationState;
    draftRevision: number | null;
    publishedRevision: number | null;
    recordVersion: number;
    deletedAt: string | null;
    deletedBy: string | null;
    deletionReason: string | null;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
}

export interface ReleaseEntry {
    knowledgeId: string;
    key: string;
    revision: number;
    contentHash: string;
}

/** Whitelisted projection — the only shape the voice path may ever see. */
export interface PublishedKnowledgeItem {
    knowledgeId: string;
    key: string;
    revision: number;
    contentHash: string;
    title: string;
    category: KnowledgeCategory;
    locale: string;
    keywords: string[];
    answerJa: string | null;
    answerType: AnswerType;
    value: Record<string, unknown>;
    evidenceState: EvidenceState;
    sourceIds: string[];
    asOf: string | null;
    expiresAt: string | null;
    requiresHumanReview: boolean;
}

export interface KnowledgeRelease {
    schemaVersion: number;
    releaseId: string;
    createdAt: string;
    createdBy: string;
    manifestHash: string;
    entries: ReleaseEntry[];
}

export interface KnowledgeRuntimeSettings {
    currentReleaseId: string | null;
    /** Emergency revocation — bumped on any safety withdrawal so cached
     * releases on other instances stop serving revoked items. */
    revocationEpoch: number;
    revokedKnowledgeIds: string[];
    updatedAt: string;
}

export interface KnowledgeReview {
    schemaVersion: number;
    reviewId: string;
    knowledgeId: string;
    question: string;
    proposedOwnerRole: string | null;
    state: ReviewState;
    priority: 'high' | 'normal' | 'low';
    blockingScope: string | null;
    resolvedValue: string | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
    recordVersion: number;
    createdAt: string;
    updatedAt: string;
}

// ---------------------------------------------------------------------------
// Validation helpers — reject unknown enum values, never silently normalize
// ---------------------------------------------------------------------------

export interface ValidationIssue {
    field: string;
    message: string;
}

export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; issues: ValidationIssue[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;

const asNullableString = (value: unknown): string | null | undefined =>
    value === null ? null : asString(value) ?? undefined;

const asStringArray = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;

const asInt = (value: unknown): number | null =>
    Number.isInteger(value) ? (value as number) : null;

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const fail = <T>(field: string, message: string): ValidationResult<T> => ({
    ok: false,
    issues: [{ field, message }]
});

// ---------------------------------------------------------------------------
// Hashing — approval and release manifests bind to content, not doc ids
// ---------------------------------------------------------------------------

/** Stable JSON serialization: object keys sorted recursively so the same
 * logical content always produces the same hash regardless of key order. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function contentHashOf(parts: Record<string, unknown>): string {
    return createHash('sha256').update(canonicalJson(parts), 'utf8').digest('hex');
}

/** The hash covers only what the caller would hear — internal annotations
 * (operatorNote, reviewQuestion) never change it and never leak. */
export function knowledgeContentHash(input: {
    key: string;
    value: Record<string, unknown>;
    answerJa: string | null;
    answerType: AnswerType;
    evidenceState: EvidenceState;
    sourceIds: string[];
    asOf: string | null;
    validity: KnowledgeValidity;
}): string {
    return contentHashOf({
        key: input.key,
        value: input.value,
        answerJa: input.answerJa,
        answerType: input.answerType,
        evidenceState: input.evidenceState,
        sourceIds: [...input.sourceIds].sort(),
        asOf: input.asOf,
        validity: input.validity
    });
}

export function releaseManifestHash(entries: ReleaseEntry[]): string {
    const normalized = entries
        .map((e) => ({ knowledgeId: e.knowledgeId, revision: e.revision, contentHash: e.contentHash }))
        .sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId));
    return contentHashOf({ entries: normalized });
}

// ---------------------------------------------------------------------------
// Draft input DTO — what the API accepts for creating/updating a revision
// ---------------------------------------------------------------------------

export interface KnowledgeDraftInput {
    key: string;
    title: string;
    category: KnowledgeCategory;
    locale: string;
    keywords: string[];
    audience: KnowledgeAudience;
    handling: KnowledgeHandling;
    riskLevel: RiskLevel;
    value: Record<string, unknown>;
    answerJa: string | null;
    answerType: AnswerType;
    evidenceState: EvidenceState;
    sourceRefs: SourceRef[];
    asOf: string | null;
    checkedOn: string | null;
    validity: KnowledgeValidity;
    operatorNote: string | null;
    reviewQuestion: string | null;
}

export function validateDraftInput(raw: unknown): ValidationResult<KnowledgeDraftInput> {
    if (!isRecord(raw)) return fail('body', 'must be an object');
    const issues: ValidationIssue[] = [];

    const key = asString(raw.key);
    if (!key) issues.push({ field: 'key', message: 'required' });
    else if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(key)) {
        issues.push({ field: 'key', message: 'must match ^[a-z0-9][a-z0-9._-]{0,127}$' });
    }
    const title = asString(raw.title);
    if (!title) issues.push({ field: 'title', message: 'required' });
    const category = pickEnum(raw.category, KNOWLEDGE_CATEGORIES);
    if (!category) issues.push({ field: 'category', message: `must be one of ${KNOWLEDGE_CATEGORIES.join('|')}` });
    const audience = pickEnum(raw.audience, KNOWLEDGE_AUDIENCES);
    if (!audience) issues.push({ field: 'audience', message: `must be one of ${KNOWLEDGE_AUDIENCES.join('|')}` });
    const handling = pickEnum(raw.handling, KNOWLEDGE_HANDLINGS);
    if (!handling) issues.push({ field: 'handling', message: `must be one of ${KNOWLEDGE_HANDLINGS.join('|')}` });
    const evidenceState = pickEnum(raw.evidenceState, EVIDENCE_STATES);
    if (!evidenceState) issues.push({ field: 'evidenceState', message: `must be one of ${EVIDENCE_STATES.join('|')}` });
    const answerType = pickEnum(raw.answerType ?? 'fact', ANSWER_TYPES);
    if (!answerType) issues.push({ field: 'answerType', message: `must be one of ${ANSWER_TYPES.join('|')}` });
    const riskLevel = pickEnum(raw.riskLevel ?? 'normal', RISK_LEVELS);
    if (!riskLevel) issues.push({ field: 'riskLevel', message: `must be one of ${RISK_LEVELS.join('|')}` });
    const locale = asString(raw.locale) ?? 'ja-JP';
    const keywords = raw.keywords === undefined ? [] : asStringArray(raw.keywords);
    if (keywords === null) issues.push({ field: 'keywords', message: 'must be an array of strings' });
    if (!isRecord(raw.value)) issues.push({ field: 'value', message: 'must be an object' });

    const sourceRefs: SourceRef[] = [];
    const rawRefs = raw.sourceRefs ?? raw.sourceIds ?? [];
    if (!Array.isArray(rawRefs)) {
        issues.push({ field: 'sourceRefs', message: 'must be an array' });
    } else {
        for (const [index, ref] of rawRefs.entries()) {
            if (typeof ref === 'string') {
                sourceRefs.push({ sourceId: ref, locator: null, checkedOn: null });
            } else if (isRecord(ref) && asString(ref.sourceId)) {
                sourceRefs.push({
                    sourceId: asString(ref.sourceId) as string,
                    locator: asNullableString(ref.locator) ?? null,
                    checkedOn: asNullableString(ref.checkedOn) ?? null
                });
            } else {
                issues.push({ field: `sourceRefs[${index}]`, message: 'must be a source id or {sourceId, locator?, checkedOn?}' });
            }
        }
    }

    const validityRaw = isRecord(raw.validity) ? raw.validity : {};
    const validity: KnowledgeValidity = {
        effectiveFrom: asNullableString(validityRaw.effectiveFrom) ?? null,
        expiresAt: asNullableString(validityRaw.expiresAt) ?? null,
        nextReviewAt: asNullableString(validityRaw.nextReviewAt) ?? null
    };

    const answerJa = asNullableString(raw.answerJa) ?? null;
    const asOf = asNullableString(raw.asOf) ?? null;
    const checkedOn = asNullableString(raw.checkedOn) ?? null;
    const operatorNote = asNullableString(raw.operatorNote) ?? null;
    const reviewQuestion = asNullableString(raw.reviewQuestion) ?? null;

    if (issues.length > 0) return { ok: false, issues };
    return {
        ok: true,
        value: {
            key: key as string,
            title: title as string,
            category: category as KnowledgeCategory,
            locale,
            keywords: keywords as string[],
            audience: audience as KnowledgeAudience,
            handling: handling as KnowledgeHandling,
            riskLevel: riskLevel as RiskLevel,
            value: raw.value as Record<string, unknown>,
            answerJa,
            answerType: answerType as AnswerType,
            evidenceState: evidenceState as EvidenceState,
            sourceRefs,
            asOf,
            checkedOn,
            validity,
            operatorNote,
            reviewQuestion
        }
    };
}

// ---------------------------------------------------------------------------
// snake_case seed → camelCase converters (import path only)
// ---------------------------------------------------------------------------

/** Convert one seed item (`company_knowledge.seed.json` / manifest record)
 * into draft input + record fields. Unknown enums are rejected — a seed typo
 * must surface as an import error, not a silently wrong category. */
export function seedItemToDraft(raw: unknown): ValidationResult<{
    knowledgeId: string;
    revision: number;
    contentHash: string;
    synthetic: boolean;
    draft: KnowledgeDraftInput;
}> {
    if (!isRecord(raw)) return fail('item', 'must be an object');
    const knowledgeId = asString(raw.knowledge_id);
    if (!knowledgeId) return fail('knowledge_id', 'required');
    const revision = asInt(raw.revision);
    if (!revision || revision < 1) return fail('revision', 'must be a positive integer');
    const contentHash = asString(raw.content_hash);
    if (!contentHash) return fail('content_hash', 'required');

    const sourceIds = asStringArray(raw.source_ids) ?? [];
    const sourceLocator = asNullableString(raw.source_locator) ?? null;
    const checkedOn = asNullableString(raw.checked_on) ?? null;
    const sourceRefs = sourceIds.map((sourceId) => ({ sourceId, locator: sourceLocator, checkedOn }));

    const validityRaw = isRecord(raw.validity) ? raw.validity : {};
    const draftCandidate = {
        key: raw.key,
        title: raw.title,
        category: raw.category,
        locale: asString(raw.locale) ?? 'ja-JP',
        keywords: raw.keywords ?? [],
        audience: raw.audience,
        handling: raw.handling,
        riskLevel: raw.risk_level ?? 'normal',
        value: raw.value ?? {},
        answerJa: raw.answer_ja ?? null,
        answerType: raw.answer_type ?? 'fact',
        evidenceState: raw.evidence_state,
        sourceRefs,
        asOf: raw.as_of ?? null,
        checkedOn,
        validity: {
            effectiveFrom: validityRaw.effective_from ?? null,
            expiresAt: validityRaw.expires_at ?? null,
            nextReviewAt: null
        },
        operatorNote: raw.operator_note ?? null,
        reviewQuestion: raw.review_question ?? null
    };

    const validated = validateDraftInput(draftCandidate);
    if (!validated.ok) return validated as ValidationResult<never>;

    return {
        ok: true,
        value: {
            knowledgeId,
            revision,
            contentHash,
            synthetic: raw.synthetic === true,
            draft: validated.value
        }
    };
}

/** Convert a manifest `corKnowledgeSources` record to the stored shape. */
export function seedSourceToRecord(
    raw: unknown,
    meta: { createdBy: string; createdAt: string }
): ValidationResult<SourceRecord> {
    if (!isRecord(raw)) return fail('source', 'must be an object');
    const sourceId = asString(raw.source_id);
    if (!sourceId) return fail('source_id', 'required');
    const sourceType = pickEnum(raw.source_type, SOURCE_TYPES);
    if (!sourceType) return fail('source_type', `must be one of ${SOURCE_TYPES.join('|')}`);
    const title = asString(raw.title);
    if (!title) return fail('title', 'required');
    return {
        ok: true,
        value: {
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            sourceId,
            sourceType,
            title,
            url: asNullableString(raw.url) ?? null,
            publishedOn: asNullableString(raw.published_on) ?? null,
            checkedOn: asNullableString(raw.checked_on) ?? null,
            observation: asNullableString(raw.observation) ?? null,
            publicationCaveat: asNullableString(raw.publication_caveat) ?? null,
            recordVersion: 1,
            deletedAt: null,
            createdAt: meta.createdAt,
            createdBy: meta.createdBy,
            updatedAt: meta.createdAt,
            updatedBy: meta.createdBy
        }
    };
}

/** Convert a manifest `corKnowledgeReviews` record to the stored shape. */
export function seedReviewToRecord(
    raw: unknown,
    meta: { createdAt: string }
): ValidationResult<KnowledgeReview> {
    if (!isRecord(raw)) return fail('review', 'must be an object');
    const reviewId = asString(raw.review_id);
    if (!reviewId) return fail('review_id', 'required');
    const knowledgeId = asString(raw.knowledge_id);
    if (!knowledgeId) return fail('knowledge_id', 'required');
    const question = asString(raw.question);
    if (!question) return fail('question', 'required');
    const state = pickEnum(raw.state, REVIEW_STATES) ?? 'open';
    const priority = pickEnum(raw.priority, ['high', 'normal', 'low'] as const) ?? 'normal';
    return {
        ok: true,
        value: {
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            reviewId,
            knowledgeId,
            question,
            proposedOwnerRole: asNullableString(raw.proposed_owner_role) ?? null,
            state,
            priority,
            blockingScope: asNullableString(raw.blocking_scope) ?? null,
            resolvedValue: asNullableString(raw.resolved_value) ?? null,
            resolvedBy: asNullableString(raw.resolved_by) ?? null,
            resolvedAt: asNullableString(raw.resolved_at) ?? null,
            recordVersion: 1,
            createdAt: meta.createdAt,
            updatedAt: meta.createdAt
        }
    };
}
