// Provider-call projection — turns a completed Twilio/Live/Realtime call
// into the admin v2 CallRecord and (when warranted) an EscalationCase.
//
// REVIEW-R09: production calls previously only reached the legacy callLogs
// collection; callLogsV2 stayed empty so correction/restore/escalation
// workflows could never apply to real calls. This projector runs at stream
// start and at call end, is idempotent on repeated close events, and keeps
// notification ≠ acknowledgement (notification marks the case 'notified',
// ACK still requires an authenticated human action).

import { randomUUID } from 'node:crypto';
import type { CallRepository } from './call-repository.js';
import {
    CALL_SCHEMA_VERSION,
    type CallRecord,
    type TransportState
} from './call-schemas.js';
import type { EscalationRepository, EscalationCase } from '../escalations/escalation-service.js';

const SYSTEM_ACTOR = 'system:call-projection';

/** Firestore rejects `undefined` values outright — strip them recursively so
 * a missing optional field degrades to absence, never to a write failure
 * (RECHECK-RR01). */
const dropUndefined = <T>(value: T): T => {
    if (Array.isArray(value)) {
        return value.map((entry) => dropUndefined(entry)) as T;
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (entry === undefined) continue;
            out[key] = dropUndefined(entry);
        }
        return out as T;
    }
    return value;
};

/** Terminal transport states must never regress to a pre-terminal one —
 * a late duplicate "start" projection cannot reopen an ended call
 * (RECHECK-RR07/N07). */
const TERMINAL_TRANSPORT_STATES: ReadonlySet<TransportState> = new Set(['ended', 'failed']);

export interface ProviderCallProjection {
    /** Provider call id — used as the v2 callId so the same call projects once. */
    callId: string;
    streamSid?: string | null;
    transportState: TransportState;
    startedAt: string | null;
    endedAt: string | null;
    durationSeconds: number | null;
    /** Already masked — never store raw caller numbers here. */
    fromNumberMasked: string | null;
    toNumberMasked: string | null;
    extraction?: {
        summary?: string | null;
        callerName?: string | null;
        callbackNumber?: string | null;
        callbackRequestedWindow?: string | null;
        intent?: string | null;
        memo?: string | null;
        model?: string;
        extractedAt?: string;
    } | null;
    callbackRequired: boolean;
    /** Outcome classification for ops.status. */
    outcome: 'completed' | 'abandoned' | 'failed' | 'transferred';
    severity?: {
        urgency?: 'low' | 'normal' | 'high' | 'critical' | 'unknown';
        importance?: 'low' | 'normal' | 'high' | 'critical';
        humanRequested?: boolean;
        riskKinds?: string[];
        basis?: string | null;
    };
    /** Handoff/escalation request facts. */
    handoff?: {
        requested: boolean;
        destination: string | null;
        outcome: 'connected' | 'rejected' | 'timeout' | 'failed' | 'declined' | null;
        reason?: string | null;
    };
    /** Knowledge release ids that answered during the call. */
    knowledgeReleaseIds?: string[];
    /** True once the summary notification was queued — notification ≠ ACK. */
    notificationSent?: boolean;
    error?: string | null;
    now?: () => string;
}

/** The effective-fields value the projector itself would derive from an
 * extraction — used to tell projector-written values apart from human
 * edits so a late extraction can still populate untouched fields while a
 * human correction is never overwritten (RECHECK-RR07/N04). */
const projectedEffective = (extraction: ProviderCallProjection['extraction']) => ({
    summary: extraction?.summary ?? null,
    callerName: extraction?.callerName ?? null,
    callerNameKana: null,
    callbackNumber: extraction?.callbackNumber ?? null,
    callbackRequestedWindow: extraction?.callbackRequestedWindow ?? null,
    intent: extraction?.intent ?? null,
    memo: null
});

const EFFECTIVE_KEYS = [
    'summary',
    'callerName',
    'callerNameKana',
    'callbackNumber',
    'callbackRequestedWindow',
    'intent',
    'memo'
] as const;

