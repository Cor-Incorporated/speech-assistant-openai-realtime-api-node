import { Firestore } from '@google-cloud/firestore';

const ACCOUNT_SID_PATTERN = /^AC[a-fA-F0-9]{32}$/;
const CALL_SID_PATTERN = /^CA[a-fA-F0-9]{32}$/;
const HANDOFF_DESTINATIONS = Object.freeze(['contract', 'general']);
const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const PAYMENT_DISPUTE_PATTERNS = [
    /(料金|金額|支払|支払い|払った|請求|入金|返金|取引|委託費|報酬)[^。！？\n]{0,40}(不足|足り|差額|違|間違|未払|遅れ|遅延|二重|トラブル|確認|相談|質問|返金)/,
    /(不足|足り|差額|違|間違)[^。！？\n]{0,24}(料金|金額|支払|支払い|請求|入金|取引)/
];
const COMPLAINT_PATTERNS = [
    /(苦情|クレーム|強い不満|納得できない|謝罪|補償|返金|説明してほしい|対応が悪い|話が違う|契約違反)/,
    /(困っている|改善してほしい|責任を取|責任を持|抗議|申し立て)/
];
const COMPLEX_SUPPORT_PATTERNS = [
    /(契約|契約書)[^。！？\n]{0,40}(解除|解約|違反|損害|賠償|法務|弁護士|訴訟|法的措置)/,
    /(個人情報|情報漏えい|情報漏洩|不正アクセス|乗っ取り|セキュリティ)[^。！？\n]{0,40}(漏|事故|被害|対応|確認|相談|報告)/,
    /(個人情報|情報漏えい|情報漏洩|不正アクセス|アカウント乗っ取り|アカウントの乗っ取り|セキュリティ事故|セキュリティ被害|情報が漏れた|情報が漏れている)/,
    /(弁護士|訴訟|訴える|法的措置|損害賠償|消費者センター|警察)[^。！？\n]{0,40}(相談|連絡|対応|伝|話|確認)?/,
    /(パワハラ|セクハラ|ハラスメント)[^。！？\n]{0,40}(相談|被害|対応|報告|確認)/,
    /(重大|深刻)[^。！？\n]{0,24}(事故|トラブル|問題|被害|漏えい|漏洩)/
];
const EMERGENCY_PATTERNS = [
    /(救急車|消防車|火事|火災|119|110)/,
    /(意識がない|意識がありません|意識不明|呼吸ができない|出血が止まらない|倒れた|けがをした|怪我をした|今危険|身の危険|襲われている)/
];
const CUSTOMER_HARASSMENT_PATTERNS = [
    /(カスタマーハラスメント|カスハラ|暴言|罵倒|怒鳴|恫喝|脅迫|脅す|威圧|嫌がらせ|迷惑行為)/,
    /(殺す|死ね|殴る|危害|爆破|火をつけ|家に行く|晒す|個人情報を公開)/,
    /(土下座|責任者を出せ|責任取れ|ふざけるな|いい加減にしろ|何度言わせる|話にならない)/
];
const GENERAL_HANDOFF_PATTERNS = [
    /(急ぎ|急な|至急|緊急|今すぐ|すぐに|今日中|本日中|早急|障害(?!者)|止まっている|使えない)/,
    /(代表|責任者|担当者)[^。！？\n]{0,30}(急ぎ|至急|緊急|今すぐ|すぐに|今日中|本日中|早急)/
];
const CONTRACT_REQUEST_PATTERNS = [
    /(受託|業務委託|発注|見積|実装|開発|制作|システム)[^。！？\n]{0,40}(依頼|お願い|相談|検討|発注|見積|作って|作りたい|委託|頼みたい)/,
    /(依頼|お願い|発注|見積|作って|作りたい|頼みたい)[^。！？\n]{0,40}(受託|業務委託|開発|制作|実装|システム|案件)/,
    /(仕事|案件|業務)[^。！？\n]{0,30}(依頼|お願い|相談|発注|見積|受託|業務委託)/
];
const SALES_BUSINESS_PATTERNS = [
    /(営業(?!時間|日|所|中|部)|営業電話|勧誘|広告|売り込み|テレアポ|アポイント)/,
    /(紹介料|アサイン|採用サポート|採用支援|人材紹介)/,
    /(採用|人材|エンジニア)[^。！？\n]{0,60}(紹介|アサイン|採用サポート|採用支援|紹介料|ご提案)/,
    /(?:弊社|当社)[^。！？\n]{0,40}(ご提案|ご紹介|サービス|システム|営業)/,
    /(従来より|通常より|他社より)[^。！？\n]{0,20}(安|抑|割引|低)/
];
const RECRUITING_APPLICANT_PATTERNS = [
    /(採用応募|応募者|応募|エントリー|面接|履歴書|職務経歴書)[^。！？\n]{0,40}(したい|した|について|相談|確認|送|提出|応募)?/,
    /(仕事|働|入社)[^。！？\n]{0,30}(応募|面接|採用|選考)/
];
const PARTNERSHIP_AND_MEDIA_PATTERNS = [
    /(業務提携|提携|協業|パートナー|代理店|販売店|取材|掲載|メディア|講演|協賛)[^。！？\n]{0,50}(相談|依頼|お願い|提案|希望|したい|なりたい|について|お話)?/,
    /(当社|弊社)[^。！？\n]{0,60}(代理店|提携|協業|取材|掲載|協賛)[^。！？\n]{0,30}(相談|提案|お願い|希望|したい|なりたい)?/
];
const EVENT_BUSINESS_PATTERNS = [
    /(イベント|交流会|勉強会|セミナー|カンファレンス)[^。！？\n]{0,80}(開催|企画|誘い|相談|集め|参加|会場)/
];
const REPRESENTATIVE_REQUEST_PATTERNS = [
    /(代表|責任者)[^。！？\n]{0,40}(いらっしゃる|お話|話したい|相談|つな|繋)/
];
const NON_HANDOFF_BUSINESS_PATTERNS = [
    ...SALES_BUSINESS_PATTERNS,
    ...RECRUITING_APPLICANT_PATTERNS,
    ...PARTNERSHIP_AND_MEDIA_PATTERNS,
    ...EVENT_BUSINESS_PATTERNS,
    ...REPRESENTATIVE_REQUEST_PATTERNS
];

