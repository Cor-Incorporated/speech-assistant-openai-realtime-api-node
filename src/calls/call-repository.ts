// Call record persistence boundary — original observations, corrections,
// and audit events. Firestore implementation lives in
// firestore-call-repository.ts; the in-memory variant backs tests.

import type { CallCorrection, CallRecord } from './call-schemas.js';
import { VersionConflictError } from '../knowledge/repository.js';

export { VersionConflictError };

export class CallNotFoundError extends Error {
    readonly code = 'NOT_FOUND';
    readonly statusCode = 404;
    constructor(callId: string) {
        super(`call ${callId} not found`);
        this.name = 'CallNotFoundError';
    }
}

export interface ListCallsFilter {
    businessState?: string;
    origin?: string;
    includeDeleted?: boolean;
    severityMin?: 'low' | 'normal' | 'high' | 'critical';
    limit?: number;
    cursor?: string;
}

export interface ListCallsResult {
    items: CallRecord[];
    nextCursor: string | null;
    hasMore: boolean;
    /** Honest count semantics — a page window is never claimed as total. */
    partial: boolean;
}

export interface CallRepository {
    get(callId: string): Promise<CallRecord | null>;
    /** Insert only when absent — idempotent create. */
    createIfAbsent(record: CallRecord): Promise<{ created: boolean; record: CallRecord }>;
    put(record: CallRecord, expectedVersion?: number): Promise<CallRecord>;
    list(filter?: ListCallsFilter): Promise<ListCallsResult>;

    addCorrection(correction: CallCorrection): Promise<CallCorrection>;
    getCorrection(callId: string, correctionId: string): Promise<CallCorrection | null>;
    /** Update only mutable correction bookkeeping (active/supersededBy). */
    updateCorrectionFlags(correction: CallCorrection): Promise<CallCorrection>;
    listCorrections(callId: string): Promise<CallCorrection[]>;

    appendEvent(event: {
        eventId: string;
        callId: string | null;
        actor: string;
        action: string;
        result: string;
        metadata?: Record<string, unknown>;
        timestamp: string;
    }): Promise<void>;
    listEvents(callId: string): Promise<Array<Record<string, unknown>>>;

    /** Idempotency-Key → stored response reference. */
    getIdempotency(key: string): Promise<{ callId: string; bodyHash: string } | null>;
    putIdempotency(key: string, callId: string, bodyHash: string): Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SEVERITY_ORDER = ['low', 'normal', 'high', 'critical'] as const;

export class InMemoryCallRepository implements CallRepository {
    private readonly calls = new Map<string, CallRecord>();
    private readonly corrections = new Map<string, Map<string, CallCorrection>>();
    private readonly events = new Map<string, Array<Record<string, unknown>>>();
    private readonly idempotency = new Map<string, { callId: string; bodyHash: string }>();

    async get(callId: string): Promise<CallRecord | null> {
        const record = this.calls.get(callId);
        return record ? clone(record) : null;
    }

    async createIfAbsent(record: CallRecord): Promise<{ created: boolean; record: CallRecord }> {
        const existing = this.calls.get(record.callId);
        if (existing) return { created: false, record: clone(existing) };
        this.calls.set(record.callId, clone(record));
        return { created: true, record: clone(record) };
    }

    async put(record: CallRecord, expectedVersion?: number): Promise<CallRecord> {
        const existing = this.calls.get(record.callId);
        if (expectedVersion !== undefined && (existing?.recordVersion ?? 0) !== expectedVersion) {
            throw new VersionConflictError(
                `call ${record.callId}: expected version ${expectedVersion}, found ${existing?.recordVersion ?? 'none'}`
            );
        }
        this.calls.set(record.callId, clone(record));
        return clone(record);
    }

    async list(filter: ListCallsFilter = {}): Promise<ListCallsResult> {
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
        let items = [...this.calls.values()];
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
        items.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || a.callId.localeCompare(b.callId));

        const startIndex = filter.cursor
            ? items.findIndex((r) => r.callId === filter.cursor) + 1
            : 0;
        const start = startIndex > 0 ? startIndex : filter.cursor ? items.length : 0;
        const page = items.slice(start, start + limit);
        const hasMore = start + limit < items.length;
        return {
            items: page.map(clone),
            nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.callId : null,
            hasMore,
            partial: hasMore
        };
    }

    async addCorrection(correction: CallCorrection): Promise<CallCorrection> {
        let bucket = this.corrections.get(correction.callId);
        if (!bucket) {
            bucket = new Map();
            this.corrections.set(correction.callId, bucket);
        }
        if (bucket.has(correction.correctionId)) {
            throw new VersionConflictError(`correction ${correction.correctionId} already exists`);
        }
        bucket.set(correction.correctionId, clone(correction));
        return clone(correction);
    }

    async getCorrection(callId: string, correctionId: string): Promise<CallCorrection | null> {
        const record = this.corrections.get(callId)?.get(correctionId);
        return record ? clone(record) : null;
    }

    async updateCorrectionFlags(correction: CallCorrection): Promise<CallCorrection> {
        const bucket = this.corrections.get(correction.callId);
        const stored = bucket?.get(correction.correctionId);
        if (!stored) throw new CallNotFoundError(correction.callId);
        const updated: CallCorrection = {
            ...stored,
            active: correction.active,
            supersededBy: correction.supersededBy
        };
        bucket!.set(correction.correctionId, clone(updated));
        return clone(updated);
    }

    async listCorrections(callId: string): Promise<CallCorrection[]> {
        return [...(this.corrections.get(callId)?.values() ?? [])]
            .map(clone)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
        const key = event.callId ?? '_global';
        let bucket = this.events.get(key);
        if (!bucket) {
            bucket = [];
            this.events.set(key, bucket);
        }
        bucket.push(clone(event));
    }

    async listEvents(callId: string): Promise<Array<Record<string, unknown>>> {
        return (this.events.get(callId) ?? []).map(clone);
    }

    async getIdempotency(key: string): Promise<{ callId: string; bodyHash: string } | null> {
        const entry = this.idempotency.get(key);
        return entry ? { ...entry } : null;
    }

    async putIdempotency(key: string, callId: string, bodyHash: string): Promise<void> {
        this.idempotency.set(key, { callId, bodyHash });
    }
}
