// Call record service — manual create, effective-field corrections,
// soft-delete/restore, idempotent create. Provider-observed fields are
// never mutable through this path; humans correct via correction records.

import { createHash, randomUUID } from 'node:crypto';
import { hasPermission, type Actor, type Permission } from '../admin/permissions.js';
import type { CallRepository, ListCallsFilter, ListCallsResult } from './call-repository.js';
import { CallNotFoundError, VersionConflictError } from './call-repository.js';
import {
    CALL_SCHEMA_VERSION,
    validateCallPatch,
    validateManualCallInput,
    type CallCorrection,
    type CallPatchInput,
    type CallRecord,
    type ManualCallInput
} from './call-schemas.js';
import { ServiceError } from '../knowledge/knowledge-service.js';

export { ServiceError, CallNotFoundError, VersionConflictError };

const requirePermission = (actor: Actor, permission: Permission, action: string): void => {
    if (!hasPermission(actor, permission)) {
        throw new ServiceError(403, 'FORBIDDEN', `missing permission for ${action}`);
    }
};

const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

const bodyHash = (value: unknown): string =>
    createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

export interface Clock {
    now(): string;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

export class CallService {
    constructor(
        private readonly repo: CallRepository,
        private readonly clock: Clock = systemClock
    ) {}

    private async audit(actor: Actor, callId: string | null, action: string, result: string, metadata?: Record<string, unknown>) {
        await this.repo.appendEvent({
            eventId: `evt_${randomUUID()}`,
            callId,
            actor: actor.subject,
            action,
            result,
            ...(metadata ? { metadata } : {}),
            timestamp: this.clock.now()
        });
    }

    // ------------------------------------------------------------------
    // Create — manual reception records only. Idempotency-Key makes a
    // double submit produce one record; a different body under the same
    // key is a 409, never a silent second record.
    // ------------------------------------------------------------------

    async createManual(
        actor: Actor,
        rawInput: unknown,
        options: { idempotencyKey?: string; callId?: string } = {}
    ): Promise<{ record: CallRecord; replayed: boolean }> {
        requirePermission(actor, 'calls.create_manual', 'calls.create');
        const validated = validateManualCallInput(rawInput);
        if (!validated.ok) {
            throw new ServiceError(
                422,
                'VALIDATION',
                'invalid manual call record',
                Object.fromEntries(validated.issues.map((i) => [i.field, i.message]))
            );
        }
        const input = validated.value;
        const hash = bodyHash(input);

        if (options.idempotencyKey) {
            const prior = await this.repo.getIdempotency(options.idempotencyKey);
            if (prior) {
                if (prior.bodyHash !== hash) {
                    throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different body');
                }
                const existing = await this.repo.get(prior.callId);
                if (existing) return { record: existing, replayed: true };
            }
        }

        const now = this.clock.now();
        const record: CallRecord = {
            schemaVersion: CALL_SCHEMA_VERSION,
            callId: options.callId ?? `manual_${randomUUID()}`,
            origin: 'manual',
            providerCallSid: null,
            transportState: 'unknown',
            startedAt: input.declaredAt ?? now,
            endedAt: null,
            durationSeconds: null,
            fromNumberMasked: null,
            toNumberMasked: null,
            extraction: {},
            effective: {
                summary: input.summary,
                callerName: input.callerName,
                callerNameKana: input.callerNameKana,
                callbackNumber: input.contact,
                callbackRequestedWindow: input.callbackRequestedWindow,
                intent: input.intent,
                memo: input.memo
            },
            ops: {
                status: 'new',
                assignee: input.assignee,
                callbackStatus: input.contact || input.callbackRequestedWindow ? 'pending' : null,
                needsReview: false,
                tags: []
            },
            severity: {
                urgency: 'unknown',
                importance: input.severity,
                humanRequested: false,
                riskKinds: [],
                basis: 'manual_entry'
            },
            humanCase: {
                state: 'none',
                caseId: null,
                notifiedAt: null,
                acknowledgedBy: null,
                acknowledgedAt: null
            },
            recordVersion: 1,
            deletedAt: null,
            deletedBy: null,
            deletionReason: null,
            hold: false,
            createdAt: now,
            createdBy: actor.subject,
            updatedAt: now,
            updatedBy: actor.subject
        };

        const { created, record: stored } = await this.repo.createIfAbsent(record);
        if (!created) {
            throw new ServiceError(409, 'ALREADY_EXISTS', `call ${record.callId} already exists`);
        }
        if (options.idempotencyKey) {
            await this.repo.putIdempotency(options.idempotencyKey, stored.callId, hash);
        }
        await this.audit(actor, stored.callId, 'call.create_manual', 'success', {});
        return { record: stored, replayed: false };
    }

