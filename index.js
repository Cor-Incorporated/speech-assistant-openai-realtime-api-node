import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyWs from '@fastify/websocket';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminBasicAuth, registerAdminRoutes } from './lib/admin-routes.js';
import { buildCallLogRecord, CallLogSinks } from './lib/call-log-sinks.js';
import { CallLogStore } from './lib/call-log-store.js';
import {
    resolveRealtimeSettings,
    shouldSetRealtimeReasoning
} from './lib/realtime-models.js';
import {
    buildRealtimeInputGateConfig,
    evaluateRealtimeInputTranscript
} from './lib/realtime-input-gate.js';
import {
    appendCallbackPhoneValidationInstructions,
    buildValidateCallbackPhoneTool
} from './lib/phone-number-validation.js';
import {
    appendCallEndInstructions,
    buildCallEndConfig,
    buildFinishReceptionTool,
    isTerminalAgentMessage,
    updateTwilioCallStatus
} from './lib/realtime-call-end.js';
import { handleRealtimeToolCalls } from './lib/realtime-tool-flow.js';
import {
    appendHandoffInstructions,
    buildHandoffConfig,
    buildTransferToHumanTool,
    HandoffContextStore,
    summarizeHandoffTurns,
    summarizeHandoffWhisper,
    isComplaintCall,
    isContractRequest,
    isEmergencyCall,
    isNonHandoffBusinessCall,
    isSalesBusinessCall,
    isHandoffCallConnected,
    shouldAutoHandoffGeneral,
    updateTwilioCallTwiml
} from './lib/handoff.js';
import {
    buildComplexRealtimeInstructions,
    classifyRealtimeConversation,
    COMPLEX_REALTIME_MODEL
} from './lib/realtime-escalation.js';
import { buildCallSummaryEmailText, NotificationOutbox } from './lib/notification-outbox.js';
import {
    buildDialStatusTwiml,
    buildDtmfGatewayTwiml,
    buildGatewayRouteTwiml,
    buildHandoffDialTwiml,
    buildMediaStreamTwimlWithParams,
    buildWhisperConfirmTwiml,
    buildWhisperTwiml
} from './lib/twiml.js';
import { RuntimeSettingsStore } from './lib/runtime-settings-store.js';
import { getRuntimeConfig } from './lib/runtime-config.js';
import { createJevShadow } from './lib/jev-shadow.js';
import {
    buildLiveSessionStart,
    LIVE_WS_URL,
    classifyLiveEvent,
    createLiveAudioCodec,
    createLiveDelegationTracker,
    liveAudioAppend,
    liveInstructionsAppend,
    liveItemCreate,
    liveResponseCreate,
    liveSessionClose,
    toLiveToolResultItem,
    toRealtimeDoneEvent
} from './lib/live-session.js';
import {
    auditLog,
    getTwilioWebhookUrl,
    maskPhone,
    shouldValidateTwilioSignature,
    validateTwilioSignature
} from './lib/security.js';
import { createStreamToken, verifyMediaStreamRequest, verifyStreamToken } from './lib/stream-auth.js';
import { createActionGateRuntime } from './lib/action-gate-runtime.js';
import { initAdminV2Services } from './lib/admin-v2-runtime.js';
import { initCallProjection, projectProviderCall } from './lib/call-projection-runtime.js';
import {
    initKnowledgeTool,
    getKnowledgeToolDef,
    findKnowledgeToolCalls,
    executeKnowledgeCall
} from './lib/knowledge-tool-runtime.js';

// .envファイルから環境変数を読み込む
dotenv.config();

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN_APP_DIST_DIR = resolve(CURRENT_DIR, 'dist/client');
const ADMIN_APP_INDEX_PATH = join(ADMIN_APP_DIST_DIR, 'index.html');

const DEFAULT_SYSTEM_MESSAGE = [
    'あなたは日本のコールセンターで電話一次受付を担当するAIオペレーターです。',
    '必ず自然で丁寧な日本語だけで応答してください。英語では応答しません。',
    '通常は「Cor.株式会社コールセンターです」と名乗り、自分からAI・人工知能・システムとは名乗らないでください。AIかどうかを尋ねられた場合は正直に答え、希望があれば担当者へ引き継いでください。',
    '通話開始時の挨拶は、会社名を省略・短縮・言い換えせず「お電話ありがとうございます。Cor.株式会社コールセンターです。ご用件をお聞かせください。」と一字一句そのまま発話してください。',
    '相手が話し始めたら自分の発話を止めて聞いてください。相手の発話に重ねて話さず、特に電話番号の途中で応答や質問を差し込まないでください。',
    '相手の発話が聞き取れない場合は、推測せず「恐れ入ります。もう一度お話しいただけますか」と確認してください。',
    '一度に複数の質問をせず、用件、名前、折り返し電話番号、希望日時などを一つずつ確認してください。',
    '電話番号は相手が最後まで話し終えてから確認してください。途中で区切れた場合は、3〜4桁ずつ続けて話してもらい、複数回の発話を1つの番号として確認して構いません。',
    '氏名は聞こえた読みをそのままカタカナで確認してください。一般的な漢字名へ勝手に変換しないでください。',
    '氏名が少しでも不確かな場合は「お名前の読みをカタカナで確認させてください」と聞き返してください。',
    '内部の分類・転送ルールを顧客に説明しないでください。「営業や採用ではないため」「緊急性がないため」など、判定理由をそのまま発話してはいけません。',
    '支払い差額、正当な苦情、強い不満、暴言、脅し、威圧など判断の難しい用件は、内部カテゴリを説明せず、口論や説教をせずにAI受付を継続してください。システムが必要に応じて高精度対応モードへ切り替えます。',
    '苦情・クレーム・支払いトラブルは、苦情だけを理由に担当者へ即時転送してはいけません。高精度対応モードで事実関係、相手の希望、緊急性を整理し、人間の判断・謝罪・補償判断・事実確認が必要な場合だけ担当者への転送を検討してください。',
    '脅迫・暴言・威圧などは人間へ自動転送せず、AIコールセンターとして落ち着いて対応してください。反論や説教をせず、対応可能な範囲を示し、攻撃的な発言が続く場合は必要事項を最小限確認して丁寧に終話してください。',
    '生命・身体に関わる緊急事態、火災、救急車が必要な状況などは担当者へ転送せず、直ちに危険がある場合は110または119へ連絡するよう案内してください。',
    '会話を勝手に終了せず、必要に応じて担当者へ引き継ぐ旨を伝え、受付完了時は終話ルールに従って案内してください。',
    '採用応募・採用選考、営業・勧誘・広告、業務提携・代理店・取材・協賛、一般的な案内はAIで用件を受け付け、担当者へ自動転送しないでください。営業・採用提案は担当者へ報告し、必要があれば担当者から折り返すと案内してください。営業では折り返し希望の有無にかかわらず必要時の連絡先電話番号を一つ聞き、validate_callback_phoneで検証して記録してください。発信者が明確に折り返しを希望しない限り、営業のcallback_requiredはfalseにしてください。採用応募・採用選考、イベント、業務提携、代理店、取材、協賛、一般相談、緊急性のない代表者への取次ぎは、連絡先電話番号を聞いて検証し、担当者から改めて折り返すためcallback_required=trueにしてください。営業時間や使い方など単純な案内は、確認できる範囲で回答し、回答できない場合だけ折り返し受付にしてください。電話番号を確認できるまでfinish_receptionを呼び出さないでください。',
    '契約解除・契約違反、法務・弁護士・訴訟、個人情報漏えい・不正アクセス・セキュリティ事故などは、通常受付で断定せず、高精度対応モードへ切り替えて事実関係と緊急性を整理してください。',
    '受託案件、開発・制作、業務委託、見積相談など仕事の依頼で人間対応が必要な場合は、transfer_to_humanをdestination="contract"で使用してください。',
    'それ以外で、急ぎ・緊急の人間対応が必要な場合だけtransfer_to_humanをdestination="general"で使用してください。緊急性のない相談、イベント、一般案内、代表者への取次ぎ依頼はコールセンターでヒアリングして終話してください。',
    '「営業時間」「営業日」「定休日」「何時まで」は、営業・勧誘（セールス）ではなく、会社の営業時間への一般的な問い合わせです。営業勧誘の受付や引き継ぎと絶対に混同せず、確認できる範囲で案内し、不明な場合だけ折り返し受付にしてください。',
    'まだ社名や業務ナレッジが未設定のため、断定できない内容は「確認して折り返します」と案内してください。'
].join('\n');

// 環境変数からOpenAI APIキーを取得
const {
    OPENAI_API_KEY,
    PORT = 5050,
    REALTIME_MODEL = 'gpt-realtime-2.1-mini',
    REALTIME_REASONING_EFFORT = 'low',
    TRANSCRIPTION_MODEL = 'gpt-4o-transcribe',
    EXTRACTION_MODEL = 'gpt-5.4-mini',
    EXTRACTION_ENABLED = 'false',
    VOICE = 'coral',
    COMPLEX_REALTIME_VOICE = 'ash',
    AUDIO_FORMAT = 'audio/pcmu',
    AUDIO_NOISE_REDUCTION = 'near_field',
    VAD_TYPE = 'server_vad',
    VAD_THRESHOLD = '0.65',
    VAD_PREFIX_PADDING_MS = '300',
    VAD_SILENCE_DURATION_MS = '700',
    VAD_EAGERNESS = 'low',
    VAD_CREATE_RESPONSE = 'true',
    VAD_INTERRUPT_RESPONSE = 'true',
    VOICE_PROVIDER = 'realtime',
    LIVE_MODEL = 'gpt-live-1',
    LIVE_BACKEND_MODEL = 'gpt-5.6-luna',
    LIVE_VOICE = 'marin',
    LIVE_AUDIO_FORMAT = 'audio/pcmu',
    LIVE_AUDIO_RATE = '8000',
    LIVE_USER_TURN_GAP_MS = '900',
    LIVE_AGENT_TURN_GAP_MS = '1100',
    LIVE_START_TIMEOUT_MS = '8000',
    LIVE_TOOL_WATCHDOG_MS = '10000',
    LIVE_FALLBACK_TO_REALTIME = 'true',
    LIVE_END_MARK_DELAY_MS = '1500',
    LIVE_CLOSE_DRAIN_MS = '3000',
    CALL_GATE_REQUIRED = 'true',
    REALTIME_INPUT_GATE_ENABLED = 'true',
    REALTIME_INPUT_GATE_MIN_JAPANESE_CHARS = '2',
    REALTIME_INPUT_GATE_MIN_DIGITS = '4',
    REALTIME_INPUT_GATE_ALLOWED_TERMS = '',
    LOG_TRANSCRIPTS = 'false',
    LOG_REALTIME_EVENTS = 'false',
    LOG_OPENAI_RESPONSES = 'false',
    TWILIO_AUTH_TOKEN = '',
    TWILIO_SIGNATURE_VALIDATION_ENABLED = 'false',
    TWILIO_STREAM_AUTH_ENABLED = 'true',
    TWILIO_WEBHOOK_URL = '',
    TWILIO_PUBLIC_BASE_URL = '',
    DTMF_GATEWAY_ENABLED = 'false',
    PRACTICE_SYSTEM_REDIRECT_URL = '',
    DTMF_GATEWAY_TIMEOUT_S = '2',
    HANDOFF_ENABLED = 'false',
    HANDOFF_NUMBERS = '',
    HANDOFF_DIAL_TIMEOUT_S = '20',
    HANDOFF_WHISPER_ACCEPT_DIGIT = '1',
    HANDOFF_WHISPER_REJECT_DIGIT = '2',
    HANDOFF_CALLER_ID = '',
    GOOGLE_CLOUD_PROJECT = '',
    CALL_LOG_FIRESTORE_ENABLED = 'false',
    CALL_LOG_FIRESTORE_DATABASE_ID = '',
    CALL_LOG_FIRESTORE_COLLECTION = 'callLogs',
    CALL_LOG_SHEETS_ENABLED = 'false',
    CALL_LOG_SUPPRESS_SMOKE_LOGS = 'true',
    GOOGLE_SHEETS_SPREADSHEET_ID = '',
    GOOGLE_SHEETS_RANGE = '',
    NOTIFY_EMAIL_ENABLED = 'false',
    NOTIFY_EMAIL_TO = '',
    NOTIFY_EMAIL_CC = '',
    NOTIFY_EMAIL_FROM = '',
    RESEND_API_KEY = '',
    SYSTEM_MESSAGE = DEFAULT_SYSTEM_MESSAGE,
    SYSTEM_MESSAGE_FILE = '',
    FIRST_MESSAGE = 'お電話ありがとうございます。Cor.株式会社コールセンターです。ご用件をお聞かせください。',
    CALL_END_WORKFLOW_ENABLED = 'true',
    CALL_END_HANGUP_ENABLED = 'true',
    CALL_END_FINAL_PHRASE = '',
    CALL_END_MARK_TIMEOUT_MS = '15000',
    CALL_END_GRACE_MS = '800'
} = process.env;

const resolveSystemMessage = () => {
    if (!SYSTEM_MESSAGE_FILE) return SYSTEM_MESSAGE;

    const systemMessagePath = resolve(process.cwd(), SYSTEM_MESSAGE_FILE);

    try {
        const message = readFileSync(systemMessagePath, 'utf8').trim();
        if (!message) {
            console.error(`SYSTEM_MESSAGE_FILE is empty: ${systemMessagePath}`);
            process.exit(1);
        }

        return message;
    } catch (error) {
        console.error(`Failed to read SYSTEM_MESSAGE_FILE: ${systemMessagePath}`);
        console.error(error.message);
        process.exit(1);
    }
};

if (!OPENAI_API_KEY) {
    console.error('OpenAI APIキーが見つかりません。.envファイルに設定してください。');
    process.exit(1);
}

