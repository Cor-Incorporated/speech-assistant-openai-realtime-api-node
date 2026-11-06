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
import { VersionConflictError, type CallRepository } from './call-repository.js';
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
    const previousHumanState = existing?.humanCase.state ?? 'none';
    const incomingHumanState = input.handoff?.requested
        ? input.handoff.outcome === 'connected' ? 'connected'
            : input.handoff.outcome ? 'unavailable' : 'connecting'
        : previousHumanState;
    // Callback delivery and stream finalization run on different instances.
    // A late pending projection may fill extraction, but cannot undo a final
    // phone outcome or an authenticated human's acknowledgement/resolution.
    const humanState = ['assigned', 'acknowledged', 'resolved', 'connected'].includes(previousHumanState)
        || (previousHumanState === 'unavailable' && incomingHumanState === 'connecting')
        ? previousHumanState : incomingHumanState;
    const needsHumanCallback = humanState === 'connecting' || humanState === 'unavailable';
    const callbackRequired = humanState === 'connected' ? false : needsHumanCallback || input.callbackRequired;

    const status =
        humanState === 'connected' ? 'done'
            : callbackRequired ? 'needs_callback'
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
            callbackStatus: callbackRequired
                ? (existing?.ops.callbackStatus === 'completed' ? 'completed' : 'pending')
                : (humanState === 'connected' ? 'not_required' : existing?.ops.callbackStatus ?? 'not_required'),
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
        humanCase: {
            caseId: null,
            notifiedAt: null,
            acknowledgedBy: null,
            acknowledgedAt: null,
            ...existing?.humanCase,
            state: humanState
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

const updateCall = async (repo: CallRepository, callId: string, merge: (current: CallRecord | null) => CallRecord) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await repo.get(callId);
        const next = merge(current);
        try {
            if (current) return await repo.put(next, current.recordVersion);
            const result = await repo.createIfAbsent(next);
            if (result.created) return result.record;
        } catch (error) {
            if (!(error instanceof VersionConflictError) || attempt === 2) throw error;
        }
    }
    throw new VersionConflictError(`call ${callId}: projection raced repeatedly`);
};

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
    const record = await updateCall(repo, input.callId, (current) => mergeRecordSanitized(current, input, now));
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
                state: record.humanCase.state === 'connected' ? 'connected' : input.notificationSent ? 'notified' : 'required',
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
        } else {
            escalation = existingCase;
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = await escalationRepo.get(caseId);
            if (!current) break;
            const state = record.humanCase.state === 'connected'
                && !['acknowledged', 'resolved'].includes(current.state) ? 'connected'
                : input.notificationSent && current.state === 'required' ? 'notified' : current.state;
            if (state === current.state && (!input.notificationSent || current.notifiedAt)) {
                escalation = current;
                break;
            }
            try {
                escalation = await escalationRepo.put({
                    ...current, state,
                    notifiedAt: input.notificationSent ? current.notifiedAt ?? now : current.notifiedAt,
                    recordVersion: current.recordVersion + 1, updatedAt: now
                }, current.recordVersion);
                break;
            } catch (error) {
                if (!(error instanceof VersionConflictError) || attempt === 2) throw error;
            }
        }
    }

    // Reflect the case link back onto the call record when one exists —
    // humanCase.state tracks notification/ack on the call side too.
    if (escalation) {
        const finalCase = escalation;
        const linked = await updateCall(repo, record.callId, (current) => ({
            ...(current ?? record),
            humanCase: {
                state: ['assigned', 'acknowledged', 'resolved'].includes(current?.humanCase.state ?? '')
                    ? current!.humanCase.state
                    : finalCase.state === 'acknowledged' || finalCase.state === 'resolved' ? finalCase.state
                        : ['connecting', 'connected', 'unavailable'].includes(current?.humanCase.state ?? '')
                            ? current!.humanCase.state : finalCase.state === 'notified' ? 'notified' : 'required',
                caseId: finalCase.caseId,
                notifiedAt: current?.humanCase.notifiedAt ?? finalCase.notifiedAt,
                acknowledgedBy: current?.humanCase.acknowledgedBy ?? finalCase.acknowledgedBy,
                acknowledgedAt: current?.humanCase.acknowledgedAt ?? finalCase.acknowledgedAt
            },
            recordVersion: (current ?? record).recordVersion + 1,
            updatedAt: now
        }));
        return { record: linked, escalation };
    }

    return { record, escalation };
}
