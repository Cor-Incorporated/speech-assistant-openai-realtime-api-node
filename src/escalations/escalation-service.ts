// Escalation cases — durable record of a high-importance handoff to a
// responsible human. The key invariant: a sent notification is NOT
// acceptance. Only an authenticated subject's explicit acknowledge
// operation produces ACK evidence.

import { randomUUID } from 'node:crypto';
import { hasPermission, type Actor, type Permission } from '../admin/permissions.js';
import { ServiceError } from '../knowledge/knowledge-service.js';
import { VersionConflictError } from '../knowledge/repository.js';
import { memoryRecordPage } from '../pagination/record-page.js';

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

const ACCEPTED_STATES = new Set<EscalationState>(['acknowledged', 'connecting', 'connected', 'resolved']);
export const isAckOverdue = (record: EscalationCase, now: string): boolean =>
    !record.acknowledgedAt && !ACCEPTED_STATES.has(record.state) &&
    !!record.ackDeadlineAt && Date.parse(record.ackDeadlineAt) < Date.parse(now);

export interface EscalationListFilter {
    state?: EscalationState;
    unacknowledgedOnly?: boolean;
    overdueAt?: string;
    limit?: number;
    cursor?: string;
}

export const escalationMatchesFilter = (record: EscalationCase, filter: EscalationListFilter): boolean =>
    (!filter.state || record.state === filter.state) &&
    (!filter.unacknowledgedOnly || (!record.acknowledgedAt && !ACCEPTED_STATES.has(record.state))) &&
    (!filter.overdueAt || isAckOverdue(record, filter.overdueAt));
export const escalationPageScope = (filter: EscalationListFilter): string =>
    JSON.stringify(['escalations', filter.state ?? null, !!filter.unacknowledgedOnly, !!filter.overdueAt]);

export interface NotificationResult {
    ok: boolean;
    status?: string;
    id?: string;
    reason?: string;
    skipped?: boolean;
}