    // ------------------------------------------------------------------
    // Read — permission-scoped projections
    // ------------------------------------------------------------------

    async get(actor: Actor, callId: string, options: { includeDeleted?: boolean } = {}): Promise<CallRecord | null> {
        requirePermission(actor, 'calls.read', 'calls.read');
        const record = await this.repo.get(callId);
        if (!record || (record.deletedAt && !options.includeDeleted)) return null;
        return record;
    }

    async list(actor: Actor, filter: ListCallsFilter = {}): Promise<ListCallsResult> {
        requirePermission(actor, 'calls.read', 'calls.list');
        return this.repo.list(filter);
    }

    async listCorrections(actor: Actor, callId: string): Promise<CallCorrection[]> {
        requirePermission(actor, 'calls.read', 'calls.corrections');
        await this.mustGet(callId, { includeDeleted: true });
        return this.repo.listCorrections(callId);
    }

    async listEvents(actor: Actor, callId: string): Promise<Array<Record<string, unknown>>> {
        requirePermission(actor, 'calls.read', 'calls.events');
        return this.repo.listEvents(callId);
    }

    // ------------------------------------------------------------------
    // Patch — effective/ops fields only, with mandatory reason and
    // optimistic locking. Every applied change also lands as a correction
    // record so the audit trail shows who changed what from what.
    // ------------------------------------------------------------------

    async patch(
        actor: Actor,
        callId: string,
        rawPatch: unknown,
        expectedVersion?: number
    ): Promise<CallRecord> {
        requirePermission(actor, 'calls.correct', 'calls.update');
        const validated = validateCallPatch(rawPatch);
        if (!validated.ok) {
            throw new ServiceError(
                422,
                'VALIDATION',
                'invalid call patch',
                Object.fromEntries(validated.issues.map((i) => [i.field, i.message]))
            );
        }
        const patch = validated.value;
        const record = await this.mustGet(callId);
        if (record.deletedAt) throw new ServiceError(409, 'DELETED', `call ${callId} is deleted`);

        const now = this.clock.now();
        const corrections: CallCorrection[] = [];
        const effective = { ...record.effective };
        if (patch.effective) {
            for (const [key, value] of Object.entries(patch.effective)) {
                if (value === undefined) continue;
                const previous = (effective as Record<string, unknown>)[key];
                if (previous === value) continue;
                corrections.push(this.buildCorrection(record, key as CallCorrection['target'], null, previous, value, patch.changeReason, actor));
                (effective as Record<string, unknown>)[key] = value;
            }
        }

        const ops = { ...record.ops };
        if (patch.ops) {
            for (const [key, value] of Object.entries(patch.ops)) {
                if (value === undefined) continue;
                const previous = (ops as Record<string, unknown>)[key];
                if (JSON.stringify(previous) === JSON.stringify(value)) continue;
                corrections.push(this.buildCorrection(record, 'ops', key, previous, value, patch.changeReason, actor));
                (ops as Record<string, unknown>)[key] = value;
            }
        }

        const severity = { ...record.severity };
        if (patch.severityRaise) {
            requirePermission(actor, 'calls.severity.raise', 'calls.severity.raise');
            const order = ['low', 'normal', 'high', 'critical'] as const;
            const currentIdx = order.indexOf(severity.importance as typeof order[number]);
            const nextIdx = order.indexOf(patch.severityRaise);
            if (nextIdx > currentIdx || severity.importance === 'unknown') {
                corrections.push(this.buildCorrection(record, 'ops', 'severity.importance', severity.importance, patch.severityRaise, patch.changeReason, actor));
                severity.importance = patch.severityRaise;
            }
        }

        const updated: CallRecord = {
            ...record,
            effective,
            ops,
            severity,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };
        await this.repo.put(updated, expectedVersion ?? record.recordVersion);
        for (const correction of corrections) {
            await this.repo.addCorrection(correction);
        }
        await this.audit(actor, callId, 'call.patch', 'success', {
            fields: corrections.map((c) => `${c.target}${c.targetRef ? `.${c.targetRef}` : ''}`),
            version: updated.recordVersion
        });
        return updated;
    }

    private buildCorrection(
        record: CallRecord,
        target: CallCorrection['target'],
        targetRef: string | null,
        previousValue: unknown,
        newValue: unknown,
        reason: string,
        actor: Actor
    ): CallCorrection {
        return {
            schemaVersion: CALL_SCHEMA_VERSION,
            correctionId: `cor_${randomUUID()}`,
            callId: record.callId,
            target,
            targetRef,
            previousValue,
            newValue,
            reason,
            baseVersion: record.recordVersion,
            active: true,
            supersededBy: null,
            createdAt: this.clock.now(),
            createdBy: actor.subject
        };
    }