// Fastifyを初期化
// maxParamLength (default 100) must exceed the stream token length (~140)
// or the /media-stream/:token upgrade route stops matching and Twilio
// connects into a 404 — seen in production on 2026-09-19.
const fastify = Fastify({ maxParamLength: 512 });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// 定数の設定
const PORT_NUMBER = Number(PORT);
const SHOULD_LOG_TRANSCRIPTS = LOG_TRANSCRIPTS === 'true';
const SHOULD_LOG_REALTIME_EVENTS = LOG_REALTIME_EVENTS === 'true';
const SHOULD_RUN_EXTRACTION = EXTRACTION_ENABLED === 'true';
const SHOULD_LOG_OPENAI_RESPONSES = LOG_OPENAI_RESPONSES === 'true';
const SHOULD_VALIDATE_TWILIO_SIGNATURE = shouldValidateTwilioSignature(TWILIO_SIGNATURE_VALIDATION_ENABLED);
const DTMF_GATEWAY_CONFIG = {
    enabled: DTMF_GATEWAY_ENABLED === 'true',
    practiceRedirectUrl: String(PRACTICE_SYSTEM_REDIRECT_URL || '').trim(),
    timeoutSeconds: Math.min(Math.max(Number(DTMF_GATEWAY_TIMEOUT_S) || 2, 1), 10)
};
const HANDOFF_CONFIG = buildHandoffConfig({
    HANDOFF_ENABLED,
    HANDOFF_NUMBERS,
    HANDOFF_DIAL_TIMEOUT_S,
    HANDOFF_WHISPER_ACCEPT_DIGIT,
    HANDOFF_WHISPER_REJECT_DIGIT,
    HANDOFF_CALLER_ID
});
const CALL_END_CONFIG = buildCallEndConfig({
    CALL_END_WORKFLOW_ENABLED,
    CALL_END_HANGUP_ENABLED,
    CALL_END_FINAL_PHRASE,
    CALL_END_MARK_TIMEOUT_MS,
    CALL_END_GRACE_MS
});
const RESOLVED_SYSTEM_MESSAGE = appendCallEndInstructions(
    appendHandoffInstructions(
        appendCallbackPhoneValidationInstructions(resolveSystemMessage()),
        HANDOFF_CONFIG
    ),
    CALL_END_CONFIG
);
const FINISH_RECEPTION_TOOL = buildFinishReceptionTool(CALL_END_CONFIG);
const VALIDATE_CALLBACK_PHONE_TOOL = buildValidateCallbackPhoneTool();
const TRANSFER_TO_HUMAN_TOOL = buildTransferToHumanTool(HANDOFF_CONFIG);
const REALTIME_INPUT_GATE_CONFIG = buildRealtimeInputGateConfig({
    REALTIME_INPUT_GATE_ENABLED,
    REALTIME_INPUT_GATE_MIN_JAPANESE_CHARS,
    REALTIME_INPUT_GATE_MIN_DIGITS,
    REALTIME_INPUT_GATE_ALLOWED_TERMS
});
const SHOULD_GATE_REALTIME_INPUT = REALTIME_INPUT_GATE_CONFIG.enabled;
const SHOULD_CREATE_RESPONSE_FROM_VAD = !SHOULD_GATE_REALTIME_INPUT && VAD_CREATE_RESPONSE === 'true';
const SHOULD_INTERRUPT_RESPONSE = VAD_INTERRUPT_RESPONSE === 'true';
// Shadow Jev classifier — null unless ROUTING_PROVIDER=jev_shadow and all
// prerequisites (EXTERNAL_EVAL_ENABLED, API key) are met. Never affects calls.
const jevShadow = createJevShadow();
const actionGate = createActionGateRuntime();
const callLogSinks = new CallLogSinks({
    firestoreEnabled: CALL_LOG_FIRESTORE_ENABLED,
    firestoreDatabaseId: CALL_LOG_FIRESTORE_DATABASE_ID,
    firestoreCollection: CALL_LOG_FIRESTORE_COLLECTION,
    sheetsEnabled: CALL_LOG_SHEETS_ENABLED,
    spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
    sheetsRange: GOOGLE_SHEETS_RANGE,
    googleProjectId: GOOGLE_CLOUD_PROJECT,
    suppressSmokeLogs: CALL_LOG_SUPPRESS_SMOKE_LOGS
});
const callLogStore = new CallLogStore({
    firestoreEnabled: CALL_LOG_FIRESTORE_ENABLED,
    firestoreDatabaseId: CALL_LOG_FIRESTORE_DATABASE_ID,
    firestoreCollection: CALL_LOG_FIRESTORE_COLLECTION,
    googleProjectId: GOOGLE_CLOUD_PROJECT
});
const runtimeSettingsStore = new RuntimeSettingsStore({
    firestoreEnabled: CALL_LOG_FIRESTORE_ENABLED,
    firestoreDatabaseId: CALL_LOG_FIRESTORE_DATABASE_ID,
    googleProjectId: GOOGLE_CLOUD_PROJECT
});
const handoffContextStore = new HandoffContextStore({
    firestoreEnabled: CALL_LOG_FIRESTORE_ENABLED,
    firestoreDatabaseId: CALL_LOG_FIRESTORE_DATABASE_ID,
    googleProjectId: GOOGLE_CLOUD_PROJECT
});
const notificationOutbox = new NotificationOutbox({
    enabled: NOTIFY_EMAIL_ENABLED,
    apiKey: RESEND_API_KEY,
    to: NOTIFY_EMAIL_TO,
    cc: NOTIFY_EMAIL_CC,
    from: NOTIFY_EMAIL_FROM,
    firestoreEnabled: CALL_LOG_FIRESTORE_ENABLED,
    firestoreDatabaseId: CALL_LOG_FIRESTORE_DATABASE_ID,
    googleProjectId: GOOGLE_CLOUD_PROJECT
});
const adminAuth = createAdminBasicAuth();

const REALTIME_ENV = {
    REALTIME_MODEL,
    REALTIME_REASONING_EFFORT
};

const getEffectiveRealtimeSettings = async (runtimeSettings) => resolveRealtimeSettings({
    env: REALTIME_ENV,
    runtimeSettings: runtimeSettings || await runtimeSettingsStore.get()
});

const requireAdminAppAuth = async (request, reply) => {
    const result = await adminAuth.authenticate(request);
    if (result.ok) return;

    if (result.configured === false) {
        reply.code(503).send({
            error: 'admin_auth_unconfigured',
            message: 'Admin UI credentials are not configured'
        });
        return;
    }

    reply
        .header('WWW-Authenticate', 'Basic realm="Cor Voice Admin"')
        .code(401)
        .send({ error: 'unauthorized' });
};

fastify.addHook('onRequest', async (request, reply) => {
    if (request.url === '/app' || request.url.startsWith('/app/')) {
        await requireAdminAppAuth(request, reply);
    }
});

fastify.register(registerAdminRoutes, {
    store: callLogStore,
    settingsStore: runtimeSettingsStore,
    auth: adminAuth,
    config: async ({ runtimeSettings } = {}) => getRuntimeConfig({
        systemMessage: RESOLVED_SYSTEM_MESSAGE,
        runtimeSettings: runtimeSettings || await runtimeSettingsStore.get()
    }),
    auditLog
});

// Admin v2 — knowledge/calls/escalations CRUD with per-route permissions,
// If-Match versioning, and PII projection. Services come from the compiled
// backend; when dist-backend is missing the routes are not registered and
// the legacy admin API keeps working.
const adminV2 = await initAdminV2Services({ log: console });
if (adminV2.loaded) {
    const { registerAdminV2Routes } = await import('./lib/admin-v2-routes.js');
    fastify.register(registerAdminV2Routes, {
        adminAuth,
        knowledgeService: adminV2.knowledgeService,
        knowledgeRepository: adminV2.knowledgeRepo,
        knowledgeReader: adminV2.knowledgeReader,
        callService: adminV2.callService,
        escalationService: adminV2.escalationService
    });
} else {
    console.warn('admin v2 routes disabled: backend services failed to initialize');
}

// REVIEW-R09: real calls must also land in callLogsV2 — the projector uses
// the same repositories as the admin v2 API so corrections, escalations and
// audit events apply to production traffic. A missing build degrades to a
// no-op rather than breaking calls.
await initCallProjection({
    callRepo: adminV2.callRepo ?? null,
    escalationRepo: adminV2.escalationRepo ?? null,
    log: console
});

// Voice knowledge tool — reads only the current published release through
// the same repository the admin API writes to. A failed init simply means
// the tool is never advertised to the provider.
await initKnowledgeTool({ knowledgeRepo: adminV2.knowledgeRepo ?? null, log: console });
const KNOWLEDGE_TOOL_DEF = getKnowledgeToolDef();

fastify.post('/api/admin/notifications/retry/:outboxId', {
    preHandler: requireAdminAppAuth
}, async (request, reply) => {
    if (!notificationOutbox.isEnabled()) {
        return reply.code(503).send({ error: 'notification_outbox_disabled' });
    }

    const result = await notificationOutbox.retry(request.params.outboxId);
    auditLog('admin.notification.retry', {
        actor: request.adminAuth?.actor || 'admin',
        target: request.params.outboxId,
        result: result.ok ? 'success' : 'failure',
        metadata: { status: result.status || '', reason: result.reason || '' }
    });
    return reply.code(result.ok ? 200 : 502).send(result);
});

if (existsSync(ADMIN_APP_INDEX_PATH)) {
    const assetsDir = join(ADMIN_APP_DIST_DIR, 'assets');
    if (existsSync(assetsDir)) {
        fastify.register(fastifyStatic, {
            root: assetsDir,
            prefix: '/app/assets/'
        });
    }
}

const getPublicBaseUrl = (request) => {
    if (TWILIO_PUBLIC_BASE_URL) return TWILIO_PUBLIC_BASE_URL.replace(/\/$/, '');
    const proto = request.headers['x-forwarded-proto'] || request.protocol || 'https';
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    return `${proto}://${host}`.replace(/\/$/, '');
};

const getPublicUrl = (request, path) => {
    const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
    return `${getPublicBaseUrl(request)}${normalizedPath}`;
};

const isValidTwilioWebhook = ({ request, configuredUrl = '' } = {}) => {
    if (!SHOULD_VALIDATE_TWILIO_SIGNATURE) return true;

    return validateTwilioSignature({
        authToken: TWILIO_AUTH_TOKEN,
        signature: request.headers['x-twilio-signature'],
        url: configuredUrl || getPublicUrl(request, request.raw.url || request.url),
        params: request.body || {}
    });
};

const sendTwiml = (reply, body) => reply.type('text/xml').send(body);

const summarizeExtractionForLog = (extracted = {}) => ({
    callbackRequired: Boolean(extracted.callbackRequired),
    hasCustomerName: Boolean(extracted.customerName),
    hasCustomerPhoneNumber: Boolean(extracted.customerPhoneNumber),
    hasPreferredDatetime: Boolean(extracted.preferredDatetime),
    intentLength: String(extracted.intent || '').length,
    summaryLength: String(extracted.summary || '').length
});

const appendTurn = (session, role, text, { provisional = false } = {}) => {
    const normalizedText = String(text || '').trim();
    if (!normalizedText || normalizedText === 'Agent message not found') return;

    const lastTurn = session.turns.at(-1);
    if (lastTurn?.role === role && lastTurn.text === normalizedText && lastTurn.provisional === provisional) return;

    const label = role === 'agent' ? 'Agent' : 'User';
    session.transcript += `${label}: ${normalizedText}${provisional ? ' [provisional]' : ''}\n`;
    session.turns.push({ role, text: normalizedText, at: new Date().toISOString(), provisional });
};

const buildTurnDetectionConfig = () => {
    if (VAD_TYPE === 'semantic_vad') {
        return {
            type: VAD_TYPE,
            eagerness: VAD_EAGERNESS,
            create_response: SHOULD_CREATE_RESPONSE_FROM_VAD,
            interrupt_response: SHOULD_INTERRUPT_RESPONSE
        };
    }

    return {
        type: VAD_TYPE,
        threshold: Number(VAD_THRESHOLD),
        prefix_padding_ms: Number(VAD_PREFIX_PADDING_MS),
        silence_duration_ms: Number(VAD_SILENCE_DURATION_MS),
        create_response: SHOULD_CREATE_RESPONSE_FROM_VAD,
        interrupt_response: SHOULD_INTERRUPT_RESPONSE
    };
};

const buildRealtimeSessionConfig = ({
    realtimeModel = REALTIME_MODEL,
    realtimeReasoningEffort = REALTIME_REASONING_EFFORT,
    realtimeVoice = VOICE,
    handoffFallback = false,
    handoffSummary = '',
    additionalInstructions = '',
    includeModel = true
} = {}) => {
    const fallbackInstructions = handoffFallback
        ? [
            'これは担当者への転送が成立しなかった後の再受付です。',
            '担当者への転送toolは使わず、再転送もしないでください。',
            '「担当者が出なかったため、引き続きコールセンターで承ります」と自然に案内してください。',
            '先ほどの受付内容を踏まえ、まだ伺えていない情報を一つずつ確認してください。確認できたら内容を復唱し、折り返し要否を確認してから終話してください。',
            handoffSummary ? `先ほどの受付内容の要約（参考）: ${handoffSummary}` : ''
        ].filter(Boolean).join('\n')
        : '';
    const session = {
        type: 'realtime',
        instructions: fallbackInstructions
            ? `${RESOLVED_SYSTEM_MESSAGE}\n${fallbackInstructions}${additionalInstructions ? `\n${additionalInstructions}` : ''}`
            : `${RESOLVED_SYSTEM_MESSAGE}${additionalInstructions ? `\n${additionalInstructions}` : ''}`,
        audio: {
            input: {
                format: { type: AUDIO_FORMAT },
                noise_reduction: AUDIO_NOISE_REDUCTION === 'null' ? null : { type: AUDIO_NOISE_REDUCTION },
                transcription: {
                    model: TRANSCRIPTION_MODEL
                },
                turn_detection: buildTurnDetectionConfig()
            },
            output: {
                format: { type: AUDIO_FORMAT },
                voice: realtimeVoice
            }
        }
    };

    if (includeModel) session.model = realtimeModel;

    // RECHECK-RR04: tool defs are shared between the Responses/Live
    // delegation channel (which accepts `strict`) and the Realtime
    // session.tools surface (which rejects it as unknown_parameter).
    // Strip Realtime-unsupported fields here instead of forking the defs.
    const toRealtimeTool = (tool) => {
        if (!tool) return tool;
        const { strict, ...rest } = tool;
        return rest;
    };
    session.tools = [
        VALIDATE_CALLBACK_PHONE_TOOL,
        ...(KNOWLEDGE_TOOL_DEF ? [KNOWLEDGE_TOOL_DEF] : []),
        ...(TRANSFER_TO_HUMAN_TOOL && !handoffFallback ? [TRANSFER_TO_HUMAN_TOOL] : []),
        ...(FINISH_RECEPTION_TOOL ? [FINISH_RECEPTION_TOOL] : [])
    ].map(toRealtimeTool);
    if (session.tools.length > 0) {
        session.tool_choice = 'auto';
    }

    if (shouldSetRealtimeReasoning(realtimeModel)) {
        session.reasoning = {
            effort: realtimeReasoningEffort
        };
    }

    return session;
};

