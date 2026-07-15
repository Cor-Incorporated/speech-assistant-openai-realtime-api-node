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
    updateTwilioCallTwiml
} from './lib/handoff.js';
import { NotificationOutbox } from './lib/notification-outbox.js';
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
import {
    auditLog,
    getTwilioWebhookUrl,
    maskPhone,
    shouldValidateTwilioSignature,
    validateTwilioSignature
} from './lib/security.js';

// .envファイルから環境変数を読み込む
dotenv.config();

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN_APP_DIST_DIR = resolve(CURRENT_DIR, 'dist/client');
const ADMIN_APP_INDEX_PATH = join(ADMIN_APP_DIST_DIR, 'index.html');

const DEFAULT_SYSTEM_MESSAGE = [
    'あなたは日本のコールセンターで電話一次受付を担当するAIオペレーターです。',
    '必ず自然で丁寧な日本語だけで応答してください。英語では応答しません。',
    '相手の発話が聞き取れない場合は、推測せず「恐れ入ります。もう一度お話しいただけますか」と確認してください。',
    '一度に複数の質問をせず、用件、名前、折り返し電話番号、希望日時などを一つずつ確認してください。',
    '氏名は聞こえた読みをそのままカタカナで確認してください。一般的な漢字名へ勝手に変換しないでください。',
    '氏名が少しでも不確かな場合は「お名前の読みをカタカナで確認させてください」と聞き返してください。',
    '会話を勝手に終了せず、必要に応じて担当者へ引き継ぐ旨を伝え、受付完了時は終話ルールに従って案内してください。',
    '採用応募・採用関連、営業・勧誘・広告、一般的な案内はAIで用件を受け付け、担当者へ自動転送しないでください。',
    '受託案件、開発・制作、業務委託、見積相談など仕事の依頼で人間対応が必要な場合は、transfer_to_humanをdestination="contract"で使用してください。',
    'それ以外で人間対応が必要な場合は、transfer_to_humanをdestination="general"で使用してください。',
    'まだ社名や業務ナレッジが未設定のため、断定できない内容は「確認して折り返します」と案内してください。'
].join('\n');

