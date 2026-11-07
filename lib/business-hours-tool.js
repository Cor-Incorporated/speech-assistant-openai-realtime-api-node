import { evaluateBusinessHours } from './business-hours.js';

export const BUSINESS_HOURS_TOOL = Object.freeze({
    type: 'function',
    name: 'check_business_hours',
    description: '日本時間の営業時間、休業・例外日、次の営業開始時刻を設定に基づいて確認します。営業時間や折返し可能時間の案内前に使用します。予約枠や担当者の応答は保証しません。緊急転送は営業時間外も既存の転送ルールに従います。',
    parameters: {
        type: 'object',
        properties: {
            at: { type: ['string', 'null'], description: '確認するISO8601日時（例: 2026-11-09T10:00:00+09:00）。現在時刻はnull。' }
        },
        required: ['at'],
        additionalProperties: false
    }
});

export function findBusinessHoursToolCalls(event) {
    return (Array.isArray(event?.response?.output) ? event.response.output : [])
        .filter((item) => item?.type === 'function_call' && item.name === BUSINESS_HOURS_TOOL.name)
        .map((item) => ({ callId: item.call_id ?? '', arguments: item.arguments }));
}

export function executeBusinessHoursCall(toolCall, {
    config = process.env.BUSINESS_HOURS_JSON,
    now = new Date()
} = {}) {
    let args;
    try {
        if (typeof toolCall.arguments !== 'string' || toolCall.arguments.length > 1024) throw new Error('invalid');
        args = JSON.parse(toolCall.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some((key) => key !== 'at')
            || (args.at !== undefined && args.at !== null && typeof args.at !== 'string')) throw new Error('invalid');
    } catch {
        args = false;
    }
    const result = args === false
        ? { state: 'unknown', reason: 'invalid_arguments', open: null, closed: null, next_available_at: null, emergency_transfer_allowed: true }
        : evaluateBusinessHours(config, { now: args.at ?? now });
    // Availability is not authority: an urgent handoff still goes through all
    // existing policy gates, regardless of whether the office is open.
    const instruction = result.state === 'unknown'
        ? '営業時間は確認できません。推測で営業中・休業中や折返し時刻を案内せず、希望時間を伺って担当者へ確認する旨を伝えてください。緊急転送の既存ルールは変えません。'
        : 'この営業時間情報に基づいて日本時間で案内してください。次の営業開始は予約枠や担当者の応答・折返し時刻の保証ではありません。緊急転送は営業時間にかかわらず既存ルールを適用してください。';
    return {
        type: 'function_call_output',
        call_id: toolCall.callId,
        output: JSON.stringify({ ...result, instruction }),
        _meta: { status: result.state, reason: result.reason }
    };
}
