// Runtime validation for tool-call arguments arriving as provider JSON.
// The API-side JSON Schema is a hint only — arguments are re-validated here
// before any side effect. Invalid arguments are never coerced into valid ones.

export const MAX_TOOL_ARGUMENT_CHARS = 8192;

export type ToolArgsResult<T> =
    | { ok: true; value: T }
    | { ok: false; reason: string };

const ok = <T>(value: T): ToolArgsResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): ToolArgsResult<T> => ({ ok: false, reason });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse a raw tool-call `arguments` string into an object.
 * Rejects non-strings, oversized payloads, malformed JSON and non-objects.
 */
export function parseToolArguments(raw: unknown): ToolArgsResult<Record<string, unknown>> {
    if (typeof raw !== 'string') {
        return fail('arguments_not_string');
    }
    if (raw.length > MAX_TOOL_ARGUMENT_CHARS) {
        return fail('arguments_too_large');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return fail('invalid_json');
    }

    if (!isPlainObject(parsed)) {
        return fail('arguments_not_object');
    }

    return ok(parsed);
}

const checkAllowedKeys = (
    args: Record<string, unknown>,
    allowed: readonly string[]
): string | null => {
    const extras = Object.keys(args).filter((key) => !allowed.includes(key));
    return extras.length > 0 ? `unexpected_properties:${extras.join(',')}` : null;
};

export interface FinishReceptionArgs {
    reason: string;
    callbackRequired: boolean;
}

/**
 * finish_reception arguments. `callback_required` must be a real JSON boolean —
 * the string "false" is rejected rather than coerced to true by Boolean().
 */
export function parseFinishReceptionArgs(raw: unknown): ToolArgsResult<FinishReceptionArgs> {
    const parsed = parseToolArguments(raw);
    if (!parsed.ok) return fail(parsed.reason);
    const args = parsed.value;

    const keyError = checkAllowedKeys(args, ['reason', 'callback_required']);
    if (keyError) return fail(keyError);

    if (typeof args.reason !== 'string') {
        return fail('invalid_reason_type');
    }
    if (typeof args.callback_required !== 'boolean') {
        return fail('invalid_callback_required_type');
    }

    return ok({
        reason: args.reason.normalize('NFKC').trim() || '受付完了',
        callbackRequired: args.callback_required
    });
}

export const HANDOFF_DESTINATION_VALUES = ['contract', 'general'] as const;
export type HandoffDestination = (typeof HANDOFF_DESTINATION_VALUES)[number];

export interface TransferToHumanArgs {
    reason: string;
    destination: HandoffDestination;
}

/**
 * transfer_to_human arguments. An unknown destination is rejected outright —
 * it is never normalized to 'general'.
 */
export function parseTransferToHumanArgs(raw: unknown): ToolArgsResult<TransferToHumanArgs> {
    const parsed = parseToolArguments(raw);
    if (!parsed.ok) return fail(parsed.reason);
    const args = parsed.value;

    const keyError = checkAllowedKeys(args, ['reason', 'destination']);
    if (keyError) return fail(keyError);

    if (typeof args.reason !== 'string') {
        return fail('invalid_reason_type');
    }
    if (
        typeof args.destination !== 'string'
        || !(HANDOFF_DESTINATION_VALUES as readonly string[]).includes(args.destination)
    ) {
        return fail('invalid_destination');
    }

    return ok({
        reason: args.reason.normalize('NFKC').trim() || '担当者対応が必要',
        destination: args.destination as HandoffDestination
    });
}

export interface ValidateCallbackPhoneArgs {
    heardPhoneNumber: string;
}

export function parseValidateCallbackPhoneArgs(
    raw: unknown
): ToolArgsResult<ValidateCallbackPhoneArgs> {
    const parsed = parseToolArguments(raw);
    if (!parsed.ok) return fail(parsed.reason);
    const args = parsed.value;

    const keyError = checkAllowedKeys(args, ['heard_phone_number']);
    if (keyError) return fail(keyError);

    if (typeof args.heard_phone_number !== 'string') {
        return fail('invalid_heard_phone_number_type');
    }
    const heardPhoneNumber = args.heard_phone_number.trim();
    if (!heardPhoneNumber) {
        return fail('empty_heard_phone_number');
    }
    if (heardPhoneNumber.length > 200) {
        return fail('heard_phone_number_too_long');
    }

    return ok({ heardPhoneNumber });
}
