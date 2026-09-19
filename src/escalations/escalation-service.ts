// Escalation cases — durable record of a high-importance handoff to a
// responsible human. The key invariant: a sent notification is NOT
// acceptance. Only an authenticated subject's explicit acknowledge
// operation produces ACK evidence.

import { randomUUID } from 'node:crypto';
import { hasPermission, type Actor, type Permission } from '../admin/permissions.js';
import { ServiceError } from '../knowledge/knowledge-service.js';
import { VersionConflictError } from '../knowledge/repository.js';

export { ServiceError, VersionConflictError };

export const ESCALATION_STATES = [
    'required',     // created, no owner yet
    'assigned',     // owner assigned, not yet notified/acked
    'notified',     // notification sent — still NOT accepted
    'acknowledged', // a specific authenticated subject accepted
    'connecting',
    'connected',
    'unavailable',  // owner unreachable — needs fallback, not resolved
    'resolved'
] as const;
export type EscalationState = (typeof ESCALATION_STATES)[number];

export interface EscalationCase {
    schemaVersion: number;
    caseId: string;
    callId: string | null;
    importance: 'normal' | 'high' | 'critical';
    urgency: 'low' | 'normal' | 'high' | 'critical' | 'unknown';
    summary: string | null;
    state: EscalationState;
    ownerRole: string | null;
    ownerSubject: string | null;
    ackDeadlineAt: string | null;
    notifiedAt: string | null;
    acknowledgedBy: string | null;
    acknowledgedAt: string | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
    resolutionNote: string | null;
    recordVersion: number;
    createdAt: string;
    updatedAt: string;
}

export interface EscalationRepository {
    get(caseId: string): Promise<EscalationCase | null>;
    createIfAbsent(record: EscalationCase): Promise<{ created: boolean; record: EscalationCase }>;
    put(record: EscalationCase, expectedVersion?: number): Promise<EscalationCase>;
    list(filter?: { state?: EscalationState; unacknowledgedOnly?: boolean; limit?: number; cursor?: string }): Promise<{
        items: EscalationCase[];
        nextCursor: string | null;
        hasMore: boolean;
    }>;
    appendEvent(event: {
        eventId: string;
        caseId: string;
        actor: string;
        action: string;
        result: string;
        metadata?: Record<string, unknown>;
        timestamp: string;
    }): Promise<void>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class InMemoryEscalationRepository implements EscalationRepository {
    private readonly cases = new Map<string, EscalationCase>();
    private readonly events: Array<Record<string, unknown>> = [];

    async get(caseId: string): Promise<EscalationCase | null> {
        const found = this.cases.get(caseId);
        return found ? clone(found) : null;
    }

    async createIfAbsent(record: EscalationCase): Promise<{ created: boolean; record: EscalationCase }> {
        const existing = this.cases.get(record.caseId);
        if (existing) return { created: false, record: clone(existing) };
        this.cases.set(record.caseId, clone(record));
        return { created: true, record: clone(record) };
    }

    async put(record: EscalationCase, expectedVersion?: number): Promise<EscalationCase> {
        const existing = this.cases.get(record.caseId);
        if (expectedVersion !== undefined && (existing?.recordVersion ?? 0) !== expectedVersion) {
            throw new VersionConflictError(`escalation ${record.caseId}: expected ${expectedVersion}`);
        }
        this.cases.set(record.caseId, clone(record));
        return clone(record);
    }

    async list(filter: { state?: EscalationState; unacknowledgedOnly?: boolean; limit?: number; cursor?: string } = {}) {
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
        let items = [...this.cases.values()];
        if (filter.state) items = items.filter((c) => c.state === filter.state);
        if (filter.unacknowledgedOnly) {
            items = items.filter((c) => c.state !== 'acknowledged' && c.state !== 'resolved' && c.state !== 'connected');
        }
        items.sort((a, b) => {
            // Unacknowledged critical first, then by creation.
            const aScore = (a.state === 'acknowledged' || a.state === 'resolved' ? 1 : 0);
            const bScore = (b.state === 'acknowledged' || b.state === 'resolved' ? 1 : 0);
            return aScore - bScore || b.createdAt.localeCompare(a.createdAt);
        });
        const startIndex = filter.cursor ? items.findIndex((c) => c.caseId === filter.cursor) + 1 : 0;
        const start = startIndex > 0 ? startIndex : filter.cursor ? items.length : 0;
        const page = items.slice(start, start + limit);
        const hasMore = start + limit < items.length;
        return {
            items: page.map(clone),
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
        this.events.push(clone(event));
    }

    getEvents(): Array<Record<string, unknown>> {
        return clone(this.events);
    }
}

const requirePermission = (actor: Actor, permission: Permission, action: string): void => {
    if (!hasPermission(actor, permission)) {
        throw new ServiceError(403, 'FORBIDDEN', `missing permission for ${action}`);
    }
};

export class EscalationService {
    constructor(
        private readonly repo: EscalationRepository,
        private readonly clock: { now(): string } = { now: () => new Date().toISOString() }
    ) {}

    private async audit(actor: Actor, caseId: string, action: string, result: string, metadata?: Record<string, unknown>) {
        await this.repo.appendEvent({
            eventId: `esc_${randomUUID()}`,
            caseId,
            actor: actor.subject,
            action,
            result,
            ...(metadata ? { metadata } : {}),
            timestamp: this.clock.now()
        });
    }

    async create(actor: Actor, input: {
        callId?: string | null;
        importance: 'normal' | 'high' | 'critical';
        urgency?: 'low' | 'normal' | 'high' | 'critical' | 'unknown';
        summary?: string | null;
        ownerRole?: string | null;
        ackDeadlineAt?: string | null;
        caseId?: string;
    }): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.assign', 'escalations.create');
        const now = this.clock.now();
        const record: EscalationCase = {
            schemaVersion: 1,
            caseId: input.caseId ?? `esc_${randomUUID()}`,
            callId: input.callId ?? null,
            importance: input.importance,
            urgency: input.urgency ?? 'unknown',
            summary: input.summary ?? null,
            state: input.ownerRole || input.ackDeadlineAt ? 'assigned' : 'required',
            ownerRole: input.ownerRole ?? null,
            ownerSubject: null,
            ackDeadlineAt: input.ackDeadlineAt ?? null,
            notifiedAt: null,
            acknowledgedBy: null,
            acknowledgedAt: null,
            resolvedBy: null,
            resolvedAt: null,
            resolutionNote: null,
            recordVersion: 1,
            createdAt: now,
            updatedAt: now
        };
        const { created, record: stored } = await this.repo.createIfAbsent(record);
        if (!created) throw new ServiceError(409, 'ALREADY_EXISTS', `escalation ${record.caseId} already exists`);
        await this.audit(actor, stored.caseId, 'escalation.create', 'success', { importance: record.importance });
        return stored;
    }

    async assign(actor: Actor, caseId: string, args: { ownerRole?: string; ownerSubject?: string; ackDeadlineAt?: string; expectedVersion?: number }): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.assign', 'escalations.assign');
        const record = await this.mustGet(caseId);
        const now = this.clock.now();
        const updated: EscalationCase = {
            ...record,
            ownerRole: args.ownerRole !== undefined ? args.ownerRole : record.ownerRole,
            ownerSubject: args.ownerSubject !== undefined ? args.ownerSubject : record.ownerSubject,
            ackDeadlineAt: args.ackDeadlineAt !== undefined ? args.ackDeadlineAt : record.ackDeadlineAt,
            state: record.state === 'required' ? 'assigned' : record.state,
            recordVersion: record.recordVersion + 1,
            updatedAt: now
        };
        await this.repo.put(updated, args.expectedVersion ?? record.recordVersion);
        await this.audit(actor, caseId, 'escalation.assign', 'success', {});
        return updated;
    }

