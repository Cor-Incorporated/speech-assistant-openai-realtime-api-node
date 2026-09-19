// Admin v2 wire types — keep in sync with src/*/schemas.ts.

export type KnowledgeState = 'draft' | 'in_review' | 'approved' | 'published' | 'withdrawn' | 'rejected';

export interface KnowledgeRecord {
    knowledgeId: string;
    key: string;
    title: string;
    category: string;
    locale: string;
    keywords: string[];
    audience: 'public' | 'admin_only';
    handling: string;
    riskLevel: string;
    state: KnowledgeState;
    draftRevision: number | null;
    publishedRevision: number | null;
    recordVersion: number;
    deletedAt: string | null;
    updatedAt: string;
    updatedBy: string;
}

export interface KnowledgeRevision {
    revision: number;
    contentHash: string;
    value: Record<string, unknown>;
    answerJa: string;
    answerType: string;
    evidenceState: string;
    sourceRefs: Array<{ sourceId: string }>;
    asOf: string | null;
    validity: { effectiveFrom: string | null; expiresAt: string | null; nextReviewAt?: string | null };
    approval: { approvedBy: string | null; approvedAt: string | null; reason: string | null; revision: number | null; contentHash: string | null };
    operatorNote?: string | null;
    reviewQuestion?: string | null;
    createdAt: string;
    createdBy: string;
}

export interface CallRecord {
    callId: string;
    origin: string;
    startedAt: string;
    endedAt: string | null;
    fromNumberMasked: string | null;
    severity: { importance: string; urgency?: string };
    ops: { status: string; assignee?: string | null; callbackStatus?: string | null; needsReview?: boolean; tags?: string[] };
    effective: {
        callerName?: string | null;
        callerNameKana?: string | null;
        callbackNumber?: string | null;
        memo?: string | null;
        summary?: string | null;
    };
    extraction?: Record<string, unknown>;
    recordVersion: number;
    deletedAt: string | null;
    updatedAt: string;
}

export interface CallCorrection {
    correctionId: string;
    callId: string;
    field: string;
    previousValue: unknown;
    correctedValue: unknown;
    reason: string;
    correctedBy: string;
    createdAt: string;
    active: boolean;
    supersededBy: string | null;
}

export interface EscalationCase {
    caseId: string;
    callId: string | null;
    importance: string;
    urgency: string;
    summary: string | null;
    state: 'required' | 'assigned' | 'notified' | 'acknowledged' | 'connecting' | 'connected' | 'unavailable' | 'resolved';
    ownerRole: string | null;
    ownerSubject: string | null;
    ackDeadlineAt: string | null;
    notifiedAt: string | null;
    acknowledgedBy: string | null;
    acknowledgedAt: string | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
    recordVersion: number;
    createdAt: string;
}

export interface SourceRecord {
    sourceId: string;
    sourceType: string;
    title: string;
    url: string | null;
    observation: string | null;
    publicationCaveat: string | null;
    recordVersion: number;
    deletedAt: string | null;
}

export interface KnowledgeReview {
    reviewId: string;
    knowledgeId: string;
    state: string;
    question: string;
    resolvedValue: unknown;
    recordVersion: number;
    createdAt: string;
}

export interface Release {
    releaseId: string;
    createdAt: string;
    createdBy: string;
    itemCount?: number;
    manifestHash?: string;
}

export interface StatusResponse {
    actor: { subject: string; roles: string[]; sharedAccount: boolean };
    knowledge: { total: number; currentReleaseId: string | null; revocationEpoch: number; byState: Record<string, number> };
    voiceProvider: string;
    routingProvider: string;
}

export interface ListResult<T> {
    items: T[];
    nextCursor: string | null;
    hasMore?: boolean;
    partial?: boolean;
}
