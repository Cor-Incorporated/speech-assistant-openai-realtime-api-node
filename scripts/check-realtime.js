import dotenv from 'dotenv';
import WebSocket from 'ws';
import { buildRealtimeInputGateConfig } from '../lib/realtime-input-gate.js';
import {
    appendCallbackPhoneValidationInstructions,
    buildValidateCallbackPhoneTool
} from '../lib/phone-number-validation.js';
import {
    appendCallEndInstructions,
    buildCallEndConfig,
    buildFinishReceptionTool
} from '../lib/realtime-call-end.js';

dotenv.config();

const {
    OPENAI_API_KEY,
    REALTIME_MODEL = 'gpt-realtime-2',
    REALTIME_REASONING_EFFORT = 'low',
    REALTIME_CHECK_TIMEOUT_MS = '10000',
    TRANSCRIPTION_MODEL = 'gpt-4o-transcribe',
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
    CALL_END_WORKFLOW_ENABLED = 'true',
    CALL_END_HANGUP_ENABLED = 'true',
    CALL_END_FINAL_PHRASE = '',
    CALL_END_MARK_TIMEOUT_MS = '5000',
    CALL_END_GRACE_MS = '800'
} = process.env;

if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is required.');
    process.exit(1);
}

const timeoutMs = Number(REALTIME_CHECK_TIMEOUT_MS);
const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
const redactSecrets = (message) => message.replace(/sk-[^\s.]+/g, 'sk-***');
const shouldSetRealtimeReasoning = REALTIME_MODEL.startsWith('gpt-realtime-2');
const inputGateConfig = buildRealtimeInputGateConfig({
    REALTIME_INPUT_GATE_ENABLED,
    REALTIME_INPUT_GATE_MIN_JAPANESE_CHARS,
    REALTIME_INPUT_GATE_MIN_DIGITS,
    REALTIME_INPUT_GATE_ALLOWED_TERMS
});
const shouldCreateResponseFromVad = !inputGateConfig.enabled && VAD_CREATE_RESPONSE === 'true';
const shouldInterruptResponse = VAD_INTERRUPT_RESPONSE === 'true';
const callEndConfig = buildCallEndConfig({
    CALL_END_WORKFLOW_ENABLED,
    CALL_END_HANGUP_ENABLED,
    CALL_END_FINAL_PHRASE,
    CALL_END_MARK_TIMEOUT_MS,
    CALL_END_GRACE_MS
});
const finishReceptionTool = buildFinishReceptionTool(callEndConfig);
const validateCallbackPhoneTool = buildValidateCallbackPhoneTool();
const buildTurnDetectionConfig = () => {
    if (VAD_TYPE === 'semantic_vad') {
        return {
            type: VAD_TYPE,
            eagerness: VAD_EAGERNESS,
            create_response: shouldCreateResponseFromVad,
            interrupt_response: shouldInterruptResponse
        };
    }

    return {
        type: VAD_TYPE,
        threshold: Number(VAD_THRESHOLD),
        prefix_padding_ms: Number(VAD_PREFIX_PADDING_MS),
        silence_duration_ms: Number(VAD_SILENCE_DURATION_MS),
        create_response: shouldCreateResponseFromVad,
        interrupt_response: shouldInterruptResponse
    };
};

const buildSessionUpdate = () => {
    const session = {
        type: 'realtime',
        model: REALTIME_MODEL,
        instructions: appendCallEndInstructions(
            appendCallbackPhoneValidationInstructions('Realtime connectivity check. Keep responses brief.'),
            callEndConfig
        ),
        audio: {
            input: {
                format: { type: AUDIO_FORMAT },
                noise_reduction: AUDIO_NOISE_REDUCTION === 'null' ? null : { type: AUDIO_NOISE_REDUCTION },
                transcription: { model: TRANSCRIPTION_MODEL },
                turn_detection: buildTurnDetectionConfig()
            },
            output: {
                format: { type: AUDIO_FORMAT },
                voice: VOICE
            }
        }
    };

    session.tools = [
        validateCallbackPhoneTool,
        ...(finishReceptionTool ? [finishReceptionTool] : [])
    ];
    if (session.tools.length > 0) {
        session.tool_choice = 'auto';
    }

    if (shouldSetRealtimeReasoning) {
        session.reasoning = {
            effort: REALTIME_REASONING_EFFORT
        };
    }

    return {
        type: 'session.update',
        session
    };
};

const sessionUpdate = buildSessionUpdate();

const ws = new WebSocket(url, {
    headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
    }
});

const timeout = setTimeout(() => {
    console.error(`Realtime check timed out after ${timeoutMs}ms.`);
    ws.close();
    process.exit(1);
}, timeoutMs);

ws.on('open', () => {
    console.log(`ok - connected to OpenAI Realtime model ${REALTIME_MODEL}`);
    ws.send(JSON.stringify(sessionUpdate));
});

ws.on('message', (data) => {
    const event = JSON.parse(data);
    if (event.type === 'session.created') {
        console.log('ok - received session.created');
    }

    if (event.type === 'session.updated') {
        console.log('ok - session.update accepted');
        clearTimeout(timeout);
        ws.close();
    }

    if (event.type === 'error') {
        clearTimeout(timeout);
        const errorType = event.error?.type || 'unknown_error';
        const errorCode = event.error?.code || 'unknown_code';
        const errorMessage = redactSecrets(event.error?.message || 'No message returned');
        console.error(`not ok - OpenAI Realtime error: ${errorType} (${errorCode})`);
        console.error(errorMessage);
        ws.close();
        process.exit(1);
    }
});

ws.on('error', (error) => {
    clearTimeout(timeout);
    console.error(`not ok - WebSocket error: ${error.message}`);
    process.exit(1);
});

ws.on('close', (code) => {
    if (code !== 1000 && code !== 1005) {
        clearTimeout(timeout);
        console.error(`not ok - WebSocket closed with code ${code}`);
        process.exit(1);
    }
});