/** Field-level merge of the human-editable effective record.
 *
 * A field still equal to what the PREVIOUS projection derived is untouched
 * — the new extraction may fill it. Any divergence is a human edit and is
 * preserved verbatim. A projection that carries no extraction at all never
 * erases stored values (ACCEPT-T03: a late "start" must not blank the
 * summary an earlier "end" already wrote — B03; editing one field mid-call
 * must not freeze the others — B04). */
const mergeEffective = (
    existing: CallRecord | null,
    extraction: ProviderCallProjection['extraction']
): CallRecord['effective'] => {
    if (!existing) return projectedEffective(extraction);
    const previous = projectedEffective(existing.extraction ?? null);
    const incoming = extraction ? projectedEffective(extraction) : null;
    const effective = { ...existing.effective };
    for (const key of EFFECTIVE_KEYS) {
        if (existing.effective[key] === previous[key] && incoming) {
            effective[key] = incoming[key];
        }
    }
    return effective;
};

const mergeRecord = (
    existing: CallRecord | null,
    input: ProviderCallProjection,
    now: string
): CallRecord => {
    const extraction = input.extraction ?? null;
    const escalated = input.handoff?.requested === true
        || input.severity?.importance === 'high'
        || input.severity?.importance === 'critical';

    const status =
        input.outcome === 'transferred' ? 'done'
            : input.callbackRequired ? 'needs_callback'
                : input.outcome === 'completed' ? 'done'
                    : 'new';

    // The start-time projection writes effective = all-null. Fields the
    // human never touched track the latest extraction; human edits win —
    // decided per field, never all-or-nothing.
    const effective = mergeEffective(existing, extraction);

    const transportState = existing
        && TERMINAL_TRANSPORT_STATES.has(existing.transportState)
        && !TERMINAL_TRANSPORT_STATES.has(input.transportState)
        ? existing.transportState
        : input.transportState;

    return {
        schemaVersion: CALL_SCHEMA_VERSION,
        callId: input.callId,
        origin: 'provider',
        providerCallSid: input.callId,
        transportState,
        startedAt: input.startedAt ?? existing?.startedAt ?? now,
        endedAt: input.endedAt ?? existing?.endedAt ?? null,
        durationSeconds: input.durationSeconds ?? existing?.durationSeconds ?? null,
        fromNumberMasked: input.fromNumberMasked ?? existing?.fromNumberMasked ?? null,
        toNumberMasked: input.toNumberMasked ?? existing?.toNumberMasked ?? null,
        // Provider-observed extraction is immutable; a re-projection with a
        // null extraction keeps the earlier one.
        extraction: extraction
            ? { ...extraction }
            : (existing?.extraction ?? {}),
        effective,
        ops: {
            status: existing?.ops.status === 'done' ? 'done' : status,
            assignee: existing?.ops.assignee ?? null,
            callbackStatus: input.callbackRequired
                ? (existing?.ops.callbackStatus === 'completed' ? 'completed' : 'pending')
                : (existing?.ops.callbackStatus ?? 'not_required'),
            // Review flags only ever go false -> true on a projection —
            // a human who cleared it does so after the call's last
            // projection, so re-raising here cannot undo their action.
            needsReview: existing?.ops.needsReview === true || escalated,
            tags: existing?.ops.tags ?? []
        },
        severity: {
            urgency: input.severity?.urgency ?? existing?.severity.urgency ?? 'unknown',
            importance: input.severity?.importance ?? existing?.severity.importance ?? 'normal',
            humanRequested: input.severity?.humanRequested ?? existing?.severity.humanRequested ?? false,
            riskKinds: input.severity?.riskKinds ?? existing?.severity.riskKinds ?? [],
            basis: input.severity?.basis ?? existing?.severity.basis ?? 'provider_projection'
        },
        humanCase: existing?.humanCase ?? {
            state: 'none',
            caseId: null,
            notifiedAt: null,
            acknowledgedBy: null,
            acknowledgedAt: null
        },
        recordVersion: (existing?.recordVersion ?? 0) + 1,
        deletedAt: existing?.deletedAt ?? null,
        deletedBy: existing?.deletedBy ?? null,
        deletionReason: existing?.deletionReason ?? null,
        hold: existing?.hold ?? false,
        createdAt: existing?.createdAt ?? now,
        createdBy: existing?.createdBy ?? SYSTEM_ACTOR,
        updatedAt: now,
        updatedBy: SYSTEM_ACTOR
    };
};

