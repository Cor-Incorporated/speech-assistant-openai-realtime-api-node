import { Firestore } from '@google-cloud/firestore';

const ACCOUNT_SID_PATTERN = /^AC[a-fA-F0-9]{32}$/;
const CALL_SID_PATTERN = /^CA[a-fA-F0-9]{32}$/;
const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const functionTool = {
    type: 'function',
    name: 'transfer_to_human',
    description: '担当者への電話転送を開始します。人間対応の明示要求、解決困難な問い合わせ、または高い感情的負荷がある場合に使用します。',
    parameters: {
        type: 'object',
        properties: {
            reason: {
                type: 'string',
                description: '転送理由を短く説明してください。'
            }
        },
        required: ['reason'],
        additionalProperties: false
    }
};

export function buildHandoffConfig({
    HANDOFF_ENABLED = false,
    HANDOFF_NUMBERS = '',
    HANDOFF_DIAL_TIMEOUT_S = 20,
    HANDOFF_WHISPER_ACCEPT_DIGIT = '1',
    HANDOFF_CALLER_ID = ''
} = {}) {
    const numbers = String(HANDOFF_NUMBERS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

    return {
        enabled: HANDOFF_ENABLED === true || HANDOFF_ENABLED === 'true',
        numbers,
        dialTimeoutSeconds: Math.min(Math.max(Number(HANDOFF_DIAL_TIMEOUT_S) || 20, 5), 120),
        whisperAcceptDigit: String(HANDOFF_WHISPER_ACCEPT_DIGIT || '1').slice(0, 1),
        callerId: String(HANDOFF_CALLER_ID || '').trim()
    };
}

export function buildTransferToHumanTool(config = {}) {
    return config.enabled && config.numbers.length > 0 ? structuredClone(functionTool) : null;
}

export function appendHandoffInstructions(instructions, config = {}) {
    if (!config.enabled || config.numbers.length === 0) return instructions;

    return [
        instructions,
        [
            '人間の担当者への転送が必要な場合は transfer_to_human を使ってください。',
            '発信者が人間対応を明示的に希望した場合、同じ内容を2回以上聞き返しても確定できない場合、または強い不安・怒り・苦情がある場合に転送してください。',
            '転送ツール実行後は、電話を切らずに担当者へつなぐ案内を短く行ってください。'
        ].join('\n')
    ].join('\n\n');
}

export function findTransferToHumanToolCalls(event) {
    const outputs = Array.isArray(event?.response?.output) ? event.response.output : [];

    return outputs
        .filter((item) => item?.type === 'function_call' && item?.name === 'transfer_to_human')
        .map((item) => {
            let args = {};
            try {
                args = item.arguments ? JSON.parse(item.arguments) : {};
            } catch {
                args = {};
            }

            return {
                callId: item.call_id || '',
                reason: normalizeText(args.reason) || '担当者対応が必要'
            };
        })
        .filter((item) => item.callId);
}

export function summarizeHandoffTurns(turns = [], { maxTurns = 8, maxChars = 600 } = {}) {
    const lines = turns
        .filter((turn) => turn && ['user', 'agent'].includes(turn.role))
        .slice(-maxTurns)
        .map((turn) => `${turn.role === 'user' ? '発信者' : 'AI'}: ${normalizeText(turn.text)}`)
        .filter((line) => line.length > 3);

    const summary = lines.join('。');
    return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}

export async function updateTwilioCallTwiml({
    accountSid,
    callSid,
    authToken,
    twiml,
    fetchImpl = fetch
} = {}) {
    if (!ACCOUNT_SID_PATTERN.test(String(accountSid || ''))) {
        return { ok: false, skipped: true, reason: 'invalid_account_sid' };
    }
    if (!CALL_SID_PATTERN.test(String(callSid || ''))) {
        return { ok: false, skipped: true, reason: 'invalid_call_sid' };
    }
    if (!authToken) return { ok: false, skipped: true, reason: 'missing_auth_token' };
    if (!String(twiml || '').trim()) return { ok: false, skipped: true, reason: 'missing_twiml' };

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ Twiml: twiml })
    });

    return response.ok
        ? { ok: true, skipped: false, statusCode: response.status }
        : { ok: false, skipped: false, statusCode: response.status, reason: 'twilio_api_error' };
}

export class HandoffContextStore {
    constructor({
        firestoreEnabled = false,
        firestoreDatabaseId = '',
        googleProjectId = '',
        firestore = null
    } = {}) {
        this.firestoreEnabled = firestoreEnabled === true || firestoreEnabled === 'true';
        this.firestoreDatabaseId = String(firestoreDatabaseId || '').trim();
        this.googleProjectId = String(googleProjectId || '').trim();
        this.firestore = firestore;
        this.memory = new Map();
    }

    getFirestore() {
        if (!this.firestore) {
            this.firestore = new Firestore({
                projectId: this.googleProjectId || undefined,
                databaseId: this.firestoreDatabaseId || undefined
            });
        }
        return this.firestore;
    }

    async save(callSid, context) {
        const id = String(callSid || '').trim();
        if (!id) return;
        const value = { ...context, callSid: id, updatedAt: new Date().toISOString() };
        this.memory.set(id, value);
        if (this.firestoreEnabled) {
            await this.getFirestore().collection('handoffs').doc(id).set(value, { merge: true });
        }
    }

    async get(callSid) {
        const id = String(callSid || '').trim();
        if (!id) return null;
        if (this.firestoreEnabled) {
            const snapshot = await this.getFirestore().collection('handoffs').doc(id).get();
            if (snapshot.exists) return { callSid: id, ...snapshot.data() };
        }
        return this.memory.get(id) || null;
    }

    async update(callSid, patch) {
        const current = await this.get(callSid) || { callSid };
        await this.save(callSid, { ...current, ...patch });
        return { ...current, ...patch };
    }
}

export { ACCOUNT_SID_PATTERN, CALL_SID_PATTERN };