// セッション管理
const sessions = new Map();

// ログに出力するイベントタイプのリスト
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated',
    'response.created',
    'response.output_text.done',
    'response.output_audio_transcript.done',
    'response.function_call_arguments.done',
    'conversation.item.input_audio_transcription.completed',
    'conversation.item.deleted',
    'error'
];

// ルート
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

fastify.get('/healthz', async (request, reply) => {
    reply.send({ status: 'ok' });
});

fastify.get('/health', async (request, reply) => {
    reply.send({ status: 'ok' });
});

fastify.get('/app', async (request, reply) => {
    reply.redirect('/app/');
});

fastify.get('/app/*', async (request, reply) => {
    if (!existsSync(ADMIN_APP_INDEX_PATH)) {
        return reply.code(404).send({ error: 'Admin app has not been built.' });
    }

    return reply.type('text/html').send(readFileSync(ADMIN_APP_INDEX_PATH, 'utf8'));
});

// Twilioが着信を処理するルート
fastify.all('/incoming-call', async (request, reply) => {
    const callSid = request.body?.CallSid || '';
    const from = request.body?.From || '';
    const to = request.body?.To || '';

    if (!isValidTwilioWebhook({
        request,
        configuredUrl: getTwilioWebhookUrl(request, TWILIO_WEBHOOK_URL)
    })) {
        auditLog('twilio.webhook.rejected', {
            actor: 'twilio',
            target: callSid || 'incoming-call',
            result: 'failure',
            metadata: { reason: 'invalid_signature', hasSignature: Boolean(request.headers['x-twilio-signature']) }
        });
        return reply.code(403).send('Forbidden');
    }

    auditLog('twilio.webhook.accepted', {
        actor: 'twilio',
        target: callSid || 'incoming-call',
        metadata: {
            signatureValidation: SHOULD_VALIDATE_TWILIO_SIGNATURE,
            from: maskPhone(request.body?.From),
            to: maskPhone(request.body?.To)
        }
    });

    const mediaStreamTwiml = buildMediaStreamTwimlWithParams({
        host: request.headers.host,
        from,
        to,
        streamToken: createStreamToken({ callSid, secret: TWILIO_AUTH_TOKEN })
    });
    const twimlResponse = DTMF_GATEWAY_CONFIG.enabled
        ? buildDtmfGatewayTwiml({
            actionUrl: getPublicUrl(request, '/gateway/route'),
            fallbackUrl: getPublicUrl(request, '/gateway/route?digits=none'),
            timeoutSeconds: DTMF_GATEWAY_CONFIG.timeoutSeconds
        })
        : mediaStreamTwiml;

    return sendTwiml(reply, twimlResponse);
});

fastify.all('/gateway/route', async (request, reply) => {
    const callSid = request.body?.CallSid || request.query?.CallSid || 'gateway-route';
    if (!isValidTwilioWebhook({ request })) {
        auditLog('twilio.webhook.rejected', {
            actor: 'twilio',
            target: callSid,
            result: 'failure',
            metadata: { endpoint: '/gateway/route', reason: 'invalid_signature' }
        });
        return reply.code(403).send('Forbidden');
    }

    const fallbackTwiml = buildMediaStreamTwimlWithParams({
        host: request.headers.host,
        from: request.body?.From || '',
        to: request.body?.To || '',
        streamToken: createStreamToken({ callSid: request.body?.CallSid || callSid, secret: TWILIO_AUTH_TOKEN })
    });
    const digits = request.body?.Digits || request.query?.digits || 'none';
    const twimlResponse = buildGatewayRouteTwiml({
        digits,
        practiceRedirectUrl: DTMF_GATEWAY_CONFIG.practiceRedirectUrl,
        fallbackTwiml
    });

    auditLog('twilio.gateway.routed', {
        actor: 'twilio',
        target: callSid,
        metadata: {
            digits: String(digits) === '5' ? '5' : 'other',
            practiceConfigured: Boolean(DTMF_GATEWAY_CONFIG.practiceRedirectUrl),
            signatureValidation: SHOULD_VALIDATE_TWILIO_SIGNATURE
        }
    });
    return sendTwiml(reply, twimlResponse);
});

fastify.post('/handoff/whisper', async (request, reply) => {
    const callSid = request.query?.call_sid || request.body?.CallSid || '';
    if (!HANDOFF_CONFIG.enabled) return reply.code(404).send({ error: 'handoff_disabled' });
    if (!isValidTwilioWebhook({ request })) return reply.code(403).send('Forbidden');

    const context = await handoffContextStore.get(callSid);
    const summary = context?.whisperSummary || context?.summary || '受付内容の確認';
    await handoffContextStore.update(callSid, { status: 'whisper_started' });
    auditLog('handoff.whisper.started', {
        actor: 'twilio',
        target: callSid,
        metadata: { hasSummary: Boolean(context?.summary) }
    });

    return sendTwiml(reply, buildWhisperTwiml({
        summary,
        acceptDigit: HANDOFF_CONFIG.whisperAcceptDigit,
        rejectDigit: HANDOFF_CONFIG.whisperRejectDigit,
        confirmUrl: getPublicUrl(request, `/handoff/whisper-confirm?call_sid=${encodeURIComponent(callSid)}`)
    }));
});

fastify.post('/handoff/whisper-confirm', async (request, reply) => {
    const callSid = request.query?.call_sid || request.body?.CallSid || '';
    if (!HANDOFF_CONFIG.enabled) return reply.code(404).send({ error: 'handoff_disabled' });
    if (!isValidTwilioWebhook({ request })) return reply.code(403).send('Forbidden');

    const digits = String(request.body?.Digits || '');
    const accepted = digits === HANDOFF_CONFIG.whisperAcceptDigit;
    const rejectedToCallCenter = digits === HANDOFF_CONFIG.whisperRejectDigit;
    await handoffContextStore.update(callSid, {
        status: accepted ? 'whisper_accepted' : 'whisper_rejected',
        whisperAccepted: accepted,
        whisperRejectDigit: rejectedToCallCenter ? digits : ''
    });
    auditLog('handoff.whisper.completed', {
        actor: 'twilio',
        target: callSid,
        metadata: { accepted }
    });
    return sendTwiml(reply, buildWhisperConfirmTwiml({ accepted, rejectedToCallCenter }));
});

fastify.post('/handoff/leg-status', async (request, reply) => {
    const callSid = request.query?.call_sid || request.body?.CallSid || '';
    if (!HANDOFF_CONFIG.enabled) return reply.code(404).send({ error: 'handoff_disabled' });
    if (!isValidTwilioWebhook({ request })) return reply.code(403).send('Forbidden');

    auditLog('handoff.leg.status', {
        actor: 'twilio',
        target: callSid,
        metadata: {
            callStatus: request.body?.CallStatus || '',
            dialCallStatus: request.body?.DialCallStatus || '',
            duration: request.body?.DialCallDuration || ''
        }
    });
    return reply.code(204).send();
});

fastify.post('/handoff/dial-status', async (request, reply) => {
    const callSid = request.query?.call_sid || request.body?.CallSid || '';
    if (!HANDOFF_CONFIG.enabled) return reply.code(404).send({ error: 'handoff_disabled' });
    if (!isValidTwilioWebhook({ request })) return reply.code(403).send('Forbidden');

    let context = null;
    try {
        context = await handoffContextStore.get(callSid);
    } catch (error) {
        console.error('Failed to load handoff dial context:', error.message);
    }
    const whisperRejected = context?.status === 'whisper_rejected';
    const connected = isHandoffCallConnected(request.body?.DialCallStatus, context);
    let fallbackTwiml = '';
    if (!connected) {
        const text = [
            '担当者への転送が成立しませんでした。',
            context?.summary ? `受付内容: ${context.summary}` : '受付内容は管理画面で確認してください。',
            '通話はコールセンターへ戻り、残りの情報を確認して受付を完了します。'
        ].join('\n');
        try {
            await notificationOutbox.enqueue({
                kind: 'handoff-fallback',
                callId: callSid,
                subject: `【電話受付】担当者不応答 ${callSid}`,
                text
            });
        } catch (error) {
            // Notification failure must not strand the caller in the Dial leg.
            console.error('Failed to enqueue handoff fallback notification:', error.message);
        }
        try {
            await handoffContextStore.update(callSid, {
                status: 'fallback_returned',
                dialCallStatus: request.body?.DialCallStatus || ''
            });
        } catch (error) {
            console.error('Failed to update handoff fallback context:', error.message);
        }
        fallbackTwiml = buildMediaStreamTwimlWithParams({
            host: request.headers.host,
            from: request.body?.From || '',
            to: request.body?.To || '',
            handoffFallback: true,
            introMessage: '担当者におつなぎできなかったため、引き続きコールセンターでご用件を確認いたします。',
            streamToken: createStreamToken({ callSid, secret: TWILIO_AUTH_TOKEN })
        });
    } else {
        await handoffContextStore.update(callSid, { status: 'connected', dialCallStatus: 'completed' });
    }

    auditLog('handoff.dial.completed', {
        actor: 'twilio',
        target: callSid,
        metadata: {
            dialCallStatus: request.body?.DialCallStatus || '',
            connected,
            whisperRejected
        }
    });
    return sendTwiml(reply, connected ? buildDialStatusTwiml({ connected }) : fallbackTwiml);
});

