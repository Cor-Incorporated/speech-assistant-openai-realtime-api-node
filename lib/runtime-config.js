import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const toBool = (value) => value === true || value === 'true';

const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const JAPAN_PHONE_TEXT_PATTERN = /(^|[^\d])((?:\+81|0)[\d\s().-]{8,}\d)(?!\d)/g;

const sha256 = (value) => crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');

const maskPhone = (value = '') => {
    const text = String(value || '');
    if (!text) return '';
    const digits = text.replace(/\D/g, '');
    if (digits.length <= 4) return '****';
    return `${text.startsWith('+') ? '+' : ''}****${digits.slice(-4)}`;
};

const redactPhoneText = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(JAPAN_PHONE_TEXT_PATTERN, (_match, prefix, phone) => `${prefix}${maskPhone(phone)}`);
};

const resolvePromptMetadata = ({ env, systemMessage, readFile = readFileSync } = {}) => {
    const promptFile = String(env.SYSTEM_MESSAGE_FILE || '').trim();

    if (promptFile) {
        try {
            const contents = readFile(resolve(process.cwd(), promptFile), 'utf8');
            return {
                source: 'file',
                hash: sha256(contents),
                length: contents.length,
                available: contents.length > 0
            };
        } catch (error) {
            return {
                source: 'file',
                hash: '',
                length: 0,
                available: false,
                error: 'unreadable'
            };
        }
    }

    const prompt = systemMessage ?? env.SYSTEM_MESSAGE ?? '';
    return {
        source: prompt ? 'env' : 'default',
        hash: prompt ? sha256(prompt) : '',
        length: String(prompt || '').length,
        available: Boolean(prompt)
    };
};

export function buildRuntimeConfig({
    env = process.env,
    systemMessage,
    readFile
} = {}) {
    return {
        models: {
            realtime: env.REALTIME_MODEL || 'gpt-realtime-2',
            transcription: env.TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
            extraction: env.EXTRACTION_MODEL || 'gpt-5.4-mini'
        },
        voice: env.VOICE || 'marin',
        vad: {
            type: env.VAD_TYPE || 'server_vad',
            threshold: toNumber(env.VAD_THRESHOLD, 0.65),
            prefixPaddingMs: toNumber(env.VAD_PREFIX_PADDING_MS, 300),
            silenceDurationMs: toNumber(env.VAD_SILENCE_DURATION_MS, 700),
            eagerness: env.VAD_EAGERNESS || 'low'
        },
        logging: {
            transcripts: toBool(env.LOG_TRANSCRIPTS),
            realtimeEvents: toBool(env.LOG_REALTIME_EVENTS),
            openAiResponses: toBool(env.LOG_OPENAI_RESPONSES)
        },
        storage: {
            firestoreEnabled: toBool(env.CALL_LOG_FIRESTORE_ENABLED),
            sheetsEnabled: toBool(env.CALL_LOG_SHEETS_ENABLED)
        },
        prompt: resolvePromptMetadata({ env, systemMessage, readFile }),
        firstMessage: env.FIRST_MESSAGE || ''
    };
}

export function sanitizeRuntimeConfig(config = {}) {
    const source = config && typeof config === 'object' ? config : {};

    return {
        models: {
            realtime: source.models?.realtime || source.REALTIME_MODEL || 'gpt-realtime-2',
            transcription: source.models?.transcription || source.TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
            extraction: source.models?.extraction || source.EXTRACTION_MODEL || 'gpt-5.4-mini'
        },
        voice: source.voice || source.VOICE || 'marin',
        vad: {
            type: source.vad?.type || source.VAD_TYPE || 'server_vad',
            threshold: toNumber(source.vad?.threshold ?? source.VAD_THRESHOLD, 0.65),
            prefixPaddingMs: toNumber(source.vad?.prefixPaddingMs ?? source.VAD_PREFIX_PADDING_MS, 300),
            silenceDurationMs: toNumber(source.vad?.silenceDurationMs ?? source.VAD_SILENCE_DURATION_MS, 700),
            eagerness: source.vad?.eagerness || source.VAD_EAGERNESS || 'low'
        },
        logging: {
            transcripts: toBool(source.logging?.transcripts ?? source.LOG_TRANSCRIPTS),
            realtimeEvents: toBool(source.logging?.realtimeEvents ?? source.LOG_REALTIME_EVENTS),
            openAiResponses: toBool(source.logging?.openAiResponses ?? source.LOG_OPENAI_RESPONSES)
        },
        storage: {
            firestoreEnabled: toBool(source.storage?.firestoreEnabled ?? source.CALL_LOG_FIRESTORE_ENABLED),
            sheetsEnabled: toBool(source.storage?.sheetsEnabled ?? source.CALL_LOG_SHEETS_ENABLED)
        },
        prompt: {
            source: source.prompt?.source || 'default',
            hash: source.prompt?.hash || '',
            length: Number.isFinite(Number(source.prompt?.length)) ? Number(source.prompt.length) : 0,
            available: Boolean(source.prompt?.available)
        },
        firstMessage: redactPhoneText(source.firstMessage || source.FIRST_MESSAGE || '')
    };
}

export function getRuntimeConfig(options = {}) {
    return buildRuntimeConfig(options);
}
