import { Firestore } from '@google-cloud/firestore';

const ACCOUNT_SID_PATTERN = /^AC[a-fA-F0-9]{32}$/;
const CALL_SID_PATTERN = /^CA[a-fA-F0-9]{32}$/;
const HANDOFF_DESTINATIONS = Object.freeze(['contract', 'general']);
const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const GENERAL_HANDOFF_PATTERNS = [
    /(料金|金額|支払|支払い|請求|入金|返金|取引)[^。！？\n]{0,24}(不足|足り|差額|違|間違|確認|相談|返金)/,
    /(不足|足り|差額|違|間違)[^。！？\n]{0,24}(料金|金額|支払|支払い|請求|入金|取引)/,
    /(苦情|クレーム|強い不満|納得できない)/,
    /(急ぎ|急な|至急|緊急|今すぐ|すぐに|今日中|本日中|早急|障害|止まっている|使えない)/,
    /(代表|責任者|担当者)[^。！？\n]{0,30}(急ぎ|至急|緊急|今すぐ|すぐに|今日中|本日中|早急)/
];
const CONTRACT_REQUEST_PATTERNS = [
    /(受託|開発|制作|業務委託|見積|発注|実装|システムを作|案件|依頼)/
];
const NON_HANDOFF_BUSINESS_PATTERNS = [
    /(営業|営業電話|勧誘|広告|売り込み|テレアポ|アポイント)/,
    /(紹介料|アサイン|採用サポート|採用支援|人材紹介)/,
    /(採用|人材|エンジニア)[^。！？\n]{0,60}(紹介|アサイン|採用サポート|採用支援|紹介料|ご提案)/,
    /(?:弊社|当社)[^。！？\n]{0,40}(ご提案|ご紹介|サービス|システム|営業)/,
    /(従来より|通常より|他社より)[^。！？\n]{0,20}(安|抑|割引|低)/,
    /(イベント|交流会|勉強会|セミナー|カンファレンス)[^。！？\n]{0,80}(開催|企画|誘い|相談|集め|参加|会場)/,
    /(代表|責任者)[^。！？\n]{0,40}(いらっしゃる|お話|話したい|相談|つな|繋)/
];

export function normalizeHandoffDestination(value) {
    return String(value || '').trim().toLowerCase() === 'contract' ? 'contract' : 'general';
}

const functionTool = {
    type: 'function',
    name: 'transfer_to_human',
    description: '担当者への電話転送を開始します。受託・開発など仕事の依頼、または料金・既存取引の相違や緊急の人間対応が必要な場合だけ使用します。イベント相談、営業、採用勧誘、一般案内、緊急性のない代表者依頼では使用しません。',
    parameters: {
        type: 'object',
        properties: {
            reason: {
                type: 'string',
                description: '転送理由を短く説明してください。'
            },
            destination: {
                type: 'string',
                enum: HANDOFF_DESTINATIONS,
                description: 'contractは受託案件・開発制作・仕事の依頼、generalは料金・支払・請求・既存取引の相違または緊急の人間対応です。緊急性のない相談はコールセンターで受付します。'
            }
        },
        required: ['reason', 'destination'],
        additionalProperties: false
    }
};

function parseHandoffNumbers(value) {
    const raw = String(value || '').trim();
    if (!raw) return { numbers: [], destinationNumbers: { contract: '', general: '' } };

    try {
        const parsed = JSON.parse(raw);
        if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
            const destinationNumbers = {
                contract: String(parsed.contract || '').trim(),
                general: String(parsed.general || '').trim()
            };
            const numbers = [...new Set(Object.values(destinationNumbers).filter(Boolean))];
            return { numbers, destinationNumbers };
        }
    } catch {
        // Backward compatibility: accept the original comma-separated format.
    }

    const numbers = [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
    return {
        numbers,
        destinationNumbers: {
            contract: numbers[0] || '',
            general: numbers[1] || numbers[0] || ''
        }
    };
}