// メディアストリーム用のWebSocketルート
fastify.register(async (fastify) => {
    const handleMediaStreamConnection = async (connection, req) => {
        // Access boundary: the upgrade must carry the stream token issued by a
        // signature-verified webhook. Rejected connections close before any
        // provider socket is created — an unauthenticated stream can never
        // reach OpenAI.
        const streamAuth = verifyMediaStreamRequest(req, {
            secret: TWILIO_AUTH_TOKEN,
            enabled: TWILIO_STREAM_AUTH_ENABLED
        });
        let boundCallSid = streamAuth.callSid || '';
        let streamAuthDeferred = false;
        let authDeadline = null;
        if (!streamAuth.ok) {
            // An invalid token is rejected outright. A MISSING token is
            // deferred: Twilio drops the <Stream url> query on connect, so the
            // credential may still arrive via <Parameter> in the start frame
            // (start.customParameters.stream_token). The provider socket is
            // NOT opened while deferred — connectProvider() runs only after
            // the start-frame token verifies, and the window is bounded by a
            // short deadline.
            if (streamAuth.reason !== 'missing_stream_token') {
                auditLog('twilio.media_stream.rejected', {
                    actor: 'unknown',
                    target: 'media-stream',
                    result: 'failure',
                    metadata: { reason: streamAuth.reason }
                });
                connection.close(4403, 'forbidden');
                return;
            }
            streamAuthDeferred = true;
            authDeadline = setTimeout(() => {
                if (streamAuthDeferred) connection.close(4403, 'stream_auth_timeout');
            }, 10_000);
            authDeadline.unref?.();
        }
        if (streamAuth.bypassed) {
            console.warn('TWILIO_STREAM_AUTH_ENABLED=false — unauthenticated media streams accepted (development only)');
        }
        console.log('Media stream connected');
        const pendingTwilioMessages = [];
        let twilioMessageHandler = null;
        let twilioCloseHandler = null;
        let pendingTwilioClose = null;
        const maxPendingTwilioMessages = 300;

        // Twilio sends connected/start immediately after the WebSocket handshake.
        // Install these listeners before any awaited runtime-settings lookup so the
        // initial stream metadata cannot be lost on a cold start.
        connection.on('message', (message) => {
            if (twilioMessageHandler) {
                twilioMessageHandler(message);
                return;
            }

            if (pendingTwilioMessages.length < maxPendingTwilioMessages) {
                pendingTwilioMessages.push(message);
            } else {
                console.warn('Dropping queued Twilio Media Stream message after buffer limit');
            }
        });

        connection.on('close', (code, reason) => {
            if (twilioCloseHandler) {
                void twilioCloseHandler(code, reason);
                return;
            }

            pendingTwilioClose = { code, reason };
        });

        let realtimeSettings;
        try {
            realtimeSettings = await getEffectiveRealtimeSettings();
        } catch (error) {
            console.error('Failed to read runtime model settings, falling back to env:', error.message);
            realtimeSettings = await getEffectiveRealtimeSettings({});
        }

        const sessionId = boundCallSid || req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || {
            id: sessionId,
            callSid: sessionId,
            transcript: '',
            turns: [],
            streamSid: null,
            startedAt: new Date(),
            status: 'in_progress'
        };
        sessions.set(sessionId, session);

        // Common call lifecycle. Provider (re)starts, delayed tool work and
        // timers must all check this — nothing may start a provider after
        // handoff, caller disconnect, or normal close.
        const callLifecycle = {
            phase: 'starting' // starting -> active -> handoff|closing -> closed
        };
        session.lifecycle = callLifecycle.phase;

        // Playback epoch: every Twilio `clear` invalidates marks emitted before
        // it, because Twilio still echoes cleared marks. A stale mark echo must
        // never satisfy the end-call playback check.
        session.playback = session.playback || { epoch: 0 };

        const createRealtimeSocket = (model) => new WebSocket(
            // Same override pattern as OPENAI_LIVE_WS_URL — lets the wire
            // contract be exercised against a local stub in tests.
            process.env.OPENAI_REALTIME_WS_URL
                || `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`
                }
            }
        );
        const createLiveSocket = () => new WebSocket(process.env.OPENAI_LIVE_WS_URL || LIVE_WS_URL, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`
            }
        });
        let activeRealtimeModel = realtimeSettings.realtimeModel;
        let activeRealtimeVoice = VOICE;
        // Codec contract is validated up front — an unsupported format/rate
        // combination must never reach the provider as silent audio garbage.
        const liveAudioConfigError = (() => {
            const rate = Number(LIVE_AUDIO_RATE);
            if (LIVE_AUDIO_FORMAT === 'audio/pcmu') {
                return rate === 8000 ? '' : 'audio/pcmu requires rate 8000 (G.711 is 8 kHz)';
            }
            if (LIVE_AUDIO_FORMAT === 'audio/pcm') {
                return [8000, 16000, 24000].includes(rate) ? '' : `unsupported audio/pcm rate ${rate}`;
            }
            return `unsupported LIVE_AUDIO_FORMAT ${LIVE_AUDIO_FORMAT}`;
        })();
        let providerMode = VOICE_PROVIDER === 'live' ? 'live' : 'realtime';
        if (providerMode === 'live' && liveAudioConfigError) {
            auditLog('live.config.rejected', {
                actor: 'system',
                target: sessionId,
                result: 'failure',
                metadata: { reason: liveAudioConfigError, fallback: 'realtime' }
            });
            console.error(`LIVE_AUDIO config invalid: ${liveAudioConfigError}; falling back to realtime`);
            providerMode = 'realtime';
        }
        // REVIEW-R01: the provider socket is a paid side effect — it is
        // created by connectProvider() only AFTER stream authentication
        // succeeds. Deferred-auth streams (token carried in
        // start.customParameters) stay null until the start frame verifies.
        let openAiWs = null;
        const liveState = {
            started: false,
            startTimer: null,
            codec: createLiveAudioCodec({
                inputFormatType: LIVE_AUDIO_FORMAT,
                inputRate: Number(LIVE_AUDIO_RATE)
            }),
            delegation: createLiveDelegationTracker(),
            userFrag: '',
            userFragTimer: null,
            agentFrag: '',
            agentFragTimer: null,
            outputAudioActive: false,
            lastAudioDeltaAt: 0,
            complexMode: false,
            complexModeEventId: '',
            everStarted: false,
            closedResolver: null,
            drainTimer: null,
            closeSent: false
        };
        let realtimeSocketReady = false;
        let responseInProgress = false;
        let responseCreatePending = false;
        let pendingResponseAfterCurrent = false;
        let callEndTimer = null;
        let callEndMarkTimeout = null;
        const pendingInboundAudio = [];
        const pendingOutboundAudio = [];
        const maxPendingAudioMessages = 300;

        const sendAudioToOpenAi = (payload) => {
            if (openAiWs?.readyState !== WebSocket.OPEN || !payload) return false;

            if (providerMode === 'live') {
                if (!liveState.started) return false;
                openAiWs?.send(JSON.stringify(liveAudioAppend(liveState.codec.encodeInput(payload))));
                return true;
            }

            openAiWs?.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: payload
            }));
            return true;
        };

        const flushPendingInboundAudio = () => {
            while (openAiWs?.readyState === WebSocket.OPEN && pendingInboundAudio.length > 0) {
                sendAudioToOpenAi(pendingInboundAudio.shift());
            }
        };

        const sendAudioToTwilio = (delta) => {
            if (!delta || connection.readyState !== WebSocket.OPEN) return;

            if (!session.streamSid) {
                if (pendingOutboundAudio.length < maxPendingAudioMessages) {
                    pendingOutboundAudio.push(delta);
                } else {
                    console.warn('Dropping queued outbound audio until Twilio stream start');
                }
                return;
            }

            connection.send(JSON.stringify({
                event: 'media',
                streamSid: session.streamSid,
                media: { payload: Buffer.from(delta, 'base64').toString('base64') }
            }));
        };

        const flushPendingOutboundAudio = () => {
            if (!session.streamSid || connection.readyState !== WebSocket.OPEN) return;

            while (pendingOutboundAudio.length > 0) {
                sendAudioToTwilio(pendingOutboundAudio.shift());
            }
        };

        const requestCallEnd = ({ source, reason }) => {
            if (!CALL_END_CONFIG.workflowEnabled) return;

            session.callEnd = {
                ...(session.callEnd || {}),
                requested: true,
                source,
                reason: reason || 'reception_completed',
                requestedAt: session.callEnd?.requestedAt || new Date().toISOString()
            };
        };

        const completeCallAfterFinalAudio = async (trigger) => {
            if (session.callEnd?.completed) return;

            session.callEnd = {
                ...(session.callEnd || {}),
                completed: true,
                completedAt: new Date().toISOString(),
                trigger
            };

            let twilioResult = {
                ok: false,
                skipped: true,
                reason: CALL_END_CONFIG.hangupEnabled ? 'not_attempted' : 'hangup_disabled'
            };

            if (CALL_END_CONFIG.hangupEnabled) {
                // Every Twilio REST side effect passes the shared ActionGate:
                // lifecycle, revision and idempotency are checked in one place.
                const gateVerdict = await actionGate.evaluate({
                    actionId: `call_end:${session.callSid || sessionId}`,
                    kind: 'call_end',
                    target: 'twilio_call',
                    targetRevision: session.turns.length,
                    facts: {
                        allowedKinds: ['call_end'],
                        allowedTargets: ['twilio_call'],
                        policyAllows: true,
                        confirmationSatisfied: true,
                        currentRevision: session.turns.length,
                        lifecyclePhase: callLifecycle.phase
                    }
                });

                if (!gateVerdict.allow) {
                    twilioResult = { ok: false, skipped: true, reason: `gate_denied:${gateVerdict.reason}` };
                    auditLog('call.end.gate_denied', {
                        actor: 'system',
                        target: session.callSid || sessionId,
                        result: 'failure',
                        metadata: { reason: gateVerdict.reason }
                    });
                } else {
                    const ledger = gateVerdict.ledger;
                    const actionId = gateVerdict.actionId;
                    try {
                        if (ledger) await ledger.markRunning(actionId);
                        twilioResult = await updateTwilioCallStatus({
                            accountSid: session.accountSid,
                            callSid: session.callSid,
                            authToken: TWILIO_AUTH_TOKEN
                        });
                        if (ledger) {
                            await ledger.complete(
                                actionId,
                                twilioResult.ok ? 'succeeded' : 'failed',
                                twilioResult.ok ? `status_${twilioResult.statusCode}` : (twilioResult.reason || 'failed')
                            );
                        }
                    } catch (error) {
                        twilioResult = {
                            ok: false,
                            skipped: false,
                            reason: 'twilio_api_exception'
                        };
                        // The hangup may have reached Twilio — mark unknown so
                        // no blind retry double-executes it.
                        if (ledger) await ledger.complete(actionId, 'outcome_unknown', error.message);
                        console.error(`Failed to complete Twilio call ${session.callSid}: ${error.message}`);
                    }
                }
            }

            session.callEnd.twilioResult = twilioResult;
            const callEndSucceeded = twilioResult.ok || (!CALL_END_CONFIG.hangupEnabled && twilioResult.skipped);
            auditLog('call.end.requested', {
                actor: 'system',
                target: session.callSid || sessionId,
                result: callEndSucceeded ? 'success' : 'failure',
                metadata: {
                    trigger,
                    source: session.callEnd.source,
                    reason: session.callEnd.reason,
                    twilioStatusCode: twilioResult.statusCode || '',
                    twilioSkippedReason: twilioResult.skipped ? twilioResult.reason : ''
                }
            });

            if (connection.readyState === WebSocket.OPEN) {
                connection.close(1000, `call_end_${trigger}`);
            }
        };

        const scheduleCallCompletion = (trigger) => {
            if (!session.callEnd?.requested || session.callEnd?.completed || callEndTimer) return;
            if (callEndMarkTimeout) clearTimeout(callEndMarkTimeout);

            callEndTimer = setTimeout(() => {
                callEndTimer = null;
                completeCallAfterFinalAudio(trigger).catch((error) => {
                    console.error(`Failed to finish call end workflow: ${error.message}`);
                });
            }, CALL_END_CONFIG.graceMs);
        };

        // A caller correction/interruption while the end-of-call workflow is
        // pending revokes it: the conversation demonstrably continued, so the
        // recorded request, its mark and every timer are invalidated together.
        const revokeCallEnd = (trigger) => {
            if (!session.callEnd?.requested || session.callEnd?.completed || session.callEnd?.revoked) return false;
            if (callEndTimer) {
                clearTimeout(callEndTimer);
                callEndTimer = null;
            }
            if (callEndMarkTimeout) {
                clearTimeout(callEndMarkTimeout);
                callEndMarkTimeout = null;
            }
            session.callEnd = {
                ...(session.callEnd || {}),
                requested: false,
                revoked: true,
                revokedAt: new Date().toISOString(),
                revokedBy: trigger,
                markName: null,
                markEpoch: null
            };
            auditLog('call.end.revoked', {
                actor: 'system',
                target: session.callSid || sessionId,
                metadata: { trigger }
            });
            return true;
        };

        // Every Twilio `clear` invalidates marks emitted before it — Twilio
        // echoes cleared marks back, so only marks from the current epoch may
        // satisfy the end-call playback check.
        const invalidatePlaybackMarks = (reason) => {
            session.playback.epoch += 1;
            if (session.callEnd?.markName) {
                session.callEnd.markName = null;
                session.callEnd.markEpoch = null;
                if (callEndMarkTimeout) {
                    clearTimeout(callEndMarkTimeout);
                    callEndMarkTimeout = null;
                }
                if (SHOULD_LOG_REALTIME_EVENTS) {
                    console.log(`Invalidated end-call mark after clear (${reason})`);
                }
            }
        };

        const sendEndCallMark = (reason) => {
            if (
                !CALL_END_CONFIG.workflowEnabled
                || !session.callEnd?.requested
                || session.callEnd?.completed
                || session.callEnd?.markName
            ) {
                return;
            }

            if (!session.streamSid || connection.readyState !== WebSocket.OPEN) {
                scheduleCallCompletion(`no_mark_${reason}`);
                return;
            }

            const markName = `end_call_${Date.now()}`;
            session.callEnd.markName = markName;
            session.callEnd.markEpoch = session.playback.epoch;
            session.callEnd.markSentAt = new Date().toISOString();
            connection.send(JSON.stringify({
                event: 'mark',
                streamSid: session.streamSid,
                mark: { name: markName }
            }));

            callEndMarkTimeout = setTimeout(() => {
                callEndMarkTimeout = null;
                scheduleCallCompletion(`mark_timeout_${reason}`);
            }, CALL_END_CONFIG.markTimeoutMs);
        };

        const startHandoff = async ({ reason, destination = 'general' } = {}) => {
            // Atomic claim: the starting flag is set synchronously so a second
            // trigger racing through the same session cannot double-dial.
            if (session.handoff?.started || session.handoff?.starting) return;
            session.handoff = { ...(session.handoff || {}), starting: true };

            const callSid = session.callSid || session.id;
            const selectedDestination = HANDOFF_CONFIG.destinationNumbers[destination]
                ? destination
                : 'general';
            const recipient = HANDOFF_CONFIG.destinationNumbers[selectedDestination]
                || HANDOFF_CONFIG.numbers[0]
                || '';
            const summary = summarizeHandoffTurns(session.turns);
            const whisperSummary = summarizeHandoffWhisper(session.turns);
            const context = {
                reason: reason || '担当者対応が必要',
                destination: selectedDestination,
                summary: summary || '受付内容を管理画面で確認してください。',
                whisperSummary,
                from: maskPhone(session.from),
                to: maskPhone(session.to),
                status: 'requested',
                createdAt: new Date().toISOString()
            };

            try {
                await handoffContextStore.save(callSid, context);

                // The transfer TwiML update is a Twilio REST side effect —
                // it runs only after the shared ActionGate verifies lifecycle,
                // revision, destination allowlist and idempotency.
                const gateVerdict = await actionGate.evaluate({
                    actionId: `handoff_start:${callSid}:${selectedDestination}`,
                    kind: 'handoff_start',
                    target: selectedDestination,
                    targetRevision: session.turns.length,
                    facts: {
                        allowedKinds: ['handoff_start'],
                        allowedTargets: ['contract', 'general'],
                        policyAllows: true,
                        confirmationSatisfied: true,
                        currentRevision: session.turns.length,
                        lifecyclePhase: callLifecycle.phase
                    }
                });
                if (!gateVerdict.allow) {
                    session.handoff = { started: false, starting: false, failed: true, reason: `gate_denied:${gateVerdict.reason}` };
                    auditLog('handoff.start.failed', {
                        actor: 'system',
                        target: callSid,
                        result: 'failure',
                        metadata: { reason: `gate_denied:${gateVerdict.reason}` }
                    });
                    sendRealtimeResponseCreate('handoff_gate_denied');
                    return;
                }
                const ledger = gateVerdict.ledger;
                const actionId = gateVerdict.actionId;
                if (ledger) await ledger.markRunning(actionId);

                const twiml = buildHandoffDialTwiml({
                    callSid,
                    numbers: recipient ? [recipient] : [],
                    callerId: HANDOFF_CONFIG.callerId || session.to,
                    timeoutSeconds: HANDOFF_CONFIG.dialTimeoutSeconds,
                    whisperUrl: getPublicUrl(req, '/handoff/whisper'),
                    dialStatusUrl: getPublicUrl(req, `/handoff/dial-status?call_sid=${encodeURIComponent(callSid)}`),
                    legStatusUrl: getPublicUrl(req, `/handoff/leg-status?call_sid=${encodeURIComponent(callSid)}`)
                });
                const result = await updateTwilioCallTwiml({
                    accountSid: session.accountSid,
                    callSid,
                    authToken: TWILIO_AUTH_TOKEN,
                    twiml
                });
                if (ledger) {
                    await ledger.complete(
                        actionId,
                        result.ok ? 'succeeded' : 'failed',
                        result.ok ? `status_${result.statusCode}` : (result.reason || 'failed')
                    );
                }

                if (!result.ok) {
                    session.handoff = { started: false, starting: false, failed: true, reason: result.reason || 'twilio_update_failed' };
                    auditLog('handoff.start.failed', {
                        actor: 'system',
                        target: callSid,
                        result: 'failure',
                        metadata: { reason: result.reason || 'twilio_update_failed', statusCode: result.statusCode || '' }
                    });
                    sendRealtimeResponseCreate('handoff_failed');
                    return;
                }

                session.handoff = {
                    started: true,
                    starting: false,
                    reason: context.reason,
                    startedAt: new Date().toISOString()
                };
                callLifecycle.phase = 'handoff';
                session.lifecycle = callLifecycle.phase;
                auditLog('handoff.start.succeeded', {
                    actor: 'system',
                    target: callSid,
                    metadata: {
                        from: context.from,
                        to: context.to,
                        destination: selectedDestination,
                        recipientCount: recipient ? 1 : 0
                    }
                });
                if (openAiWs?.readyState === WebSocket.OPEN) openAiWs?.close();
                if (connection.readyState === WebSocket.OPEN) connection.close(1000, 'handoff_started');
            } catch (error) {
                session.handoff = { started: false, starting: false, failed: true, reason: 'handoff_exception' };
                auditLog('handoff.start.failed', {
                    actor: 'system',
                    target: callSid,
                    result: 'failure',
                    metadata: { reason: 'handoff_exception' }
                });
                console.error(`Failed to start handoff: ${error.message}`);
                sendRealtimeResponseCreate('handoff_exception');
            }
        };

        // Knowledge lookups are async (release manifest read) — they run
        // BEFORE the synchronous tool-flow handler so every output reaches
        // the provider before the shared response.create. The result also
        // records which release answered the call for later audit.
        const handleKnowledgeToolCalls = async (event) => {
            if (!KNOWLEDGE_TOOL_DEF) return false;
            const calls = findKnowledgeToolCalls(event);
            if (calls.length === 0) return false;
            for (const toolCall of calls) {
                try {
                    const output = await executeKnowledgeCall(toolCall);
                    const meta = output._meta;
                    delete output._meta;
                    auditLog('knowledge.lookup', {
                        actor: 'voice_tool',
                        target: session.callSid || sessionId,
                        result: meta.status,
                        metadata: { releaseId: meta.releaseId, stale: meta.stale }
                    });
                    session.knowledgeLookups = session.knowledgeLookups || [];
                    session.knowledgeLookups.push({ releaseId: meta.releaseId, status: meta.status });
                    if (providerMode === 'live') {
                        const item = toLiveToolResultItem(output);
                        if (item) {
                            openAiWs?.send(JSON.stringify(liveItemCreate(item, `tool_${item.call_id || Date.now()}`)));
                        }
                        continue;
                    }
                    // REVIEW-R08: the Realtime API accepts tool output only
                    // inside a conversation.item.create envelope — a bare
                    // function_call_output item is rejected (invalid_value).
                    if (openAiWs?.readyState === WebSocket.OPEN) {
                        const envelope = output?.type === 'conversation.item.create'
                            ? output
                            : { type: 'conversation.item.create', item: output };
                        openAiWs?.send(JSON.stringify(envelope));
                    }
                } catch (error) {
                    auditLog('knowledge.lookup', {
                        actor: 'voice_tool',
                        target: session.callSid || sessionId,
                        result: 'failure',
                        metadata: { reason: error.message }
                    });
                }
            }
            return true;
        };

        const handleToolCalls = (event) => {
            const nonHandoffBusinessCall = isNonHandoffBusinessCall(session.turns);
            const complexSupportCallbackRequired = isComplaintCall(session.turns);
            const requireBusinessCallback = (nonHandoffBusinessCall && !isSalesBusinessCall(session.turns))
                || complexSupportCallbackRequired;
            // Transfer authority must not depend on the Realtime model socket
            // state — Live escalates through delegation instructions instead.
            const complexModeActive = providerMode === 'live'
                ? liveState.complexMode
                : activeRealtimeModel === COMPLEX_REALTIME_MODEL
                    || (session.modelEscalation?.status === 'active'
                        && ['complaint', 'complex_support'].includes(session.modelEscalation?.category));
            const result = handleRealtimeToolCalls({
                event,
                state: session,
                callEndConfig: CALL_END_CONFIG,
                handoffConfig: {
                    ...HANDOFF_CONFIG,
                    blockNonHandoffBusiness: nonHandoffBusinessCall,
                    requireCallbackContact: nonHandoffBusinessCall || complexSupportCallbackRequired,
                    requireBusinessCallback,
                    enforceRoutingPolicy: true
                },
                allowComplexComplaintHandoff: complexModeActive,
                onPhoneValidation: (metadata) => auditLog('callback_phone.validation', {
                    actor: 'realtime',
                    target: session.callSid || sessionId,
                    metadata
                })
            });
            if (!result.handled) return false;

            for (const output of result.outputs) {
                if (providerMode === 'live') {
                    const item = toLiveToolResultItem(output);
                    if (item) {
                        openAiWs?.send(JSON.stringify(liveItemCreate(item, `tool_${item.call_id || Date.now()}`)));
                    }
                    continue;
                }
                openAiWs?.send(JSON.stringify(output));
            }
            for (const callEndRequest of result.callEndRequests) {
                requestCallEnd(callEndRequest);
            }
            if (nonHandoffBusinessCall && result.responseReason === 'transfer_to_human_tool_output') {
                auditLog('handoff.blocked_by_business_policy', {
                    actor: 'system',
                    target: session.callSid || sessionId,
                    metadata: { policy: 'non_handoff_business' }
                });
            }
            if (result.handoffRequests.length > 0) {
                void startHandoff(result.handoffRequests[0]);
                return true;
            }
            sendRealtimeResponseCreate(result.responseReason);
            return true;
        };

        // Tool-response watchdog (live only): once a response.create is sent
        // after tool outputs, the provider must show continuation activity —
        // a rejected create or a stalled model otherwise leaves the caller in
        // unbounded silence (observed: 86s dead air on a real call when the
        // tool output never reached the provider). Stage 1 nudges the model
        // toward the graceful callback fallback; stage 2 ends the call through
        // the normal end-of-call workflow instead of leaving dead air.
        let toolWatchdogTimer = null;
        // ACCEPT-T02: while a tool continuation is pending, audible progress
        // only RESETS the silence window — it never disarms it (B05/B06).
        // The pending state ends on caller speech, session close, or call
        // end. Stage-1 nudges are capped so a provider that keeps emitting
        // filler without real recovery still reaches the call end.
        let toolWatchdogPending = false;
        let toolWatchdogNudges = 0;
        const TOOL_WATCHDOG_MAX_NUDGES = 2;
        const toolWatchdogMs = Math.min(Math.max(Number(LIVE_TOOL_WATCHDOG_MS) || 0, 0), 60000);
        const clearToolWatchdog = () => {
            if (toolWatchdogTimer) {
                clearTimeout(toolWatchdogTimer);
                toolWatchdogTimer = null;
            }
        };
        const disarmToolWatchdog = () => {
            toolWatchdogPending = false;
            toolWatchdogNudges = 0;
            clearToolWatchdog();
        };
        // RECHECK-RR02/N09: a frame of pure silence is not audible progress.
        // μ-law silence is 0xff/0x7f and PCM16 silence is 0x00 — a payload
        // made only of these bytes keeps the socket busy but says nothing.
        const SILENT_AUDIO_BYTES = new Set([0x00, 0x7f, 0xff]);
        const isSilentAudioDelta = (deltaBase64) => {
            if (!deltaBase64) return true;
            const bytes = Buffer.from(deltaBase64, 'base64');
            return bytes.length === 0 || bytes.every((b) => SILENT_AUDIO_BYTES.has(b));
        };
        const noteToolAudibleProgress = () => {
            // Real output arrived — push the deadline out but keep the
            // watchdog armed: a single filler burst must not satisfy the
            // pending tool continuation.
            if (toolWatchdogPending) armToolWatchdog(1);
        };
        const armToolWatchdog = (stage = 1) => {
            if (providerMode !== 'live' || toolWatchdogMs < 2000) return;
            if (!toolWatchdogPending) toolWatchdogNudges = 0;
            toolWatchdogPending = true;
            clearToolWatchdog();
            toolWatchdogTimer = setTimeout(() => {
                toolWatchdogTimer = null;
                if (!toolWatchdogPending) return;
                if (openAiWs?.readyState !== WebSocket.OPEN || providerMode !== 'live') return;
                if (stage === 1 && toolWatchdogNudges < TOOL_WATCHDOG_MAX_NUDGES) {
                    toolWatchdogNudges += 1;
                    auditLog('live.tool_response.stalled', {
                        actor: 'system',
                        target: session.callSid || sessionId,
                        result: 'failure',
                        metadata: { watchdogMs: toolWatchdogMs }
                    });
                    try {
                        openAiWs?.send(JSON.stringify(liveInstructionsAppend(
                            'ツール実行結果への応答が遅延しています。追加の確認や推測での回答はせず、「確認して担当者より折り返します」とだけ丁寧に伝えてください。',
                            `wd_${Date.now()}`,
                            liveState.toolWatchdogDelegationId ?? null
                        )));
                        openAiWs?.send(JSON.stringify(liveResponseCreate(`rc_wd_${Date.now()}`)));
                    } catch {
                        // socket raced closed — stage 2 will not run on a dead provider
                        return;
                    }
                    armToolWatchdog(2);
                    return;
                }
                auditLog('live.tool_response.failed', {
                    actor: 'system',
                    target: session.callSid || sessionId,
                    result: 'failure',
                    metadata: { watchdogMs: toolWatchdogMs }
                });
                // RECHECK-RR02/N08: a flag-only requestCallEnd waits for a
                // final phrase that will never arrive from a dead provider —
                // the call stays open in silence. Record the request for
                // the audit trail, then terminate the call for real:
                // gate-checked Twilio hangup plus socket close.
                requestCallEnd({ source: 'live_tool_watchdog', reason: 'tool_response_stalled' });
                completeCallAfterFinalAudio('live_tool_watchdog_silence').catch((error) => {
                    console.error(`Watchdog call end failed: ${error.message}`);
                    if (connection.readyState === WebSocket.OPEN) {
                        connection.close(1000, 'tool_watchdog_silence');
                    }
                });
            }, toolWatchdogMs);
        };

        const sendRealtimeResponseCreate = (reason) => {
            if (openAiWs?.readyState !== WebSocket.OPEN) return;

            if (providerMode === 'live') {
                // Live responds continuously; response.create is only needed to
                // continue delegated backend work after tool results, not per
                // accepted user turn.
                if (!liveState.started || String(reason).startsWith('accepted_transcript')) return;
                openAiWs?.send(JSON.stringify(liveResponseCreate(`rc_${Date.now()}`)));
                armToolWatchdog();
                return;
            }

            if (responseInProgress || responseCreatePending) {
                pendingResponseAfterCurrent = true;
                if (SHOULD_LOG_REALTIME_EVENTS) {
                    console.log(`Queued response.create until current response completes (${reason})`);
                }
                return;
            }

            responseCreatePending = true;
            openAiWs?.send(JSON.stringify({ type: 'response.create' }));
            if (SHOULD_LOG_REALTIME_EVENTS) {
                console.log(`Sent response.create (${reason})`);
            }
        };

        const interruptAssistantResponse = () => {
            if (providerMode === 'live') {
                // Live handles turn-taking server-side; only drop stale buffered
                // Twilio playback so the caller is not talked over.
                liveState.outputAudioActive = false;
                if (session.streamSid && connection.readyState === WebSocket.OPEN) {
                    invalidatePlaybackMarks('live_barge_in');
                    connection.send(JSON.stringify({
                        event: 'clear',
                        streamSid: session.streamSid
                    }));
                }
                return;
            }

            if (responseInProgress && openAiWs?.readyState === WebSocket.OPEN) {
                openAiWs?.send(JSON.stringify({ type: 'response.cancel' }));
            }

            pendingResponseAfterCurrent = false;

            if (session.streamSid && connection.readyState === WebSocket.OPEN) {
                invalidatePlaybackMarks('speech_started');
                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: session.streamSid
                }));
            }
        };

        const deleteConversationItem = (itemId, reason) => {
            if (!itemId || openAiWs?.readyState !== WebSocket.OPEN) return;

            openAiWs?.send(JSON.stringify({
                type: 'conversation.item.delete',
                item_id: itemId
            }));

            if (SHOULD_LOG_REALTIME_EVENTS) {
                console.log(`Deleted ignored conversation item ${itemId} (${reason})`);
            }
        };

        const sendSessionUpdate = ({ socket = openAiWs, additionalInstructions = '' } = {}) => {
            const sessionUpdate = {
                type: 'session.update',
                session: buildRealtimeSessionConfig({
                    ...realtimeSettings,
                    realtimeModel: activeRealtimeModel,
                    realtimeVoice: activeRealtimeVoice,
                    handoffFallback: Boolean(session.handoffFallback),
                    handoffSummary: session.handoffSummary || '',
                    additionalInstructions,
                    // The model is selected on the WebSocket URL and cannot be
                    // changed through session.update on an active session.
                    includeModel: false
                })
            };

            console.log(`Sending Realtime session update for model ${activeRealtimeModel}`);
            socket?.send(JSON.stringify(sessionUpdate));
        };

        const escalateRealtimeModel = (classification) => {
            if (
                classification?.tier !== 'complex_complaint'
                || classification.targetModel !== COMPLEX_REALTIME_MODEL
                || activeRealtimeModel === COMPLEX_REALTIME_MODEL
                || session.modelEscalation?.status === 'starting'
                || session.modelEscalation?.status === 'active'
            ) {
                return false;
            }

            const previousSocket = openAiWs;
            const fromModel = activeRealtimeModel;
            const replacementSocket = createRealtimeSocket(classification.targetModel);
            const contextSummary = summarizeHandoffTurns(session.turns, { maxTurns: 10, maxChars: 1200 });

            session.modelEscalation = {
                status: 'starting',
                category: classification.category,
                fromModel,
                targetModel: classification.targetModel,
                startedAt: new Date().toISOString(),
                previousSocket
            };
            activeRealtimeModel = classification.targetModel;
            activeRealtimeVoice = COMPLEX_REALTIME_VOICE;
            openAiWs = replacementSocket;
            realtimeSocketReady = false;
            responseInProgress = false;
            responseCreatePending = false;
            pendingResponseAfterCurrent = false;

            auditLog('realtime.model_escalation.started', {
                actor: 'system',
                target: session.callSid || sessionId,
                metadata: {
                    fromModel,
                    toModel: classification.targetModel,
                    category: classification.category
                }
            });

            attachRealtimeSocket(replacementSocket, {
                initial: false,
                resumeContext: contextSummary,
                additionalInstructions: buildComplexRealtimeInstructions(classification.category)
            });
            return true;
        };

        const failRealtimeEscalation = (reason) => {
            if (session.modelEscalation?.status !== 'starting') return;

            const escalation = session.modelEscalation;
            const previousSocket = escalation.previousSocket;
            escalation.status = 'failed';
            escalation.reason = reason || 'realtime_escalation_failed';
            delete escalation.previousSocket;
            auditLog('realtime.model_escalation.failed', {
                actor: 'system',
                target: session.callSid || sessionId,
                metadata: { reason: escalation.reason }
            });

            if (previousSocket && previousSocket.readyState === WebSocket.OPEN) {
                openAiWs = previousSocket;
                activeRealtimeModel = escalation.fromModel;
                activeRealtimeVoice = VOICE;
                realtimeSocketReady = true;
                responseInProgress = false;
                responseCreatePending = false;
                pendingResponseAfterCurrent = false;
                sendRealtimeResponseCreate('complex_model_fallback');
            }
        };

        const buildLiveInstructions = () => {
            const firstMessage = session.handoffFallback
                ? 'では、先ほどの内容について、まだ伺えていない情報を一つずつ確認させてください。'
                : FIRST_MESSAGE;
            return [
                'あなたはCor.株式会社の電話受付を行う日本語の音声AIです。簡潔で丁寧な自然な日本語で話してください。',
                `通話開始の最初の発話として、必ず一字一句そのまま「${firstMessage}」とだけ発話し、その後は発信者の返答を待ってください。`,
                '業務上の判断・電話番号の検証・受付終了・担当者への転送可否は、すべてバックエンドに委譲してください。自分だけで判断せず、バックエンドの結果を自然な言葉で伝えてください。',
                'バックエンドへの委譲中は発信者を無音で待たせないでください。「少々お待ちください」など短い相づちを先に伝え、結果が返ったら要点だけを簡潔に案内してください。',
                '「営業時間」「営業日」「定休日」「何時まで」は営業勧誘（セールス）ではなく、会社の営業時間への一般質問です。営業の受付や担当者への引き継ぎと混同しないでください。',
                '内部の分類名・ツール名・判定理由は絶対に発話しないでください。',
                session.handoffFallback
                    ? 'この通話は担当者への転送が成立しなかった後の再受付です。転送はせず、「担当者が出なかったため、引き続きコールセンターで承ります」と自然に案内して受付を続けてください。'
                    : ''
            ].filter(Boolean).join('\n');
        };

        const buildLiveBackendInstructions = () => {
            const fallbackInstructions = session.handoffFallback
                ? [
                    '',
                    'これは担当者への転送が成立しなかった後の再受付です。',
                    '担当者への転送toolは使わず、再転送もしないでください。',
                    '先ほどの受付内容を踏まえ、まだ伺えていない情報を一つずつ確認してください。確認できたら内容を復唱し、折り返し要否を確認してから終話してください。',
                    session.handoffSummary ? `先ほどの受付内容の要約（参考）: ${session.handoffSummary}` : ''
                ].filter(Boolean).join('\n')
                : '';
            return `${RESOLVED_SYSTEM_MESSAGE}${fallbackInstructions ? `\n${fallbackInstructions}` : ''}`;
        };

        const finalizeLiveUserTurn = (reason) => {
            if (liveState.userFragTimer) {
                clearTimeout(liveState.userFragTimer);
                liveState.userFragTimer = null;
            }
            const text = liveState.userFrag.trim();
            liveState.userFrag = '';
            if (!text) return;

            const gateResult = evaluateRealtimeInputTranscript(text, REALTIME_INPUT_GATE_CONFIG);
            if (!gateResult.accepted) {
                if (SHOULD_LOG_REALTIME_EVENTS) {
                    console.log(`Ignored live input transcript (${sessionId}): ${gateResult.reason}`);
                }
                return;
            }

            appendTurn(session, 'user', gateResult.normalized);
            if (SHOULD_LOG_TRANSCRIPTS && gateResult.normalized) {
                console.log(`User (${sessionId}): ${gateResult.normalized}`);
            }

            // The caller kept talking — a pending end-of-call request no
            // longer reflects the conversation.
            revokeCallEnd('live_user_turn');

            const classification = classifyRealtimeConversation(session.turns);
            jevShadow?.observe(session.turns, session.turns.length, classification, session.callSid || sessionId);

            if (
                classification.tier === 'complex_complaint'
                && !liveState.complexMode
                && !liveState.complexModeEventId
                && openAiWs?.readyState === WebSocket.OPEN
            ) {
                const eventId = `upd_complex_${Date.now()}`;
                liveState.complexModeEventId = eventId;
                auditLog('live.backend_escalation.started', {
                    actor: 'system',
                    target: session.callSid || sessionId,
                    metadata: { category: classification.category }
                });
                openAiWs?.send(JSON.stringify({
                    type: 'session.update',
                    event_id: eventId,
                    session: {
                        delegation: {
                            type: 'responses',
                            responses: {
                                instructions: `${buildLiveBackendInstructions()}\n${buildComplexRealtimeInstructions(classification.category)}`
                            }
                        }
                    }
                }));
            }

            const urgentHumanSupport = shouldAutoHandoffGeneral(session.turns)
                && classification.tier !== 'complex_complaint';
            if (
                HANDOFF_CONFIG.enabled
                && urgentHumanSupport
                && !isEmergencyCall(session.turns)
                && !session.handoff?.started
                && !session.handoff?.starting
                && !isNonHandoffBusinessCall(session.turns)
            ) {
                const urgentDestination = isContractRequest(session.turns)
                    ? 'contract'
                    : 'general';
                session.handoff = {
                    ...(session.handoff || {}),
                    starting: true,
                    trigger: 'urgent_human_support'
                };
                auditLog('handoff.auto_triggered', {
                    actor: 'system',
                    target: session.callSid || sessionId,
                    metadata: {
                        destination: urgentDestination,
                        category: 'urgent_human_support',
                        reason: `explicit_urgent_request_${reason}`
                    }
                });
                void startHandoff({
                    reason: '緊急の人間対応',
                    destination: urgentDestination
                });
            }
        };

        const scheduleLiveUserTurnFinalize = () => {
            if (liveState.userFragTimer) clearTimeout(liveState.userFragTimer);
            liveState.userFragTimer = setTimeout(() => {
                liveState.userFragTimer = null;
                finalizeLiveUserTurn('gap');
            }, Number(LIVE_USER_TURN_GAP_MS));
        };

        const finalizeLiveAgentTurn = (reason) => {
            if (liveState.agentFragTimer) {
                clearTimeout(liveState.agentFragTimer);
                liveState.agentFragTimer = null;
            }
            const text = liveState.agentFrag.trim();
            liveState.agentFrag = '';
            liveState.outputAudioActive = false;
            if (!text) return;

            appendTurn(session, 'agent', text);
            if (SHOULD_LOG_TRANSCRIPTS && text) console.log(`Agent (${sessionId}): ${text}`);
            if (isTerminalAgentMessage(text, CALL_END_CONFIG)) {
                requestCallEnd({
                    source: 'terminal_phrase',
                    reason: 'assistant_final_phrase'
                });
            }

            // Live has no response.done; send the end-call mark after the last
            // assistant turn so trailing audio flushes before Twilio echoes it.
            if (session.callEnd?.requested && !session.callEnd?.completed) {
                setTimeout(() => sendEndCallMark(`live_agent_turn_${reason}`), Number(LIVE_END_MARK_DELAY_MS));
            }
        };

        const scheduleLiveAgentTurnFinalize = () => {
            if (liveState.agentFragTimer) clearTimeout(liveState.agentFragTimer);
            liveState.agentFragTimer = setTimeout(() => {
                liveState.agentFragTimer = null;
                finalizeLiveAgentTurn('gap');
            }, Number(LIVE_AGENT_TURN_GAP_MS));
        };

        const handleLiveStartFailure = (reason) => {
            // Provider (re)start is only allowed while the call is still
            // starting or active — never after handoff, caller disconnect,
            // or normal close. This is the lifecycle guard the audit requires.
            if (
                providerMode !== 'live'
                || liveState.started
                || callLifecycle.phase === 'handoff'
                || callLifecycle.phase === 'closing'
                || callLifecycle.phase === 'closed'
                || session.callEnd?.completed
            ) {
                return;
            }
            auditLog('live.session.start_failed', {
                actor: 'openai',
                target: session.callSid || sessionId,
                result: 'failure',
                metadata: { reason }
            });
            console.error(`GPT-Live session failed to start (${reason}); falling back to Realtime`);

            if (LIVE_FALLBACK_TO_REALTIME !== 'true') {
                if (connection.readyState === WebSocket.OPEN) {
                    connection.close(1011, 'live_start_failed');
                }
                return;
            }

            if (liveState.startTimer) {
                clearTimeout(liveState.startTimer);
                liveState.startTimer = null;
            }
            providerMode = 'realtime';
            try {
                if (openAiWs?.readyState === WebSocket.OPEN) openAiWs?.close(1000, 'live_fallback');
            } catch {
                // socket may already be closed
            }
            openAiWs = createRealtimeSocket(activeRealtimeModel);
            attachRealtimeSocket(openAiWs, { initial: true });
        };

        const attachLiveSocket = (socket) => {
            // The start deadline covers the WebSocket handshake too — a hung
            // TCP/TLS negotiation must not leave the caller in silence.
            if (liveState.startTimer) clearTimeout(liveState.startTimer);
            liveState.startTimer = setTimeout(() => {
                liveState.startTimer = null;
                handleLiveStartFailure('session_started_timeout');
            }, Number(LIVE_START_TIMEOUT_MS));

            socket.on('open', () => {
                if (socket !== openAiWs) return;
                console.log(`Connected to the GPT-Live API (${LIVE_MODEL})`);

                const liveTools = [
                    VALIDATE_CALLBACK_PHONE_TOOL,
                    ...(KNOWLEDGE_TOOL_DEF ? [KNOWLEDGE_TOOL_DEF] : []),
                    ...(session.handoffFallback ? [] : [TRANSFER_TO_HUMAN_TOOL].filter(Boolean)),
                    ...(FINISH_RECEPTION_TOOL ? [FINISH_RECEPTION_TOOL] : [])
                ].filter(Boolean);

                socket.send(JSON.stringify(buildLiveSessionStart({
                    model: LIVE_MODEL,
                    voice: LIVE_VOICE,
                    audioFormatType: LIVE_AUDIO_FORMAT,
                    audioRate: Number(LIVE_AUDIO_RATE),
                    instructions: buildLiveInstructions(),
                    delegationResponses: {
                        model: LIVE_BACKEND_MODEL,
                        instructions: buildLiveBackendInstructions(),
                        tools: liveTools,
                        tool_choice: 'auto'
                    }
                })));
            });

            socket.on('message', (data) => {
                if (socket !== openAiWs) return;
                try {
                    const event = JSON.parse(data);
                    const classified = classifyLiveEvent(event);

                    if (SHOULD_LOG_REALTIME_EVENTS && classified.kind !== 'audio_delta' && classified.kind !== 'other') {
                        console.log(`Received Live event: ${event.type}`);
                    }

                    switch (classified.kind) {
                        case 'started':
                            liveState.started = true;
                            liveState.everStarted = true;
                            if (liveState.startTimer) {
                                clearTimeout(liveState.startTimer);
                                liveState.startTimer = null;
                            }
                            console.log(`GPT-Live session started (${event.session?.id || 'unknown'})`);
                            auditLog('live.session.started', {
                                actor: 'openai',
                                target: session.callSid || sessionId,
                                metadata: {
                                    model: LIVE_MODEL,
                                    backendModel: LIVE_BACKEND_MODEL,
                                    audioFormat: LIVE_AUDIO_FORMAT,
                                    passthrough: liveState.codec.passthrough
                                }
                            });
                            flushPendingInboundAudio();
                            break;

                        case 'audio_delta': {
                            // REVIEW-R02/RECHECK-RR02/ACCEPT-T02: audible
                            // progress only resets the pending watchdog —
                            // lifecycle notifications never clear it, a
                            // frame of pure silence is not progress, and a
                            // single filler burst does not satisfy the
                            // pending tool continuation.
                            if (!isSilentAudioDelta(classified.delta)) {
                                noteToolAudibleProgress();
                                liveState.outputAudioActive = true;
                                liveState.lastAudioDeltaAt = Date.now();
                            }
                            // Silent frames still forward to Twilio so
                            // playback timing stays continuous.
                            sendAudioToTwilio(liveState.codec.decodeOutput(classified.delta));
                            break;
                        }

                        case 'input_transcript_delta':
                            // Caller speech resolves the pending tool
                            // exchange — the conversation moved on.
                            if (classified.delta) disarmToolWatchdog();
                            liveState.userFrag += classified.delta || '';
                            scheduleLiveUserTurnFinalize();
                            // Barge-in: the caller is saying something while
                            // audio is still streaming; drop stale buffered
                            // playback in Twilio. Recent-delta check avoids
                            // clearing during natural pauses between phrases.
                            if (liveState.outputAudioActive && Date.now() - liveState.lastAudioDeltaAt < 800) {
                                interruptAssistantResponse();
                            }
                            break;

                        case 'output_transcript_delta':
                            // An empty delta is not progress — only real
                            // transcript text resets the window.
                            if (classified.delta) noteToolAudibleProgress();
                            liveState.agentFrag += classified.delta || '';
                            scheduleLiveAgentTurnFinalize();
                            break;

                        case 'updated':
                            // complexMode activates only when the acked
                            // session.update matches the event we sent — an
                            // unrelated update must not widen transfer policy.
                            if (
                                liveState.complexModeEventId
                                && (event.client_event_id === liveState.complexModeEventId
                                    || event.event_id === liveState.complexModeEventId)
                            ) {
                                liveState.complexMode = true;
                                liveState.complexModeEventId = '';
                                auditLog('live.backend_escalation.activated', {
                                    actor: 'openai',
                                    target: session.callSid || sessionId
                                });
                            }
                            break;

                        case 'delegation_created':
                            finalizeLiveUserTurn('delegation');
                            auditLog('live.delegation.created', {
                                actor: 'openai',
                                target: session.callSid || sessionId,
                                metadata: {
                                    delegationId: classified.delegationId,
                                    responseId: classified.responseId
                                }
                            });
                            break;

                        case 'response_event': {
                            // REVIEW-R02: lifecycle notifications are NOT
                            // progress. response.in_progress/created/completed
                            // used to clear the watchdog, letting a stalled
                            // provider sit silent forever. Only audio or
                            // transcript deltas (or session close) clear it.
                            const completed = liveState.delegation.observeResponseEvent(
                                classified.delegationId,
                                classified.nested
                            );
                            // Side-effecting tool calls execute only for a
                            // completed response — failed/incomplete snapshots
                            // can carry truncated calls.
                            if (completed?.status === 'response.completed' && completed.calls?.length) {
                                liveState.toolWatchdogDelegationId = completed.delegationId;
                                // Tool work (incl. the async knowledge lookup)
                                // is now expected — audible progress must
                                // follow within the deadline or the watchdog
                                // stages fire.
                                armToolWatchdog();
                                void (async () => {
                                    const doneEvent = toRealtimeDoneEvent(completed.calls, completed.status);
                                    const knowledgeHandled = await handleKnowledgeToolCalls(doneEvent);
                                    const flowHandled = handleToolCalls(doneEvent);
                                    if (knowledgeHandled && !flowHandled) {
                                        sendRealtimeResponseCreate('knowledge_tool_output');
                                    }
                                })();
                            }
                            break;
                        }

                        case 'closed':
                            disarmToolWatchdog();
                            auditLog('live.session.closed', {
                                actor: 'openai',
                                target: session.callSid || sessionId,
                                metadata: { usage: classified.usage || null }
                            });
                            session.liveUsage = classified.usage || null;
                            liveState.started = false;
                            if (liveState.drainTimer) {
                                clearTimeout(liveState.drainTimer);
                                liveState.drainTimer = null;
                            }
                            if (liveState.closedResolver) {
                                const resolve = liveState.closedResolver;
                                liveState.closedResolver = null;
                                resolve('closed');
                            }
                            break;

                        case 'error':
                            console.error(`GPT-Live error: ${classified.error?.message || 'unknown'}`);
                            if (!liveState.started) {
                                handleLiveStartFailure(classified.error?.message || 'live_error');
                            }
                            break;

                        default:
                            break;
                    }
                } catch (error) {
                    console.error('Error processing Live message:', error.message);
                }
            });

            socket.on('close', (code) => {
                if (socket === openAiWs) {
                    const wasStarted = liveState.everStarted;
                    liveState.started = false;
                    session.openAiCloseCode = code;
                    if (liveState.closedResolver) {
                        const resolve = liveState.closedResolver;
                        liveState.closedResolver = null;
                        if (liveState.drainTimer) {
                            clearTimeout(liveState.drainTimer);
                            liveState.drainTimer = null;
                        }
                        resolve('socket_closed');
                    }
                    if (providerMode === 'live' && !session.callEnd?.completed) {
                        if (!wasStarted) {
                            // Never started: retry through the Realtime fallback.
                            handleLiveStartFailure(`socket_closed_${code}`);
                        } else if (callLifecycle.phase === 'active' && !session.handoff?.started) {
                            // Mid-call provider drop. A silent reconnect would
                            // replay the opening greeting, so the call leg is
                            // ended cleanly instead of leaking a new session.
                            auditLog('live.session.mid_call_drop', {
                                actor: 'openai',
                                target: session.callSid || sessionId,
                                result: 'failure',
                                metadata: { code }
                            });
                            if (connection.readyState === WebSocket.OPEN) {
                                connection.close(1011, 'provider_dropped');
                            }
                        }
                    }
                }
                console.log(`Disconnected from the GPT-Live API (${code})`);
            });

            socket.on('error', (error) => {
                if (socket === openAiWs) session.openAiError = error.message;
                console.error('Error in the GPT-Live WebSocket:', error);
            });
        };

        const attachRealtimeSocket = (socket, {
            initial = false,
            resumeContext = '',
            additionalInstructions = ''
        } = {}) => {
            socket.on('open', () => {
                if (socket !== openAiWs) return;
                console.log(`Connected to the OpenAI Realtime API (${activeRealtimeModel})`);
                realtimeSocketReady = true;
                setTimeout(async () => {
                    if (socket !== openAiWs || socket.readyState !== WebSocket.OPEN) return;
                    if (initial && session.handoffContextPromise) {
                        await session.handoffContextPromise;
                    }
                    sendSessionUpdate({ socket, additionalInstructions });
                    flushPendingInboundAudio();

                    if (initial) {
                        // 通話開始時の挨拶を、顧客へ向けた日本語音声として生成する。
                        const firstMessage = session.handoffFallback
                            ? 'では、先ほどの内容について、まだ伺えていない情報を一つずつ確認させてください。'
                            : FIRST_MESSAGE;
                        socket.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'message',
                                role: 'user',
                                content: [{
                                    type: 'input_text',
                                    text: `通話が開始しました。顧客に向けて、次の案内を一字一句変えずにそのまま読み上げ、その後は顧客の返答を待ってください。「${firstMessage}」`
                                }]
                            }
                        }));
                        sendRealtimeResponseCreate('first_message');
                    } else {
                        session.modelEscalation = {
                            ...(session.modelEscalation || {}),
                            status: 'active',
                            activatedAt: new Date().toISOString()
                        };
                        auditLog('realtime.model_escalation.succeeded', {
                            actor: 'system',
                            target: session.callSid || sessionId,
                            metadata: {
                                fromModel: session.modelEscalation.fromModel,
                                activeModel: activeRealtimeModel,
                                category: session.modelEscalation.category
                            }
                        });
                        const previousSocket = session.modelEscalation.previousSocket;
                        delete session.modelEscalation.previousSocket;
                        if (previousSocket && previousSocket !== socket && previousSocket.readyState === WebSocket.OPEN) {
                            previousSocket.close(1000, 'model_escalated');
                        }
                        socket.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'message',
                                role: 'user',
                                content: [{
                                    type: 'input_text',
                                    text: `これまでの受付内容を引き継ぎます。顧客には内部のモデル切替を説明せず、自然に会話を続けてください。受付内容: ${resumeContext || '直前の発話を踏まえて確認を続けてください。'}`
                                }]
                            }
                        }));
                        sendRealtimeResponseCreate('complex_model_resume');
                    }
                }, 250);
            });

            socket.on('message', (data) => {
                if (socket !== openAiWs) return;
                try {
                    const response = JSON.parse(data);

                    if (SHOULD_LOG_REALTIME_EVENTS && LOG_EVENT_TYPES.includes(response.type)) {
                        console.log(`Received Realtime event: ${response.type}`);
                    }

                    if (response.type === 'conversation.item.input_audio_transcription.completed') {
                        const userMessage = String(response.transcript || '').trim();
                        const gateResult = evaluateRealtimeInputTranscript(userMessage, REALTIME_INPUT_GATE_CONFIG);

                        if (!gateResult.accepted) {
                            deleteConversationItem(response.item_id, gateResult.reason);
                            if (SHOULD_LOG_REALTIME_EVENTS) {
                                console.log(`Ignored input transcript (${sessionId}): ${gateResult.reason}`);
                            }
                            return;
                        }

                        appendTurn(session, 'user', gateResult.normalized);
                        if (SHOULD_LOG_TRANSCRIPTS && gateResult.normalized) {
                            console.log(`User (${sessionId}): ${gateResult.normalized}`);
                        }

                        // Caller correction/interruption revokes a pending
                        // end-of-call request and all its timers.
                        revokeCallEnd('realtime_user_turn');

                        const classification = classifyRealtimeConversation(session.turns);
                        jevShadow?.observe(session.turns, session.turns.length, classification, session.callSid || sessionId);
                        if (
                            classification.tier === 'complex_complaint'
                            && activeRealtimeModel !== COMPLEX_REALTIME_MODEL
                        ) {
                            if (escalateRealtimeModel(classification)) return;
                        }

                        const urgentHumanSupport = shouldAutoHandoffGeneral(session.turns)
                            && classification.tier !== 'complex_complaint';
                        if (
                            HANDOFF_CONFIG.enabled
                            && urgentHumanSupport
                            && !isEmergencyCall(session.turns)
                            && !session.handoff?.started
                            && !session.handoff?.starting
                            && !isNonHandoffBusinessCall(session.turns)
                        ) {
                            const urgentDestination = isContractRequest(session.turns)
                                ? 'contract'
                                : 'general';
                            session.handoff = {
                                ...(session.handoff || {}),
                                starting: true,
                                trigger: 'urgent_human_support'
                            };
                            auditLog('handoff.auto_triggered', {
                                actor: 'system',
                                target: session.callSid || sessionId,
                                metadata: {
                                    destination: urgentDestination,
                                    category: 'urgent_human_support',
                                    reason: 'explicit_urgent_request'
                                }
                            });
                            void startHandoff({
                                reason: '緊急の人間対応',
                                destination: urgentDestination
                            });
                            return;
                        }

                        if (SHOULD_GATE_REALTIME_INPUT) {
                            sendRealtimeResponseCreate(`accepted_transcript:${gateResult.reason}`);
                        }
                    }

                    if (response.type === 'response.output_audio_transcript.done') {
                        const agentMessage = response.transcript || '';
                        appendTurn(session, 'agent', agentMessage);
                        if (SHOULD_LOG_TRANSCRIPTS && agentMessage) console.log(`Agent (${sessionId}): ${agentMessage}`);
                        if (isTerminalAgentMessage(agentMessage, CALL_END_CONFIG)) {
                            requestCallEnd({
                                source: 'terminal_phrase',
                                reason: 'assistant_final_phrase'
                            });
                        }
                    }

                    if (response.type === 'session.updated') {
                        console.log(`Realtime session updated successfully (${activeRealtimeModel})`);
                    }

                    if (response.type === 'input_audio_buffer.speech_started') {
                        interruptAssistantResponse();
                    }

                    if (response.type === 'response.created') {
                        responseInProgress = true;
                        responseCreatePending = false;
                    }

                    if (response.type === 'response.done') {
                        responseInProgress = false;
                        responseCreatePending = false;
                        // Knowledge lookups are async — run them first so every
                        // tool output lands before the shared response.create.
                        void (async () => {
                            const knowledgeHandled = await handleKnowledgeToolCalls(response);
                            if (handleToolCalls(response)) {
                                return;
                            }
                            if (knowledgeHandled) {
                                sendRealtimeResponseCreate('knowledge_tool_output');
                                return;
                            }
                            if (pendingResponseAfterCurrent) {
                                pendingResponseAfterCurrent = false;
                                sendRealtimeResponseCreate('queued_after_response_done');
                                return;
                            }
                            sendEndCallMark('response_done');
                        })();
                    }

                    if (response.type === 'error') {
                        responseCreatePending = false;
                        console.error('Realtime API error:', response.error?.message || 'Unknown realtime error');
                        if (!initial && session.modelEscalation?.status === 'starting') {
                            failRealtimeEscalation(response.error?.message || 'realtime_error');
                        }
                    }

                    if ((response.type === 'response.output_audio.delta' || response.type === 'response.audio.delta') && response.delta) {
                        sendAudioToTwilio(response.delta);
                    }
                } catch (error) {
                    console.error('Error processing OpenAI message:', error.message);
                }
            });

            socket.on('close', (code) => {
                if (socket === openAiWs) {
                    realtimeSocketReady = false;
                    session.openAiCloseCode = code;
                    if (session.modelEscalation?.status === 'starting') {
                        failRealtimeEscalation(`socket_closed_${code}`);
                    }
                }
                console.log(`Disconnected from the OpenAI Realtime API (${activeRealtimeModel})`);
            });

            socket.on('error', (error) => {
                if (socket === openAiWs) session.openAiError = error.message;
                console.error('Error in the OpenAI WebSocket:', error);
            });
        };

        // REVIEW-R01: connect the paid provider session only once stream
        // authentication has completed. Lifecycle-guarded so a stale caller
        // (handoff/close raced ahead) can never spawn a provider session.
        const connectProvider = () => {
            if (openAiWs) return;
            if (callLifecycle.phase === 'handoff'
                || callLifecycle.phase === 'closing'
                || callLifecycle.phase === 'closed'
                || session.callEnd?.completed) {
                return;
            }
            openAiWs = providerMode === 'live'
                ? createLiveSocket()
                : createRealtimeSocket(activeRealtimeModel);
            if (providerMode === 'live') {
                attachLiveSocket(openAiWs);
            } else {
                attachRealtimeSocket(openAiWs, { initial: true });
            }
        };

        // Authenticated at upgrade (path token or auth bypass) — connect now.
        // Deferred streams connect inside the `start` handler instead.
        if (!streamAuthDeferred) connectProvider();

        // Twilioからのメッセージを処理
        const handleTwilioMessage = (message) => {
            try {
                const data = JSON.parse(message.toString());

                if (streamAuthDeferred && data.event !== 'start' && data.event !== 'connected') {
                    auditLog('twilio.media_stream.rejected', {
                        actor: 'unknown',
                        target: 'media-stream',
                        result: 'failure',
                        metadata: { reason: 'stream_auth_required' }
                    });
                    connection.close(4403, 'forbidden');
                    return;
                }

                switch (data.event) {
                    case 'media':
                        if (data.media?.payload) {
                            if (!sendAudioToOpenAi(data.media.payload)
                                && pendingInboundAudio.length < maxPendingAudioMessages) {
                                pendingInboundAudio.push(data.media.payload);
                            }
                        }
                        break;
                    case 'start':
                        if (streamAuthDeferred) {
                            const paramToken = data.start?.customParameters?.stream_token || '';
                            const verified = verifyStreamToken(paramToken, TWILIO_AUTH_TOKEN);
                            if (!verified) {
                                auditLog('twilio.media_stream.rejected', {
                                    actor: 'unknown',
                                    target: 'media-stream',
                                    result: 'failure',
                                    metadata: { reason: 'missing_or_invalid_stream_token' }
                                });
                                connection.close(4403, 'forbidden');
                                break;
                            }
                            boundCallSid = verified.callSid;
                            streamAuthDeferred = false;
                            if (authDeadline) {
                                clearTimeout(authDeadline);
                                authDeadline = null;
                            }
                            // Authentication completed via the deferred
                            // <Parameter> channel — the paid provider
                            // session may now be created.
                            connectProvider();
                        }
                        if (!data.start?.streamSid) {
                            console.warn('Twilio stream start message did not include streamSid');
                            break;
                        }
                        // The start frame must agree with the verified token —
                        // a stream authenticated for call A cannot carry call B.
                        if (boundCallSid && data.start.callSid && data.start.callSid !== boundCallSid) {
                            auditLog('twilio.media_stream.call_sid_mismatch', {
                                actor: 'twilio',
                                target: boundCallSid,
                                result: 'failure',
                                metadata: { streamSid: data.start.streamSid }
                            });
                            connection.close(4403, 'call_sid_mismatch');
                            break;
                        }
                        const customParameters = data.start.customParameters || {};
                        session.streamSid = data.start.streamSid;
                        session.callSid = data.start.callSid || session.callSid;
                        session.accountSid = data.start.accountSid || '';
                        callLifecycle.phase = 'active';
                        session.lifecycle = callLifecycle.phase;
                        session.from = customParameters.from || '';
                        session.to = customParameters.to || '';
                        const handoffFallback = String(
                            customParameters.handoff_fallback || customParameters.handoffFallback || ''
                        ).toLowerCase() === 'true';
                        if (handoffFallback) {
                            session.handoffFallback = true;
                            session.handoff = {
                                ...(session.handoff || {}),
                                started: true,
                                fallback: true,
                                reason: '担当者不応答'
                            };
                            session.handoffContextPromise = handoffContextStore.get(session.callSid)
                                .then((context) => {
                                    session.handoffSummary = context?.summary || '';
                                })
                                .catch((error) => {
                                    session.handoffSummary = '';
                                    console.error(`Failed to load handoff fallback context: ${error.message}`);
                                });
                        }
                        console.log('Incoming stream has started', session.streamSid);
                        auditLog('call.started', {
                            actor: 'twilio',
                            target: session.callSid,
                            metadata: {
                                streamSid: session.streamSid,
                                from: maskPhone(session.from),
                                to: maskPhone(session.to)
                            }
                        });
                        callLogSinks.recordStarted(session);
                        // v2 projection at call start — correlation ids land
                        // even if the call later drops without extraction.
                        void projectProviderCall({
                            callId: session.callSid || sessionId,
                            streamSid: session.streamSid,
                            transportState: 'connected',
                            startedAt: session.startedAt instanceof Date
                                ? session.startedAt.toISOString()
                                : (session.startedAt || new Date().toISOString()),
                            endedAt: null,
                            durationSeconds: null,
                            fromNumberMasked: maskPhone(session.from),
                            toNumberMasked: maskPhone(session.to),
                            callbackRequired: false,
                            outcome: 'abandoned'
                        });
                        flushPendingOutboundAudio();
                        break;
                    case 'mark':
                        // Only a mark from the current playback epoch counts —
                        // Twilio echoes cleared marks too.
                        if (
                            data.mark?.name
                            && data.mark.name === session.callEnd?.markName
                            && session.callEnd?.markEpoch === session.playback?.epoch
                        ) {
                            scheduleCallCompletion('twilio_mark');
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing Twilio media message:', error.message);
            }
        };

        twilioMessageHandler = handleTwilioMessage;
        for (const message of pendingTwilioMessages.splice(0)) {
            handleTwilioMessage(message);
        }

        // 接続が閉じられたときの処理
        const handleTwilioClose = async (code, reason) => {
            // Disposal is idempotent — a second close event must not re-run
            // persistence, notifications, or provider shutdown.
            if (callLifecycle.phase === 'closing' || callLifecycle.phase === 'closed') return;
            callLifecycle.phase = 'closing';
            session.lifecycle = callLifecycle.phase;

            if (callEndTimer) clearTimeout(callEndTimer);
            if (callEndMarkTimeout) clearTimeout(callEndMarkTimeout);
            if (liveState.userFragTimer) clearTimeout(liveState.userFragTimer);
            if (liveState.agentFragTimer) clearTimeout(liveState.agentFragTimer);
            if (liveState.startTimer) clearTimeout(liveState.startTimer);

            // Flush in-flight transcript fragments as provisional turns so a
            // mid-utterance disconnect does not silently lose caller speech.
            if (liveState.userFrag.trim()) {
                appendTurn(session, 'user', liveState.userFrag, { provisional: true });
                liveState.userFrag = '';
            }
            if (liveState.agentFrag.trim()) {
                appendTurn(session, 'agent', liveState.agentFrag, { provisional: true });
                liveState.agentFrag = '';
            }

            disarmToolWatchdog();

            // Bounded graceful close: send session.close, wait for
            // session.closed with a deadline, and record an incomplete
            // finalization when confirmation never arrives.
            if (openAiWs?.readyState === WebSocket.OPEN) {
                if (providerMode === 'live' && liveState.started && !liveState.closeSent) {
                    liveState.closeSent = true;
                    try {
                        openAiWs?.send(JSON.stringify(liveSessionClose(`close_${sessionId}`)));
                        const drainResult = await new Promise((resolve) => {
                            liveState.closedResolver = resolve;
                            liveState.drainTimer = setTimeout(
                                () => resolve('drain_timeout'),
                                Number(LIVE_CLOSE_DRAIN_MS)
                            );
                        });
                        if (drainResult !== 'closed') {
                            session.liveCloseIncomplete = true;
                            auditLog('live.session.close_incomplete', {
                                actor: 'openai',
                                target: session.callSid || sessionId,
                                result: 'failure',
                                metadata: { drainResult }
                            });
                        }
                    } catch {
                        session.liveCloseIncomplete = true;
                    }
                }
                openAiWs?.close();
            }
            session.endedAt = new Date();
            session.status = 'completed';
            session.disconnectReason = reason?.toString() || `twilio_ws_close_${code}`;
            console.log(`Client disconnected (${sessionId}).`);
            if (SHOULD_LOG_TRANSCRIPTS) {
                console.log('Full Transcript:');
                console.log(session.transcript);
            }

            // RECHECK-RR03: only a stream that completed authentication AND
            // processed a valid start frame may produce business records,
            // notifications, or v2 projections. A rejected, still-deferred,
            // or pre-start disconnect leaves only the security audit trail —
            // no callLogs entry, no email, no callLogsV2 document.
            const streamAccepted = !streamAuthDeferred && Boolean(session.streamSid);
            if (!streamAccepted) {
                auditLog('twilio.media_stream.business_effects_skipped', {
                    actor: 'twilio',
                    target: session.callSid || sessionId,
                    result: 'skipped',
                    metadata: {
                        reason: streamAuthDeferred ? 'stream_auth_incomplete' : 'no_start_frame'
                    }
                });
                callLifecycle.phase = 'closed';
                session.lifecycle = callLifecycle.phase;
                sessions.delete(sessionId);
                return;
            }

            const extraction = callLogSinks.shouldSkipSmokeLog(session)
                ? null
                : await processTranscriptAndSend(session.transcript, session.callSid || sessionId);
            const record = buildCallLogRecord(session, extraction);
            await callLogSinks.recordCompleted(record);
            const notifyResult = await notificationOutbox.enqueue({
                kind: 'call-summary',
                callId: record.callSid,
                subject: `【電話受付】${record.intent || '新しい通話受付'} ${record.callSid}`,
                text: buildCallSummaryEmailText(record)
            });

            // REVIEW-R09: project the completed call into callLogsV2 and open
            // an escalation case when human follow-up is required. The
            // notification enqueue result marks 'notified' — acknowledgement
            // stays a separate authenticated admin action.
            const emergency = isEmergencyCall(session.turns);
            const handoffAttempted = Boolean(
                session.handoff?.started || session.handoff?.starting || session.handoff?.failed
            );
            await projectProviderCall({
                callId: session.callSid || sessionId,
                streamSid: session.streamSid,
                transportState: (session.openAiError || session.liveCloseIncomplete) ? 'failed' : 'ended',
                startedAt: session.startedAt instanceof Date
                    ? session.startedAt.toISOString()
                    : (session.startedAt || null),
                endedAt: session.endedAt instanceof Date ? session.endedAt.toISOString() : null,
                durationSeconds: record.durationSeconds ?? null,
                fromNumberMasked: maskPhone(session.from),
                toNumberMasked: maskPhone(session.to),
                extraction: extraction ? {
                    summary: extraction.summary ?? null,
                    callerName: extraction.customerName ?? null,
                    callbackNumber: extraction.customerPhoneNumber
                        ?? session.callbackPhone?.normalizedPhoneNumber ?? null,
                    callbackRequestedWindow: extraction.preferredDatetime ?? null,
                    intent: extraction.intent ?? null,
                    memo: null,
                    // Firestore rejects undefined values — only include the
                    // model field when the extractor actually reported one
                    // (RECHECK-RR01).
                    ...(extraction.model ? { model: extraction.model } : {}),
                    extractedAt: new Date().toISOString()
                } : (session.callbackPhone?.valid ? {
                    callbackNumber: session.callbackPhone.normalizedPhoneNumber
                } : null),
                callbackRequired: record.callbackRequired === true,
                outcome: session.handoff?.started && !session.handoff?.failed ? 'transferred'
                    : (session.openAiError || session.liveCloseIncomplete) ? 'failed'
                        : session.turns.length > 0 ? 'completed' : 'abandoned',
                severity: {
                    urgency: emergency ? 'critical' : handoffAttempted ? 'high' : 'unknown',
                    importance: emergency ? 'critical' : handoffAttempted ? 'high' : 'normal',
                    humanRequested: handoffAttempted,
                    riskKinds: emergency ? ['life_safety_emergency'] : [],
                    basis: 'provider_projection'
                },
                handoff: {
                    requested: handoffAttempted,
                    destination: session.handoff?.destination ?? null,
                    outcome: session.handoff?.failed ? 'failed'
                        : session.handoff?.started ? 'connected'
                            : handoffAttempted ? 'timeout' : null,
                    reason: session.handoff?.reason ?? null
                },
                knowledgeReleaseIds: (session.knowledgeLookups || [])
                    .map((l) => l.releaseId).filter(Boolean),
                notificationSent: notifyResult?.ok === true,
                error: session.openAiError || null
            });
            auditLog('call.completed', {
                actor: 'twilio',
                target: session.callSid || sessionId,
                metadata: {
                    durationSeconds: record.durationSeconds,
                    callbackRequired: record.callbackRequired,
                    hasTranscript: Boolean(record.transcript)
                }
            });

            // セッションのクリーンアップ
            callLifecycle.phase = 'closed';
            session.lifecycle = callLifecycle.phase;
            sessions.delete(sessionId);
        };

        twilioCloseHandler = handleTwilioClose;
        if (pendingTwilioClose) {
            const { code, reason } = pendingTwilioClose;
            pendingTwilioClose = null;
            void handleTwilioClose(code, reason);
        }

    };

    // Twilio drops the <Stream url> query string on connect, so the token is
    // carried in the URL path (/media-stream/<token>); the bare route stays
    // for query-token local tests and the <Parameter> deferred channel.
    fastify.get('/media-stream', { websocket: true }, handleMediaStreamConnection);
    fastify.get('/media-stream/:token', { websocket: true }, handleMediaStreamConnection);
});

// サーバーを起動
fastify.listen({ port: PORT_NUMBER, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT_NUMBER}`);
});

