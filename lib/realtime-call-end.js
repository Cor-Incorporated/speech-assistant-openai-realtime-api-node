const DEFAULT_FINAL_PHRASE = 'このあとお電話をお切りいただいて大丈夫です。失礼いたします。';
const FINISH_RECEPTION_TOOL_NAME = 'finish_reception';
const TWILIO_ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const TWILIO_CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;

const toBool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || String(value).toLowerCase() === 'true';
};

const toInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const normalizeText = (value = '') => String(value || '')
    .normalize('NFKC')
    .trim();

export function buildCallEndConfig(env = process.env) {
    const workflowEnabled = toBool(env.CALL_END_WORKFLOW_ENABLED, true);

    return {
        workflowEnabled,
        hangupEnabled: workflowEnabled && toBool(env.CALL_END_HANGUP_ENABLED, true),
        finalPhrase: normalizeText(env.CALL_END_FINAL_PHRASE) || DEFAULT_FINAL_PHRASE,
        markTimeoutMs: toInteger(env.CALL_END_MARK_TIMEOUT_MS, 15000),
        graceMs: toInteger(env.CALL_END_GRACE_MS, 800)
    };
}

export function buildFinishReceptionTool(config = buildCallEndConfig()) {
    if (!config.workflowEnabled) return null;

    return {
        type: 'function',
        name: FINISH_RECEPTION_TOOL_NAME,
        description: [
            'Use this when the reception workflow is complete and no more information needs to be collected.',
            'Call it only after the customer request, callback name, callback phone number, and any required preferred timing have been confirmed or explicitly deferred for callback.'
        ].join(' '),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                reason: {
                    type: 'string',
                    description: 'Brief Japanese reason why the reception can be closed.'
                },
                callback_required: {
                    type: 'boolean',
                    description: 'Whether staff follow-up or callback is required.'
                }
            },
            required: ['reason', 'callback_required']
        }
    };
}

export function appendCallEndInstructions(systemMessage, config = buildCallEndConfig()) {
    if (!config.workflowEnabled) return systemMessage;

    return [
        systemMessage,
        [
            '終話ルール:',
            '用件、名前、折り返し電話番号、必要な希望日時を確認できた、または空き時間などを確認して折り返す必要があるため追加質問が不要になった場合は、会話を曖昧に終えず finish_reception ツールを呼び出してください。',
            `最終案内では必ず「${config.finalPhrase}」と伝えてください。`,
            '終話時に「少々お待ちください」だけで終えないでください。顧客が電話を切ってよい状態であることを明示してください。'
        ].join('\n')
    ].join('\n\n');
}

export function isTerminalAgentMessage(message, config = buildCallEndConfig()) {
    const normalizedMessage = normalizeText(message);
    const finalPhrase = normalizeText(config.finalPhrase);

    return Boolean(finalPhrase && normalizedMessage.includes(finalPhrase));
}

export function findFinishReceptionToolCalls(event) {
    const outputs = Array.isArray(event?.response?.output) ? event.response.output : [];

    return outputs
        .filter((item) => item?.type === 'function_call' && item?.name === FINISH_RECEPTION_TOOL_NAME)
        .map((item) => {
            let argumentsJson = {};
            try {
                argumentsJson = item.arguments ? JSON.parse(item.arguments) : {};
            } catch {
                argumentsJson = {};
            }

            return {
                callId: item.call_id || '',
                reason: normalizeText(argumentsJson.reason) || '受付完了',
                callbackRequired: Boolean(argumentsJson.callback_required)
            };
        })
        .filter((item) => item.callId);
}

export async function updateTwilioCallStatus({
    accountSid,
    callSid,
    authToken,
    status = 'completed',
    fetchImpl = fetch
} = {}) {
    if (!TWILIO_ACCOUNT_SID_PATTERN.test(String(accountSid || ''))) {
        return {
            ok: false,
            skipped: true,
            reason: 'invalid_account_sid'
        };
    }

    if (!TWILIO_CALL_SID_PATTERN.test(String(callSid || ''))) {
        return {
            ok: false,
            skipped: true,
            reason: 'invalid_call_sid'
        };
    }

    if (!authToken) {
        return {
            ok: false,
            skipped: true,
            reason: 'missing_auth_token'
        };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: status });
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    if (!response.ok) {
        return {
            ok: false,
            skipped: false,
            statusCode: response.status,
            reason: 'twilio_api_error'
        };
    }

    return {
        ok: true,
        skipped: false,
        statusCode: response.status
    };
}
