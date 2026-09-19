// Call record domain model — original observations vs. human corrections.
// The core invariant: provider-observed data is immutable; humans correct
// through versioned correction records, never by overwriting the raw event.

export const CALL_SCHEMA_VERSION = 1;

export const CALL_ORIGINS = ['provider', 'manual', 'synthetic'] as const;
export type CallOrigin = (typeof CALL_ORIGINS)[number];

export const TRANSPORT_STATES = ['connected', 'ended', 'failed', 'unknown'] as const;
export type TransportState = (typeof TRANSPORT_STATES)[number];

export const BUSINESS_STATES = ['new', 'needs_callback', 'in_progress', 'done'] as const;
export type BusinessState = (typeof BUSINESS_STATES)[number];

export const HUMAN_CASE_STATES = [
    'none',
    'required',
    'assigned',
    'notified',
    'acknowledged',
    'connecting',
    'connected',
    'unavailable',
    'resolved'
] as const;
export type HumanCaseState = (typeof HUMAN_CASE_STATES)[number];

export const CALLBACK_STATUSES = ['pending', 'completed', 'not_required'] as const;
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

/** Effective business view — human correction > verified ops value >
 * latest successful AI extraction > unconfirmed. */
export interface CallEffective {
    summary: string | null;
    callerName: string | null;
    callerNameKana: string | null;
    callbackNumber: string | null;
    callbackRequestedWindow: string | null;
    intent: string | null;
    memo: string | null;
}

export interface CallOps {
    status: BusinessState;
    assignee: string | null;
    callbackStatus: CallbackStatus | null;
    needsReview: boolean;
    tags: string[];
}

export interface CallSeverity {
    urgency: 'low' | 'normal' | 'high' | 'critical' | 'unknown';
    importance: 'low' | 'normal' | 'high' | 'critical' | 'unknown';
    humanRequested: boolean;
    riskKinds: string[];
    basis: string | null;
}

export interface CallRecord {
    schemaVersion: number;
    callId: string;
    origin: CallOrigin;
    providerCallSid: string | null;
    transportState: TransportState;
    startedAt: string | null;
    endedAt: string | null;
    durationSeconds: number | null;
    fromNumberMasked: string | null;
    toNumberMasked: string | null;
    /** AI extraction as originally produced — immutable once written. */
    extraction: Partial<CallEffective> & { model?: string; extractedAt?: string };
    /** Human-owned effective values. */
    effective: CallEffective;
    ops: CallOps;
    severity: CallSeverity;
    humanCase: {
        state: HumanCaseState;
        caseId: string | null;
        notifiedAt: string | null;
        acknowledgedBy: string | null;
        acknowledgedAt: string | null;
    };
    recordVersion: number;
    deletedAt: string | null;
    deletedBy: string | null;
    deletionReason: string | null;
    hold: boolean;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
}

export const CORRECTION_TARGETS = [
    'summary',
    'callerName',
    'callerNameKana',
    'callbackNumber',
    'callbackRequestedWindow',
    'intent',
    'memo',
    'transcriptTurn',
    'ops'
] as const;
export type CorrectionTarget = (typeof CORRECTION_TARGETS)[number];

export interface CallCorrection {
    schemaVersion: number;
    correctionId: string;
    callId: string;
    target: CorrectionTarget;
    /** For transcriptTurn corrections: the turn identifier being corrected. */
    targetRef: string | null;
    previousValue: unknown;
    newValue: unknown;
    reason: string;
    baseVersion: number;
    active: boolean;
    supersededBy: string | null;
    createdAt: string;
    createdBy: string;
}

// ---------------------------------------------------------------------------
// Input validation — the API accepts only these shapes; unknown fields are
// rejected rather than ignored so a typo can never silently drop intent.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
    field: string;
    message: string;
}