type Assignment = { ownerRole?: string | null; ownerSubject?: string | null; ackDeadlineAt?: string | null };
const validateAssignment = (input: Assignment) => {
    const errors: Record<string, string> = {};
    if (input.ownerRole != null && !['operator', 'supervisor'].includes(input.ownerRole)) errors.ownerRole = 'operator or supervisor required';
    if (input.ownerSubject != null && (typeof input.ownerSubject !== 'string' || !input.ownerSubject.trim() || input.ownerSubject.length > 200)) errors.ownerSubject = 'nonempty subject up to 200 characters required';
    if (input.ackDeadlineAt != null && (typeof input.ackDeadlineAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.ackDeadlineAt) ||
        !Number.isFinite(Date.parse(input.ackDeadlineAt)) || new Date(input.ackDeadlineAt).toISOString().replace('.000Z', 'Z') !== input.ackDeadlineAt.replace('.000Z', 'Z'))) {
        errors.ackDeadlineAt = 'valid UTC ISO timestamp required';
    }
    if (Object.keys(errors).length) throw new ServiceError(422, 'VALIDATION', 'invalid escalation assignment', errors);
};

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
    list(filter?: EscalationListFilter): Promise<{
        items: EscalationCase[];
        nextCursor: string | null;
        hasMore: boolean;
        partial?: boolean;
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

    async list(filter: EscalationListFilter = {}) {
        const result = memoryRecordPage([...this.cases.values()], {
            ...filter,
            scope: escalationPageScope(filter),
            position: (record) => ({ key: record.createdAt, id: record.caseId }),
            include: (record) => escalationMatchesFilter(record, filter)
        });
        return { ...result, items: result.items.map(clone) };
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
        ownerSubject?: string | null;
        ackDeadlineAt?: string | null;
        caseId?: string;
    }): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.assign', 'escalations.create');
        validateAssignment(input);
        if (!['normal', 'high', 'critical'].includes(input.importance) ||
            (input.urgency !== undefined && !['low', 'normal', 'high', 'critical', 'unknown'].includes(input.urgency))) {
            throw new ServiceError(422, 'VALIDATION', 'invalid escalation severity');
        }
        const now = this.clock.now();
        const record: EscalationCase = {
            schemaVersion: 1,
            caseId: input.caseId ?? `esc_${randomUUID()}`,
            callId: input.callId ?? null,
            importance: input.importance,
            urgency: input.urgency ?? 'unknown',
            summary: input.summary ?? null,
            state: input.ownerRole || input.ownerSubject ? 'assigned' : 'required',
            ownerRole: input.ownerRole ?? null,
            ownerSubject: input.ownerSubject ?? null,
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

    async assign(actor: Actor, caseId: string, args: Assignment & { expectedVersion?: number }): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.assign', 'escalations.assign');
        validateAssignment(args);
        const record = await this.mustGet(caseId);
        const now = this.clock.now();
        const updated: EscalationCase = {
            ...record,
            ownerRole: args.ownerRole !== undefined ? args.ownerRole : record.ownerRole,
            ownerSubject: args.ownerSubject !== undefined ? args.ownerSubject : record.ownerSubject,
            ackDeadlineAt: args.ackDeadlineAt !== undefined ? args.ackDeadlineAt : record.ackDeadlineAt,
            state: record.state,
            recordVersion: record.recordVersion + 1,
            updatedAt: now
        };
        if (record.state === 'required' || record.state === 'assigned') updated.state = updated.ownerRole || updated.ownerSubject ? 'assigned' : 'required';
        await this.repo.put(updated, args.expectedVersion ?? record.recordVersion);
        await this.audit(actor, caseId, 'escalation.assign', 'success', {});
        return updated;
    }

    /** Notification sent — recorded as evidence the request reached a
     * channel. This is NOT acceptance and never sets acknowledgedBy. */
    async markNotified(actor: Actor, caseId: string, expectedVersion?: number): Promise<EscalationCase> {
        requirePermission(actor, 'escalations.assign', 'escalations.notify');
        const record = await this.mustGet(caseId);
        if (record.notifiedAt) return record;
        const now = this.clock.now();
        const updated: EscalationCase = {
            ...record,
            state: record.state === 'required' || record.state === 'assigned' ? 'notified' : record.state,
            notifiedAt: now,
            recordVersion: record.recordVersion + 1,
            updatedAt: now
        };
        await this.repo.put(updated, expectedVersion ?? record.recordVersion);
        await this.audit(actor, caseId, 'escalation.notify', 'success', {});
        return updated;
    }

    async requestNotification(actor: Actor, caseId: string, deliver: ((record: EscalationCase, actor: Actor) => Promise<NotificationResult>) | null) {
        requirePermission(actor, 'escalations.assign', 'escalations.notify');
        const record = await this.mustGet(caseId);
        if (ACCEPTED_STATES.has(record.state)) return { escalation: record, notification: { ok: true, status: 'not_required' } };
        if (!deliver) return { escalation: record, notification: { ok: false, status: 'disabled', reason: 'disabled' } };
        let notification: NotificationResult;
        try {
            notification = await deliver(record, actor);
        } catch {
            return { escalation: record, notification: { ok: false, status: 'failed', reason: 'outbox_unavailable' } };
        }
        if (!notification.ok || notification.status !== 'accepted') return { escalation: record, notification };
        // A provider acceptance can race with ACK/assignment on another instance.
        // Re-read through CAS; a retry uses the same outbox key and never resends.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return { escalation: await this.markNotified(actor, caseId), notification };
            } catch (error) {
                if (!(error instanceof VersionConflictError) || attempt === 2) throw error;
            }
        }
        throw new Error('unreachable notification retry');
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
        if (ACCEPTED_STATES.has(record.state)) {
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
        if (typeof args.note !== 'string' || !args.note.trim()) throw new ServiceError(422, 'VALIDATION', 'resolution note is required', { note: 'required' });
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

    async get(actor: Actor, caseId: string): Promise<(EscalationCase & { ackOverdue: boolean }) | null> {
        requirePermission(actor, 'escalations.read', 'escalations.read');
        const record = await this.repo.get(caseId);
        return record ? { ...record, ackOverdue: isAckOverdue(record, this.clock.now()) } : null;
    }

    async list(actor: Actor, filter: Omit<EscalationListFilter, 'overdueAt'> & { overdueOnly?: boolean } = {}) {
        requirePermission(actor, 'escalations.read', 'escalations.list');
        const now = this.clock.now();
        if (filter.state && !ESCALATION_STATES.includes(filter.state)) throw new ServiceError(422, 'VALIDATION', 'invalid escalation state');
        if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 200)) throw new ServiceError(422, 'VALIDATION', 'limit must be an integer from 1 to 200');
        const result = await this.repo.list({ ...filter, ...(filter.overdueOnly ? { overdueAt: now } : {}) });
        return { ...result, items: result.items.map((record) => ({ ...record, ackOverdue: isAckOverdue(record, now) })) };
    }

    private async mustGet(caseId: string): Promise<EscalationCase> {
        const record = await this.repo.get(caseId);
        if (!record) throw new ServiceError(404, 'NOT_FOUND', `escalation ${caseId} not found`);
        return record;
    }
}