    // ------------------------------------------------------------------
    // Correction reversal — the correction is deactivated, the prior value
    // restored, and a new correction records the reversal. The raw event
    // was never touched either way.
    // ------------------------------------------------------------------

    async revertCorrection(
        actor: Actor,
        callId: string,
        correctionId: string,
        args: { reason: string; expectedVersion?: number }
    ): Promise<CallRecord> {
        requirePermission(actor, 'calls.correct', 'calls.correction_revert');
        if (!args.reason?.trim()) {
            throw new ServiceError(422, 'VALIDATION', 'revert reason is required', { reason: 'required' });
        }
        const record = await this.mustGet(callId, { includeDeleted: true });
        const correction = await this.repo.getCorrection(callId, correctionId);
        if (!correction || !correction.active) {
            throw new ServiceError(404, 'NOT_FOUND', `correction ${correctionId} not found or already reverted`);
        }

        const effective = { ...record.effective };
        const ops = { ...record.ops };
        if (correction.target === 'ops' && correction.targetRef) {
            (ops as Record<string, unknown>)[correction.targetRef] = correction.previousValue;
        } else if (correction.target !== 'transcriptTurn' && correction.target !== 'ops') {
            (effective as Record<string, unknown>)[correction.target] = correction.previousValue;
        }

        const now = this.clock.now();
        const reversal = this.buildCorrection(record, correction.target, correction.targetRef, correction.newValue, correction.previousValue, `revert: ${args.reason}`, actor);
        const updated: CallRecord = {
            ...record,
            effective,
            ops,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };
        await this.repo.put(updated, args.expectedVersion ?? record.recordVersion);
        await this.repo.updateCorrectionFlags({ ...correction, active: false, supersededBy: reversal.correctionId });
        await this.repo.addCorrection(reversal);
        await this.audit(actor, callId, 'call.correction_revert', 'success', { correctionId });
        return updated;
    }

    // ------------------------------------------------------------------
    // Delete / restore — soft-delete with guards; restore never replays
    // external side effects (no call, no notification, no republish).
    // ------------------------------------------------------------------

    async softDelete(actor: Actor, callId: string, args: { reason: string; expectedVersion?: number }): Promise<CallRecord> {
        requirePermission(actor, 'calls.delete', 'calls.delete');
        if (!args.reason?.trim()) {
            throw new ServiceError(422, 'VALIDATION', 'deletion reason is required', { reason: 'required' });
        }
        const record = await this.mustGet(callId);
        if (record.deletedAt) throw new ServiceError(409, 'ALREADY_DELETED', `call ${callId} is already deleted`);
        if (record.hold) {
            throw new ServiceError(409, 'ON_HOLD', `call ${callId} is under a retention hold — supervisor procedure required`);
        }
        if (record.transportState === 'connected') {
            throw new ServiceError(409, 'CALL_ACTIVE', `call ${callId} is still connected`);
        }
        if (record.humanCase.state === 'required' || record.humanCase.state === 'notified') {
            throw new ServiceError(409, 'OPEN_ESCALATION', `call ${callId} has an unacknowledged escalation — resolve it first`);
        }
        const now = this.clock.now();
        const updated: CallRecord = {
            ...record,
            deletedAt: now,
            deletedBy: actor.subject,
            deletionReason: args.reason,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };
        await this.repo.put(updated, args.expectedVersion ?? record.recordVersion);
        await this.audit(actor, callId, 'call.delete', 'success', { reason: args.reason });
        return updated;
    }

    async restore(actor: Actor, callId: string, expectedVersion?: number): Promise<CallRecord> {
        requirePermission(actor, 'calls.restore', 'calls.restore');
        const record = await this.mustGet(callId, { includeDeleted: true });
        if (!record.deletedAt) throw new ServiceError(409, 'NOT_DELETED', `call ${callId} is not deleted`);
        const now = this.clock.now();
        const updated: CallRecord = {
            ...record,
            deletedAt: null,
            deletedBy: null,
            deletionReason: null,
            recordVersion: record.recordVersion + 1,
            updatedAt: now,
            updatedBy: actor.subject
        };
        await this.repo.put(updated, expectedVersion ?? record.recordVersion);
        await this.audit(actor, callId, 'call.restore', 'success', {});
        return updated;
    }

    private async mustGet(callId: string, options: { includeDeleted?: boolean } = {}): Promise<CallRecord> {
        const record = await this.repo.get(callId);
        if (!record || (record.deletedAt && !options.includeDeleted)) {
            throw new CallNotFoundError(callId);
        }
        return record;
    }
}
