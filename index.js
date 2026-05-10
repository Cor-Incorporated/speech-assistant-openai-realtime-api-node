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
    '会話を勝手に終了せず、必要に応じて担当者へ引き継ぐ旨を伝えてください。',
    'まだ社名や業務ナレッジが未設定のため、断定できない内容は「確認して折り返します」と案内してください。'
].join('\n');

// 環境変数からOpenAI APIキーを取得
const {
    OPENAI_API_KEY,
    PORT = 5050,
    REALTIME_MODEL = 'gpt-realtime-2',
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
    LOG_TRANSCRIPTS = 'false',
    LOG_REALTIME_EVENTS = 'false',
    LOG_OPENAI_RESPONSES = 'false',
    TWILIO_AUTH_TOKEN = '',
    TWILIO_SIGNATURE_VALIDATION_ENABLED = 'false',
    TWILIO_WEBHOOK_URL = '',
    GOOGLE_CLOUD_PROJECT = '',
    CALL_LOG_FIRESTORE_ENABLED = 'false',
    CALL_LOG_FIRESTORE_DATABASE_ID = '',
    CALL_LOG_FIRESTORE_COLLECTION = 'callLogs',
    CALL_LOG_SHEETS_ENABLED = 'false',
    GOOGLE_SHEETS_SPREADSHEET_ID = '',
    GOOGLE_SHEETS_RANGE = '',
    SYSTEM_MESSAGE = DEFAULT_SYSTEM_MESSAGE,
    SYSTEM_MESSAGE_FILE = '',
    FIRST_MESSAGE = 'お電話ありがとうございます。AI受付です。どのようなご用件でしょうか。'
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

const RESOLVED_SYSTEM_MESSAGE = resolveSystemMessage();

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
const SHOULD_SET_REALTIME_REASONING = REALTIME_MODEL.startsWith('gpt-realtime-2');
const callLogSinks = new CallLogSinks({
    firestoreEnabled: CALL_LOG_FIRESTORE_ENABLED,
    firestoreDatabaseId: CALL_LOG_FIRESTORE_DATABASE_ID,
    firestoreCollection: CALL_LOG_FIRESTORE_COLLECTION,
    sheetsEnabled: CALL_LOG_SHEETS_ENABLED,
    spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
    sheetsRange: GOOGLE_SHEETS_RANGE,
    googleProjectId: GOOGLE_CLOUD_PROJECT
});
const callLogStore = new CallLogStore({
    firestoreEnabled: CALL_LOG_FIRESTORE_ENABLED,
    firestoreDatabaseId: CALL_LOG_FIRESTORE_DATABASE_ID,
    firestoreCollection: CALL_LOG_FIRESTORE_COLLECTION,
    googleProjectId: GOOGLE_CLOUD_PROJECT
});
const adminAuth = createAdminBasicAuth();

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
    auth: adminAuth,
    config: () => getRuntimeConfig({
        systemMessage: RESOLVED_SYSTEM_MESSAGE
    }),
    auditLog
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

const escapeXml = (value = '') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

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
            create_response: true,
            interrupt_response: true
        };
    }

    return {
        type: VAD_TYPE,
        threshold: Number(VAD_THRESHOLD),
        prefix_padding_ms: Number(VAD_PREFIX_PADDING_MS),
        silence_duration_ms: Number(VAD_SILENCE_DURATION_MS),
        create_response: true,
        interrupt_response: true
    };
};

const buildRealtimeSessionConfig = () => {
    const session = {
        type: 'realtime',
        model: REALTIME_MODEL,
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

    if (SHOULD_SET_REALTIME_REASONING) {
        session.reasoning = {
            effort: REALTIME_REASONING_EFFORT
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
    'response.output_text.done',
    'response.output_audio_transcript.done',
    'conversation.item.input_audio_transcription.completed'
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
    const signature = request.headers['x-twilio-signature'];
    const webhookUrl = getTwilioWebhookUrl(request, TWILIO_WEBHOOK_URL);
    const callSid = request.body?.CallSid || '';
    const from = escapeXml(request.body?.From || '');
    const to = escapeXml(request.body?.To || '');

    if (SHOULD_VALIDATE_TWILIO_SIGNATURE) {
        const isValid = validateTwilioSignature({
            authToken: TWILIO_AUTH_TOKEN,
            signature,
            url: webhookUrl,
            params: request.body || {}
        });

        if (!isValid) {
            auditLog('twilio.webhook.rejected', {
                actor: 'twilio',
                target: callSid || 'incoming-call',
                result: 'failure',
                metadata: { reason: 'invalid_signature', hasSignature: Boolean(signature) }
            });
            return reply.code(403).send('Forbidden');
        }
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

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Connect>
                                      <Stream url="wss://${request.headers.host}/media-stream">
                                          <Parameter name="from" value="${from}" />
                                          <Parameter name="to" value="${to}" />
                                      </Stream>
                                  </Connect>
                              </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// メディアストリーム用のWebSocketルート
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Media stream connected');

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

        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`
            }
        });

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: buildRealtimeSessionConfig()
            };

            console.log(`Sending Realtime session update for model ${REALTIME_MODEL}`);
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
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
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
                    const userMessage = response.transcript.trim();
                    appendTurn(session, 'user', userMessage);
                    if (SHOULD_LOG_TRANSCRIPTS && userMessage) console.log(`User (${sessionId}): ${userMessage}`);
                }

                if (response.type === 'response.output_audio_transcript.done') {
                    const agentMessage = response.transcript || '';
                    appendTurn(session, 'agent', agentMessage);
                    if (SHOULD_LOG_TRANSCRIPTS && agentMessage) console.log(`Agent (${sessionId}): ${agentMessage}`);
                }

                if (response.type === 'session.updated') {
                    console.log('Realtime session updated successfully');
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
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            session.endedAt = new Date();
            session.status = 'completed';
            session.disconnectReason = reason?.toString() || `twilio_ws_close_${code}`;
            console.log(`Client disconnected (${sessionId}).`);
            if (SHOULD_LOG_TRANSCRIPTS) {
                console.log('Full Transcript:');
                console.log(session.transcript);
            }

            const extraction = await processTranscriptAndSend(session.transcript, session.callSid || sessionId);
            const record = buildCallLogRecord(session, extraction);
            await callLogSinks.recordCompleted(record);
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