const mergeRecordSanitized = (
    existing: CallRecord | null,
    input: ProviderCallProjection,
    now: string
): CallRecord => dropUndefined(mergeRecord(existing, input, now));

/**
 * Project one provider call into the v2 store. Idempotent: repeated calls
 * merge onto the same callId, and the escalation case uses a deterministic
 * id so duplicate close events never double-create.
 */
export async function projectProviderCall(
    repo: CallRepository,
    escalationRepo: EscalationRepository | null,
    input: ProviderCallProjection
): Promise<{ record: CallRecord; escalation: EscalationCase | null }> {
    const now = input.now?.() ?? new Date().toISOString();
    const existing = await repo.get(input.callId);
    const record = mergeRecordSanitized(existing, input, now);

    if (existing) {
        await repo.put(record);
    } else {
        await repo.createIfAbsent(record);
    }
    await repo.appendEvent({
        eventId: `evt_${randomUUID()}`,
        callId: record.callId,
        actor: SYSTEM_ACTOR,
        action: 'call.project',
        result: 'success',
        metadata: {
            transportState: record.transportState,
            outcome: input.outcome,
            knowledgeReleaseIds: input.knowledgeReleaseIds ?? [],
            handoff: input.handoff?.outcome ?? null
        },
        timestamp: now
    });

    const needsEscalation = input.handoff?.requested === true
        || input.severity?.importance === 'high'
        || input.severity?.importance === 'critical';
    let escalation: EscalationCase | null = null;
    if (needsEscalation && escalationRepo) {
        const caseId = `esc_${record.callId}`;
        const existingCase = await escalationRepo.get(caseId);
        const importance = input.severity?.importance === 'critical' ? 'critical' : 'high';
        if (!existingCase) {
            const created: EscalationCase = {
                schemaVersion: 1,
                caseId,
                callId: record.callId,
                importance,
                urgency: input.severity?.urgency ?? 'unknown',
                summary: input.extraction?.summary ?? null,
                state: input.notificationSent ? 'notified' : 'required',
                ownerRole: null,
                ownerSubject: null,
                ackDeadlineAt: null,
                notifiedAt: input.notificationSent ? now : null,
                acknowledgedBy: null,
                acknowledgedAt: null,
                resolvedBy: null,
                resolvedAt: null,
                resolutionNote: null,
                recordVersion: 1,
                createdAt: now,
                updatedAt: now
            };
            const { record: stored } = await escalationRepo.createIfAbsent(created);
            escalation = stored;
            await escalationRepo.appendEvent({
                eventId: `esc_${randomUUID()}`,
                caseId,
                actor: SYSTEM_ACTOR,
                action: 'escalation.create',
                result: 'success',
                metadata: { callId: record.callId, handoff: input.handoff?.outcome ?? null },
                timestamp: now
            });
        } else if (input.notificationSent && existingCase.state === 'required') {
            escalation = await escalationRepo.put({
                ...existingCase,
                state: 'notified',
                notifiedAt: existingCase.notifiedAt ?? now,
                recordVersion: existingCase.recordVersion + 1,
                updatedAt: now
            });
        } else {
            escalation = existingCase;
        }
    }

    // Reflect the case link back onto the call record when one exists —
    // humanCase.state tracks notification/ack on the call side too.
    if (escalation && record.humanCase.caseId !== escalation.caseId) {
        const linked: CallRecord = {
            ...record,
            humanCase: {
                state: escalation.state === 'acknowledged' ? 'acknowledged'
                    : escalation.state === 'notified' ? 'notified'
                        : 'required',
                caseId: escalation.caseId,
                notifiedAt: escalation.notifiedAt,
                acknowledgedBy: escalation.acknowledgedBy,
                acknowledgedAt: escalation.acknowledgedAt
            },
            recordVersion: record.recordVersion + 1,
            updatedAt: now
        };
        await repo.put(linked);
        return { record: linked, escalation };
    }

    return { record, escalation };
}