// Responses APIを使用してトランスクリプトから通話要約を抽出
async function extractCallDetails(transcript) {
    console.log('Starting call detail extraction...');
    try {
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: EXTRACTION_MODEL,
                input: [
                    {
                        role: 'system',
                        content: [
                            'あなたは日本のコールセンター通話ログを構造化するオペレーターです。',
                            '事実だけを抽出し、不明な項目は空文字またはfalseにしてください。',
                            '顧客名は、通話中で最後に本人が訂正または確認した読みを優先してください。',
                            '顧客名は推測で一般的な漢字へ変換せず、文字起こしにカタカナやひらがながある場合はその表記を優先してください。'
                        ].join('\n')
                    },
                    {
                        role: 'user',
                        content: `以下の通話文字起こしを構造化してください。\n\n${transcript}`
                    }
                ],
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'call_log_extraction',
                        strict: true,
                        schema: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                summary: { type: 'string' },
                                intent: { type: 'string' },
                                callbackRequired: { type: 'boolean' },
                                customerName: { type: 'string' },
                                customerPhoneNumber: { type: 'string' },
                                preferredDatetime: { type: 'string' }
                            },
                            required: [
                                'summary',
                                'intent',
                                'callbackRequired',
                                'customerName',
                                'customerPhoneNumber',
                                'preferredDatetime'
                            ]
                        }
                    }
                }
            })
        });

        console.log('Responses API status:', response.status);
        const data = await response.json();
        if (SHOULD_LOG_OPENAI_RESPONSES) {
            console.log('Full extraction API response:', JSON.stringify(data, null, 2));
        }

        if (!response.ok) {
            throw new Error(data.error?.message || `Responses API returned ${response.status}`);
        }

        const text = data.output_text || data.output
            ?.flatMap(item => item.content || [])
            ?.find(content => content.text)?.text;

        if (!text) {
            throw new Error('Responses API did not return output text.');
        }

        return JSON.parse(text);
    } catch (error) {
        console.error('Error extracting call details:', error.message);
        throw error;
    }
}

// トランスクリプトを処理して構造化結果を返す
async function processTranscriptAndSend(transcript, sessionId = null) {
    console.log(`Starting transcript processing for session ${sessionId}...`);
    if (!SHOULD_RUN_EXTRACTION) {
        console.log('Transcript extraction is disabled. Set EXTRACTION_ENABLED=true to enable it.');
        return null;
    }

    if (!transcript.trim()) {
        console.log('Transcript is empty. Skipping extraction.');
        return null;
    }

    try {
        const extracted = await extractCallDetails(transcript);
        console.log('Extracted call details:', JSON.stringify(summarizeExtractionForLog(extracted)));
        return extracted;
    } catch (error) {
        console.error('Error in processTranscriptAndSend:', error.message);
        return null;
    }
}