export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; issues: ValidationIssue[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const nullableStr = (v: unknown): string | null | undefined =>
    v === null ? null : str(v) ?? undefined;

const pickEnum = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;

export interface ManualCallInput {
    declaredAt: string | null;
    summary: string | null;
    callerName: string | null;
    callerNameKana: string | null;
    contact: string | null;
    callbackRequestedWindow: string | null;
    intent: string | null;
    memo: string | null;
    assignee: string | null;
    severity: 'low' | 'normal' | 'high' | 'critical';
}

const MANUAL_FIELDS = new Set([
    'declaredAt', 'summary', 'callerName', 'callerNameKana', 'contact',
    'callbackRequestedWindow', 'intent', 'memo', 'assignee', 'severity'
]);

export function validateManualCallInput(raw: unknown): ValidationResult<ManualCallInput> {
    if (!isRecord(raw)) return { ok: false, issues: [{ field: 'body', message: 'must be an object' }] };
    const issues: ValidationIssue[] = [];
    for (const key of Object.keys(raw)) {
        if (!MANUAL_FIELDS.has(key)) issues.push({ field: key, message: 'unknown field' });
    }
    // A manual record must never carry provider identity — that would let a
    // hand-written entry masquerade as a real phone call.
    if ('providerCallSid' in raw || 'callSid' in raw || 'streamSid' in raw) {
        issues.push({ field: 'providerCallSid', message: 'provider identifiers are system-owned' });
    }
    const severity = pickEnum(raw.severity ?? 'normal', ['low', 'normal', 'high', 'critical'] as const);
    if (!severity) issues.push({ field: 'severity', message: 'must be low|normal|high|critical' });
    if (issues.length > 0) return { ok: false, issues };
    return {
        ok: true,
        value: {
            declaredAt: nullableStr(raw.declaredAt) ?? null,
            summary: nullableStr(raw.summary) ?? null,
            callerName: nullableStr(raw.callerName) ?? null,
            callerNameKana: nullableStr(raw.callerNameKana) ?? null,
            contact: nullableStr(raw.contact) ?? null,
            callbackRequestedWindow: nullableStr(raw.callbackRequestedWindow) ?? null,
            intent: nullableStr(raw.intent) ?? null,
            memo: nullableStr(raw.memo) ?? null,
            assignee: nullableStr(raw.assignee) ?? null,
            severity: severity as ManualCallInput['severity']
        }
    };
}

/** Fields an operator PATCH may touch — everything else (raw transcript,
 * provider ids, ACK state) is read-only through this path. */
export interface CallPatchInput {
    effective?: Partial<CallEffective>;
    ops?: Partial<CallOps>;
    severityRaise?: 'low' | 'normal' | 'high' | 'critical';
    changeReason: string;
}

const EFFECTIVE_FIELDS: ReadonlySet<string> = new Set([
    'summary', 'callerName', 'callerNameKana', 'callbackNumber',
    'callbackRequestedWindow', 'intent', 'memo'
]);
const OPS_FIELDS: ReadonlySet<string> = new Set(['status', 'assignee', 'callbackStatus', 'needsReview', 'tags']);
const PATCH_FIELDS = new Set(['effective', 'ops', 'severityRaise', 'changeReason']);

export function validateCallPatch(raw: unknown): ValidationResult<CallPatchInput> {
    if (!isRecord(raw)) return { ok: false, issues: [{ field: 'body', message: 'must be an object' }] };
    const issues: ValidationIssue[] = [];
    for (const key of Object.keys(raw)) {
        if (!PATCH_FIELDS.has(key)) issues.push({ field: key, message: 'unknown field' });
    }
    const changeReason = str(raw.changeReason);
    if (!changeReason) issues.push({ field: 'changeReason', message: 'required — every correction records why' });

    let effective: Partial<CallEffective> | undefined;
    if (raw.effective !== undefined) {
        if (!isRecord(raw.effective)) {
            issues.push({ field: 'effective', message: 'must be an object' });
        } else {
            effective = {};
            for (const [key, value] of Object.entries(raw.effective)) {
                if (!EFFECTIVE_FIELDS.has(key)) {
                    issues.push({ field: `effective.${key}`, message: 'unknown field' });
                    continue;
                }
                (effective as Record<string, unknown>)[key] = value === null ? null : str(value) ?? undefined;
            }
        }
    }

    let ops: Partial<CallOps> | undefined;
    if (raw.ops !== undefined) {
        if (!isRecord(raw.ops)) {
            issues.push({ field: 'ops', message: 'must be an object' });
        } else {
            ops = {};
            for (const [key, value] of Object.entries(raw.ops)) {
                if (!OPS_FIELDS.has(key)) {
                    issues.push({ field: `ops.${key}`, message: 'unknown field' });
                    continue;
                }
                if (key === 'status') {
                    const v = pickEnum(value, BUSINESS_STATES);
                    if (!v) { issues.push({ field: 'ops.status', message: `must be ${BUSINESS_STATES.join('|')}` }); continue; }
                    ops.status = v;
                } else if (key === 'callbackStatus') {
                    const v = value === null ? null : pickEnum(value, CALLBACK_STATUSES);
                    if (v === undefined || (value !== null && !v)) { issues.push({ field: 'ops.callbackStatus', message: `must be ${CALLBACK_STATUSES.join('|')} or null` }); continue; }
                    ops.callbackStatus = v;
                } else if (key === 'needsReview') {
                    if (typeof value !== 'boolean') { issues.push({ field: 'ops.needsReview', message: 'must be boolean' }); continue; }
                    ops.needsReview = value;
                } else if (key === 'tags') {
                    if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
                        issues.push({ field: 'ops.tags', message: 'must be string[]' }); continue;
                    }
                    ops.tags = value;
                } else {
                    (ops as Record<string, unknown>)[key] = value === null ? null : str(value) ?? undefined;
                }
            }
        }
    }

    let severityRaise: CallPatchInput['severityRaise'];
    if (raw.severityRaise !== undefined) {
        const v = pickEnum(raw.severityRaise, ['low', 'normal', 'high', 'critical'] as const);
        if (!v) issues.push({ field: 'severityRaise', message: 'must be low|normal|high|critical' });
        else severityRaise = v;
    }

    if (issues.length > 0) return { ok: false, issues };
    const out: CallPatchInput = { changeReason: changeReason as string };
    if (effective !== undefined) out.effective = effective;
    if (ops !== undefined) out.ops = ops;
    if (severityRaise !== undefined) out.severityRaise = severityRaise;
    return { ok: true, value: out };
}