// 環境変数からOpenAI APIキーを取得
const {
    OPENAI_API_KEY,
    PORT = 5050,
    REALTIME_MODEL = 'gpt-realtime-2.1',
    REALTIME_REASONING_EFFORT = 'low',
    TRANSCRIPTION_MODEL = 'gpt-4o-transcribe',
    EXTRACTION_MODEL = 'gpt-5.4-mini',
    EXTRACTION_ENABLED = 'false',
    VOICE = 'marin',
    AUDIO_FORMAT = 'audio/pcmu',
    AUDIO_NOISE_REDUCTION = 'near_field',
    VAD_TYPE = 'server_vad',
    VAD_THRESHOLD = '0.65',
    VAD_PREFIX_PADDING_MS = '300',
    VAD_SILENCE_DURATION_MS = '700',
    VAD_EAGERNESS = 'low',
    VAD_CREATE_RESPONSE = 'true',
    VAD_INTERRUPT_RESPONSE = 'true',
    REALTIME_INPUT_GATE_ENABLED = 'true',
    REALTIME_INPUT_GATE_MIN_JAPANESE_CHARS = '2',
    REALTIME_INPUT_GATE_MIN_DIGITS = '4',
    REALTIME_INPUT_GATE_ALLOWED_TERMS = '',
    LOG_TRANSCRIPTS = 'false',
    LOG_REALTIME_EVENTS = 'false',
    LOG_OPENAI_RESPONSES = 'false',
    TWILIO_AUTH_TOKEN = '',
    TWILIO_SIGNATURE_VALIDATION_ENABLED = 'false',
    TWILIO_WEBHOOK_URL = '',
    TWILIO_PUBLIC_BASE_URL = '',
    DTMF_GATEWAY_ENABLED = 'false',
    PRACTICE_SYSTEM_REDIRECT_URL = '',
    DTMF_GATEWAY_TIMEOUT_S = '2',
    HANDOFF_ENABLED = 'false',
    HANDOFF_NUMBERS = '',
    HANDOFF_DIAL_TIMEOUT_S = '20',
    HANDOFF_WHISPER_ACCEPT_DIGIT = '1',
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
    FIRST_MESSAGE = 'お電話ありがとうございます。AI受付です。どのようなご用件でしょうか。',
    CALL_END_WORKFLOW_ENABLED = 'true',
    CALL_END_HANGUP_ENABLED = 'true',
    CALL_END_FINAL_PHRASE = '',
    CALL_END_MARK_TIMEOUT_MS = '5000',
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
const fastify = Fastify();
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

const appendTurn = (session, role, text) => {
    const normalizedText = String(text || '').trim();
    if (!normalizedText || normalizedText === 'Agent message not found') return;

    const lastTurn = session.turns.at(-1);
    if (lastTurn?.role === role && lastTurn.text === normalizedText) return;

    const label = role === 'agent' ? 'Agent' : 'User';
    session.transcript += `${label}: ${normalizedText}\n`;
    session.turns.push({ role, text: normalizedText, at: new Date().toISOString() });
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
    realtimeReasoningEffort = REALTIME_REASONING_EFFORT
} = {}) => {
    const session = {
        type: 'realtime',
        model: realtimeModel,
        instructions: RESOLVED_SYSTEM_MESSAGE,
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
                voice: VOICE
            }
        }
    };

    session.tools = [
        VALIDATE_CALLBACK_PHONE_TOOL,
        ...(TRANSFER_TO_HUMAN_TOOL ? [TRANSFER_TO_HUMAN_TOOL] : []),
        ...(FINISH_RECEPTION_TOOL ? [FINISH_RECEPTION_TOOL] : [])
    ];
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
        to
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
        to: request.body?.To || ''
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
    const summary = context?.summary || '受付内容の確認';
    await handoffContextStore.update(callSid, { status: 'whisper_started' });
    auditLog('handoff.whisper.started', {
        actor: 'twilio',
        target: callSid,
        metadata: { hasSummary: Boolean(context?.summary) }
    });

    return sendTwiml(reply, buildWhisperTwiml({
        summary,
        acceptDigit: HANDOFF_CONFIG.whisperAcceptDigit,
        confirmUrl: getPublicUrl(request, `/handoff/whisper-confirm?call_sid=${encodeURIComponent(callSid)}`)
    }));
});

fastify.post('/handoff/whisper-confirm', async (request, reply) => {
    const callSid = request.query?.call_sid || request.body?.CallSid || '';
    if (!HANDOFF_CONFIG.enabled) return reply.code(404).send({ error: 'handoff_disabled' });
    if (!isValidTwilioWebhook({ request })) return reply.code(403).send('Forbidden');

    const accepted = String(request.body?.Digits || '') === HANDOFF_CONFIG.whisperAcceptDigit;
    await handoffContextStore.update(callSid, {
        status: accepted ? 'whisper_accepted' : 'whisper_rejected',
        whisperAccepted: accepted
    });
    auditLog('handoff.whisper.completed', {
        actor: 'twilio',
        target: callSid,
        metadata: { accepted }
    });
    return sendTwiml(reply, buildWhisperConfirmTwiml({ accepted }));
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

    const connected = request.body?.DialCallStatus === 'completed';
    if (!connected) {
        const context = await handoffContextStore.get(callSid);
        const text = [
            '担当者への転送が成立しませんでした。',
            context?.summary ? `受付内容: ${context.summary}` : '受付内容は管理画面で確認してください。',
            '発信者へ折り返し連絡をお願いします。'
        ].join('\n');
        await notificationOutbox.enqueue({
            kind: 'handoff-fallback',
            callId: callSid,
            subject: `【電話受付】担当者不応答 ${callSid}`,
            text
        });
        await handoffContextStore.update(callSid, { status: 'fallback_notified', dialCallStatus: request.body?.DialCallStatus || '' });
    } else {
        await handoffContextStore.update(callSid, { status: 'connected', dialCallStatus: 'completed' });
    }

    auditLog('handoff.dial.completed', {
        actor: 'twilio',
        target: callSid,
        metadata: { dialCallStatus: request.body?.DialCallStatus || '', connected }
    });
    return sendTwiml(reply, buildDialStatusTwiml({ connected }));
});