export function buildHandoffConfig({
    HANDOFF_ENABLED = false,
    HANDOFF_NUMBERS = '',
    HANDOFF_DIAL_TIMEOUT_S = 20,
    HANDOFF_WHISPER_ACCEPT_DIGIT = '1',
    HANDOFF_WHISPER_REJECT_DIGIT = '2',
    HANDOFF_CALLER_ID = ''
} = {}) {
    const { numbers, destinationNumbers } = parseHandoffNumbers(HANDOFF_NUMBERS);

    return {
        enabled: HANDOFF_ENABLED === true || HANDOFF_ENABLED === 'true',
        numbers,
        destinationNumbers,
        dialTimeoutSeconds: Math.min(Math.max(Number(HANDOFF_DIAL_TIMEOUT_S) || 20, 5), 120),
        whisperAcceptDigit: String(HANDOFF_WHISPER_ACCEPT_DIGIT || '1').slice(0, 1),
        whisperRejectDigit: String(HANDOFF_WHISPER_REJECT_DIGIT || '2').slice(0, 1),
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
            '受託案件、開発・制作、業務委託、見積相談など仕事の依頼は destination="contract" を指定してください。',
            '料金不足、支払・請求・入金・返金の相違、既存取引への苦情、明確に急ぎ・緊急の人間対応は destination="general" を指定し、氏名や折り返し番号を先に聞かず、すぐに転送してください。',
            '代表・責任者への相談だけでは転送しません。営業・採用・勧誘・広告、イベント、一般案内、緊急性のない相談はコールセンターで受付してください。',
            '採用応募・採用関連、営業・勧誘・広告、一般的な案内は転送せず、AIで内容を受付・記録してください。担当者へ報告し、必要があれば担当者から折り返すと案内してください。折り返し希望の有無にかかわらず、必要時の連絡先電話番号を一つ聞き、validate_callback_phoneで検証してからfinish_receptionを呼び出してください。発信者が明確に折り返しを希望しない限り、callback_required=falseで終話してください。',
            '転送ツール実行後は、電話を切らずに担当者へつなぐ案内を短く行ってください。'
        ].join('\n')
    ].join('\n\n');
}

export function shouldAutoHandoffGeneral(turns = []) {
    const recentUserText = turns
        .filter((turn) => turn?.role === 'user')
        .slice(-6)
        .map((turn) => normalizeText(turn.text))
        .join(' ');

    return GENERAL_HANDOFF_PATTERNS.some((pattern) => pattern.test(recentUserText));
}

export function isContractRequest(turns = []) {
    const recentUserText = turns
        .filter((turn) => turn?.role === 'user')
        .slice(-8)
        .map((turn) => normalizeText(turn.text))
        .join(' ');

    return CONTRACT_REQUEST_PATTERNS.some((pattern) => pattern.test(recentUserText));
}

export function isNonHandoffBusinessCall(turns = []) {
    const recentUserText = turns
        .filter((turn) => turn?.role === 'user')
        .slice(-8)
        .map((turn) => normalizeText(turn.text))
        .join(' ');

    if (shouldAutoHandoffGeneral(turns) || isContractRequest(turns)) return false;
    return NON_HANDOFF_BUSINESS_PATTERNS.some((pattern) => pattern.test(recentUserText));
}

export function shouldAllowHumanHandoff(turns = [], destination = 'general') {
    return String(destination || '').trim().toLowerCase() === 'contract'
        ? isContractRequest(turns)
        : shouldAutoHandoffGeneral(turns);
}

export function isHandoffCallConnected(dialCallStatus, context = {}) {
    return String(dialCallStatus || '').toLowerCase() === 'completed'
        && context?.status !== 'whisper_rejected';
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
                reason: normalizeText(args.reason) || '担当者対応が必要',
                destination: normalizeHandoffDestination(args.destination)
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

export function summarizeHandoffWhisper(turns = [], { maxTurns = 4, maxChars = 180 } = {}) {
    const userText = turns
        .filter((turn) => turn?.role === 'user')
        .slice(-maxTurns)
        .map((turn) => normalizeText(turn.text))
        .filter(Boolean)
        .join('、')
        .replace(/[。！？!?]+/g, '、')
        .replace(/、+/g, '、')
        .replace(/^、|、$/g, '');
    if (!userText) return '受付内容の確認';

    const sentence = `用件は${userText}`;
    return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
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

export { ACCOUNT_SID_PATTERN, CALL_SID_PATTERN, HANDOFF_DESTINATIONS };
