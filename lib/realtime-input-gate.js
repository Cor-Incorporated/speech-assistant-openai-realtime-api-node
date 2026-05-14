const JAPANESE_SUBSTANTIVE_CHAR_PATTERN = /[ぁ-んァ-ヶ一-龯々〆ヵヶ]/g;
const DIGIT_PATTERN = /\d/g;
const LOW_SIGNAL_PUNCTUATION_PATTERN = /^[\s。．.!！?？、,・\-ー〜~…]*$/;
const DTMF_BUTTON_TRANSCRIPT_PATTERN = /^[A-Za-z]\s*ボタン[\s。．.!！?？、,]*$/i;

const DEFAULT_ALLOWED_TERMS = [
    'PC',
    'Wi-Fi',
    'WiFi',
    'Windows',
    'Mac',
    'Excel',
    'Word',
    'Outlook'
];

const toBool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || String(value).toLowerCase() === 'true';
};

const toInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const normalizeTranscript = (value = '') => String(value || '')
    .normalize('NFKC')
    .trim();

const countMatches = (value, pattern) => value.match(pattern)?.length || 0;

const parseAllowedTerms = (value = DEFAULT_ALLOWED_TERMS.join(',')) => String(value || DEFAULT_ALLOWED_TERMS.join(','))
    .split(/[,|]/)
    .map((term) => normalizeTranscript(term))
    .filter(Boolean);

export function buildRealtimeInputGateConfig(env = process.env) {
    return {
        enabled: toBool(env.REALTIME_INPUT_GATE_ENABLED, true),
        minJapaneseChars: toInteger(env.REALTIME_INPUT_GATE_MIN_JAPANESE_CHARS, 2),
        minDigits: toInteger(env.REALTIME_INPUT_GATE_MIN_DIGITS, 4),
        allowedTerms: parseAllowedTerms(env.REALTIME_INPUT_GATE_ALLOWED_TERMS)
    };
}

export function evaluateRealtimeInputTranscript(transcript, config = {}) {
    const {
        enabled = true,
        minJapaneseChars = 2,
        minDigits = 4,
        allowedTerms = DEFAULT_ALLOWED_TERMS
    } = config;
    const normalized = normalizeTranscript(transcript);

    if (!normalized) {
        return {
            accepted: false,
            reason: 'empty_transcript',
            normalized
        };
    }

    if (!enabled) {
        return {
            accepted: true,
            reason: 'gate_disabled',
            normalized
        };
    }

    if (
        LOW_SIGNAL_PUNCTUATION_PATTERN.test(normalized)
        || DTMF_BUTTON_TRANSCRIPT_PATTERN.test(normalized)
    ) {
        return {
            accepted: false,
            reason: 'low_signal_pattern',
            normalized
        };
    }

    const digitCount = countMatches(normalized, DIGIT_PATTERN);
    if (digitCount >= minDigits) {
        return {
            accepted: true,
            reason: 'digits',
            normalized
        };
    }

    const japaneseCharCount = countMatches(normalized, JAPANESE_SUBSTANTIVE_CHAR_PATTERN);
    if (japaneseCharCount >= minJapaneseChars) {
        return {
            accepted: true,
            reason: 'japanese',
            normalized
        };
    }

    const normalizedLower = normalized.toLowerCase();
    const hasAllowedTerm = allowedTerms
        .map((term) => normalizeTranscript(term).toLowerCase())
        .some((term) => term && normalizedLower.includes(term));

    if (hasAllowedTerm) {
        return {
            accepted: true,
            reason: 'allowed_term',
            normalized
        };
    }

    return {
        accepted: false,
        reason: 'insufficient_speech_signal',
        normalized
    };
}