// メディアストリーム用のWebSocketルート
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
        console.log('Media stream connected');
        let realtimeSettings;
        try {
            realtimeSettings = await getEffectiveRealtimeSettings();
        } catch (error) {
            console.error('Failed to read runtime model settings, falling back to env:', error.message);
            realtimeSettings = await getEffectiveRealtimeSettings({});
        }

        const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
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

        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeSettings.realtimeModel)}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`
            }
        });
        let responseInProgress = false;
        let responseCreatePending = false;
        let pendingResponseAfterCurrent = false;
        let callEndTimer = null;
        let callEndMarkTimeout = null;

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
                try {
                    twilioResult = await updateTwilioCallStatus({
                        accountSid: session.accountSid,
                        callSid: session.callSid,
                        authToken: TWILIO_AUTH_TOKEN
                    });
                } catch (error) {
                    twilioResult = {
                        ok: false,
                        skipped: false,
                        reason: 'twilio_api_exception'
                    };
                    console.error(`Failed to complete Twilio call ${session.callSid}: ${error.message}`);
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
            if (session.handoff?.started) return;

            const callSid = session.callSid || session.id;
            const selectedDestination = HANDOFF_CONFIG.destinationNumbers[destination]
                ? destination
                : 'general';
            const recipient = HANDOFF_CONFIG.destinationNumbers[selectedDestination]
                || HANDOFF_CONFIG.numbers[0]
                || '';
            const summary = summarizeHandoffTurns(session.turns);
            const context = {
                reason: reason || '担当者対応が必要',
                destination: selectedDestination,
                summary: summary || '受付内容を管理画面で確認してください。',
                from: maskPhone(session.from),
                to: maskPhone(session.to),
                status: 'requested',
                createdAt: new Date().toISOString()
            };

            try {
                await handoffContextStore.save(callSid, context);
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

                if (!result.ok) {
                    session.handoff = { started: false, failed: true, reason: result.reason || 'twilio_update_failed' };
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
                    reason: context.reason,
                    startedAt: new Date().toISOString()
                };
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
                if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
                if (connection.readyState === WebSocket.OPEN) connection.close(1000, 'handoff_started');
            } catch (error) {
                session.handoff = { started: false, failed: true, reason: 'handoff_exception' };
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

        const handleToolCalls = (event) => {
            const result = handleRealtimeToolCalls({
                event,
                state: session,
                callEndConfig: CALL_END_CONFIG,
                handoffConfig: HANDOFF_CONFIG
            });
            if (!result.handled) return false;

            for (const output of result.outputs) {
                openAiWs.send(JSON.stringify(output));
            }
            for (const callEndRequest of result.callEndRequests) {
                requestCallEnd(callEndRequest);
            }
            if (result.handoffRequests.length > 0) {
                void startHandoff(result.handoffRequests[0]);
                return true;
            }
            sendRealtimeResponseCreate(result.responseReason);
            return true;
        };

        const sendRealtimeResponseCreate = (reason) => {
            if (openAiWs.readyState !== WebSocket.OPEN) return;

            if (responseInProgress || responseCreatePending) {
                pendingResponseAfterCurrent = true;
                if (SHOULD_LOG_REALTIME_EVENTS) {
                    console.log(`Queued response.create until current response completes (${reason})`);
                }
                return;
            }

            responseCreatePending = true;
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
            if (SHOULD_LOG_REALTIME_EVENTS) {
                console.log(`Sent response.create (${reason})`);
            }
        };

        const deleteConversationItem = (itemId, reason) => {
            if (!itemId || openAiWs.readyState !== WebSocket.OPEN) return;

            openAiWs.send(JSON.stringify({
                type: 'conversation.item.delete',
                item_id: itemId
            }));

            if (SHOULD_LOG_REALTIME_EVENTS) {
                console.log(`Deleted ignored conversation item ${itemId} (${reason})`);
            }
        };

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: buildRealtimeSessionConfig(realtimeSettings)
            };

            console.log(`Sending Realtime session update for model ${realtimeSettings.realtimeModel}`);
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // OpenAI WebSocketが開いたとき
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(() => {
                sendSessionUpdate();
                // 通話開始時の挨拶を、顧客へ向けた日本語音声として生成する。
                const queuedFirstMessage = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [{
                            type: 'input_text',
                            text: `通話が開始しました。顧客に向けて、次の挨拶を自然な日本語で読み上げ、その後は顧客の返答を待ってください。「${FIRST_MESSAGE}」`
                        }]
                    }
                };
                openAiWs.send(JSON.stringify(queuedFirstMessage));
                // AIアシスタントに応答を促す
                sendRealtimeResponseCreate('first_message');
            }, 250);
        });

        // OpenAI WebSocketからのメッセージを処理
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (SHOULD_LOG_REALTIME_EVENTS && LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received Realtime event: ${response.type}`);
                }

                // ユーザーの音声認識結果を処理
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
                    console.log('Realtime session updated successfully');
                }

                if (response.type === 'response.created') {
                    responseInProgress = true;
                    responseCreatePending = false;
                }

                if (response.type === 'response.done') {
                    responseInProgress = false;
                    responseCreatePending = false;
                    if (handleToolCalls(response)) {
                        return;
                    }
                    if (pendingResponseAfterCurrent) {
                        pendingResponseAfterCurrent = false;
                        sendRealtimeResponseCreate('queued_after_response_done');
                        return;
                    }
                    sendEndCallMark('response_done');
                }

                if (response.type === 'error') {
                    responseCreatePending = false;
                    console.error('Realtime API error:', response.error?.message || 'Unknown realtime error');
                }

                if ((response.type === 'response.output_audio.delta' || response.type === 'response.audio.delta') && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: session.streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error.message);
            }
        });

        // Twilioからのメッセージを処理
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        session.streamSid = data.start.streamSid;
                        session.callSid = data.start.callSid || session.callSid;
                        session.accountSid = data.start.accountSid || '';
                        session.from = data.start.customParameters?.from || '';
                        session.to = data.start.customParameters?.to || '';
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
                        break;
                    case 'mark':
                        if (data.mark?.name && data.mark.name === session.callEnd?.markName) {
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
        });

        // 接続が閉じられたときの処理
        connection.on('close', async (code, reason) => {
            if (callEndTimer) clearTimeout(callEndTimer);
            if (callEndMarkTimeout) clearTimeout(callEndMarkTimeout);
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            session.endedAt = new Date();
            session.status = 'completed';
            session.disconnectReason = reason?.toString() || `twilio_ws_close_${code}`;
            console.log(`Client disconnected (${sessionId}).`);
            if (SHOULD_LOG_TRANSCRIPTS) {
                console.log('Full Transcript:');
                console.log(session.transcript);
            }

            const extraction = callLogSinks.shouldSkipSmokeLog(session)
                ? null
                : await processTranscriptAndSend(session.transcript, session.callSid || sessionId);
            const record = buildCallLogRecord(session, extraction);
            await callLogSinks.recordCompleted(record);
            await notificationOutbox.enqueue({
                kind: 'call-summary',
                callId: record.callSid,
                subject: `【電話受付】${record.intent || '新しい通話受付'} ${record.callSid}`,
                text: [
                    `通話ID: ${record.callSid}`,
                    `開始: ${record.startedAtJst || record.startedAt}`,
                    `通話秒数: ${record.durationSeconds}`,
                    `用件: ${record.intent || '未抽出'}`,
                    `要約: ${record.summary || '未抽出'}`,
                    `顧客名: ${record.customerName || '未確認'}`,
                    `折り返し番号: ${record.customerPhoneNumber || '未確認'}`,
                    `折り返し要否: ${record.callbackRequired ? '要' : '不要'}`
                ].join('\n')
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
            sessions.delete(sessionId);
        });

        // OpenAI WebSocketのエラー処理
        openAiWs.on('close', (code) => {
            session.openAiCloseCode = code;
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            session.openAiError = error.message;
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
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