    /** Notification sent — recorded as evidence the request reached a
     * channel. This is NOT acceptance and never sets acknowledgedBy. */
    async markNotified(actor: Actor, caseId: string, expectedVersion?: number): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.assign', 'escalations.notify');
        const record = await this.mustGet(caseId);
        const now = this.clock.now();
        const updated: EscalationCase = {
            ...record,
            state: record.state === 'acknowledged' || record.state === 'resolved' ? record.state : 'notified',
            notifiedAt: now,
            recordVersion: record.recordVersion + 1,
            updatedAt: now
        };
        await this.repo.put(updated, expectedVersion ?? record.recordVersion);
        await this.audit(actor, caseId, 'escalation.notify', 'success', {});
        return updated;
    }

    /** ACK is bound to the authenticated subject performing the action —
     * writing a name into a field, a DialCallStatus=completed, or a sent
     * email can never impersonate it. */
    async acknowledge(actor: Actor, caseId: string, expectedVersion?: number): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.acknowledge', 'escalations.acknowledge');
        if (actor.sharedAccount) {
            throw new ServiceError(403, 'SHARED_ACCOUNT', 'acknowledgement requires an individually attributable subject');
        }
        const record = await this.mustGet(caseId);
        if (record.state === 'acknowledged' || record.state === 'resolved') {
            return record; // idempotent — already accepted
        }
        const now = this.clock.now();
        const updated: EscalationCase = {
            ...record,
            state: 'acknowledged',
            acknowledgedBy: actor.subject,
            acknowledgedAt: now,
            recordVersion: record.recordVersion + 1,
            updatedAt: now
        };
        await this.repo.put(updated, expectedVersion ?? record.recordVersion);
        await this.audit(actor, caseId, 'escalation.acknowledge', 'success', { acknowledgedBy: actor.subject });
        return updated;
    }

    async resolve(actor: Actor, caseId: string, args: { note: string; expectedVersion?: number }): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.resolve', 'escalations.resolve');
        const record = await this.mustGet(caseId);
        const now = this.clock.now();
        const updated: EscalationCase = {
            ...record,
            state: 'resolved',
            resolvedBy: actor.subject,
            resolvedAt: now,
            resolutionNote: args.note,
            recordVersion: record.recordVersion + 1,
            updatedAt: now
        };
        await this.repo.put(updated, args.expectedVersion ?? record.recordVersion);
        await this.audit(actor, caseId, 'escalation.resolve', 'success', {});
        return updated;
    }

    async get(actor: Actor, caseId: string): Promise<EscalationCase | null> {
        requirePermission(actor, 'escalations.read', 'escalations.read');
        return this.repo.get(caseId);
    }

    async list(actor: Actor, filter: { state?: EscalationState; unacknowledgedOnly?: boolean; limit?: number; cursor?: string } = {}) {
        requirePermission(actor, 'escalations.read', 'escalations.list');
        return this.repo.list(filter);
    }

    private async mustGet(caseId: string): Promise<EscalationCase> {
        const record = await this.repo.get(caseId);
        if (!record) throw new ServiceError(404, 'NOT_FOUND', `escalation ${caseId} not found`);
        return record;
    }
}