export function normalizeHandoffDestination(value) {
    return String(value || '').trim().toLowerCase() === 'contract' ? 'contract' : 'general';
}

const functionTool = {
    type: 'function',
    name: 'transfer_to_human',
    description: '担当者への電話転送を開始します。受託・開発など仕事の依頼、または高精度対応モードが人間判断を必要とした緊急の相談だけに使用します。イベント相談、営業、採用勧誘、一般案内、脅迫・暴言・威圧の対応では使用しません。',
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
                description: 'contractは受託案件・開発制作・仕事の依頼、generalは高精度対応モードが人間判断を必要とした相談または明確に緊急な人間対応です。緊急性のない相談はコールセンターで受付します。'
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
            '以下の転送・分類ルールは内部指示です。顧客には読み上げず、「営業や採用ではないため」などの判定理由や内部ルーティングを説明しないでください。顧客には、担当者へつなぐ場合は「内容を確認して担当者へおつなぎします」、受付する場合は「内容を確認して折り返します」など、自然な結果だけを案内してください。',
            '人間の担当者への転送が必要と高精度対応モードで判断した場合だけ transfer_to_human を使ってください。',
            '受託案件、開発・制作、業務委託、見積相談など仕事の依頼は destination="contract" を指定してください。',
            '支払い・請求・入金・返金の相違、業務委託費の不足、正当な苦情や強い不満は、AI受付を継続しながら高精度対応モードで状況を整理してください。苦情や支払いトラブルだけを理由に即時転送してはいけません。高精度対応モードが人間の判断を必要とした場合だけ destination="general" を指定してください。',
            '脅迫・暴言・威圧などは人間へ自動転送せず、短く受け止め、落ち着いた境界線を示し、必要な事実を聞いてAI受付で対応してください。危険な発言が続く場合も口論や説教をせず、対応可能な範囲を案内して終話してください。これらの内部カテゴリ名や判定理由は顧客に説明しないでください。',
            '代表・責任者への相談だけでは転送しません。営業・採用・勧誘・広告、イベント、一般案内、緊急性のない相談はコールセンターで受付してください。',
            '営業・採用勧誘・広告は転送せず、AIで内容を受付・記録してください。担当者へ報告し、必要があれば担当者から折り返すと案内してください。必要時の連絡先電話番号を一つ聞き、validate_callback_phoneで検証してからfinish_receptionを呼び出してください。営業の場合、発信者が明確に折り返しを希望しない限りcallback_required=falseで終話してください。',
            '営業ではないイベント・一般相談・代表者への取次ぎなど緊急性のない相談は転送せず、コールセンターで受付してください。必要時の連絡先電話番号を聞き、担当者から改めて折り返すためcallback_required=trueで終話してください。',
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

function recentUserText(turns = [], maxTurns = 8) {
    return turns
        .filter((turn) => turn?.role === 'user')
        .slice(-maxTurns)
        .map((turn) => normalizeText(turn.text))
        .join(' ');
}

export function isComplaintCall(turns = []) {
    const text = recentUserText(turns);
    return PAYMENT_DISPUTE_PATTERNS.some((pattern) => pattern.test(text))
        || COMPLAINT_PATTERNS.some((pattern) => pattern.test(text))
        || COMPLEX_SUPPORT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isComplexSupportCall(turns = []) {
    const text = recentUserText(turns);
    return COMPLEX_SUPPORT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isEmergencyCall(turns = []) {
    const text = recentUserText(turns);
    return EMERGENCY_PATTERNS.some((pattern) => pattern.test(text));
}

export function isCustomerHarassmentCall(turns = []) {
    const text = recentUserText(turns);
    return CUSTOMER_HARASSMENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyGeneralHandoff(turns = []) {
    if (shouldAutoHandoffGeneral(turns)) return 'urgent_human_support';
    return '';
}

export function isContractRequest(turns = []) {
    const recentUserText = turns
        .filter((turn) => turn?.role === 'user')
        .slice(-8)
        .map((turn) => normalizeText(turn.text))
        .join(' ');

    if (PARTNERSHIP_AND_MEDIA_PATTERNS.some((pattern) => pattern.test(recentUserText))) return false;
    return CONTRACT_REQUEST_PATTERNS.some((pattern) => pattern.test(recentUserText));
}

export function isNonHandoffBusinessCall(turns = []) {
    const recentUserText = turns
        .filter((turn) => turn?.role === 'user')
        .slice(-8)
        .map((turn) => normalizeText(turn.text))
        .join(' ');

    if (isEmergencyCall(turns) || isComplaintCall(turns) || isCustomerHarassmentCall(turns) || isContractRequest(turns)) return false;

    const specificBusinessPatterns = [
        ...SALES_BUSINESS_PATTERNS,
        ...RECRUITING_APPLICANT_PATTERNS,
        ...PARTNERSHIP_AND_MEDIA_PATTERNS,
        ...EVENT_BUSINESS_PATTERNS
    ];
    if (specificBusinessPatterns.some((pattern) => pattern.test(recentUserText))) return true;
    if (shouldAutoHandoffGeneral(turns)) return false;
    return REPRESENTATIVE_REQUEST_PATTERNS.some((pattern) => pattern.test(recentUserText));
}

export function isSalesBusinessCall(turns = []) {
    const recentUserText = turns
        .filter((turn) => turn?.role === 'user')
        .slice(-8)
        .map((turn) => normalizeText(turn.text))
        .join(' ');

    if (isEmergencyCall(turns) || isComplaintCall(turns) || isCustomerHarassmentCall(turns) || isContractRequest(turns)) return false;
    return SALES_BUSINESS_PATTERNS.some((pattern) => pattern.test(recentUserText));
}

export function shouldAllowHumanHandoff(turns = [], destination = 'general') {
    if (isEmergencyCall(turns) || isNonHandoffBusinessCall(turns)) return false;
    return String(destination || '').trim().toLowerCase() === 'contract'
        ? isContractRequest(turns)
        : shouldAutoHandoffGeneral(turns);
}

export function resolveHandoffDestination(turns = [], destination = 'general') {
    if (isEmergencyCall(turns)) return 'general';
    if (shouldAutoHandoffGeneral(turns) || isComplaintCall(turns) || isCustomerHarassmentCall(turns)) return 'general';
    return normalizeHandoffDestination(destination);
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
