const MIN_CALLBACK_PHONE_DIGITS = 10;
const MAX_CALLBACK_PHONE_DIGITS = 11;
const MIN_FRAGMENT_DIGITS = 7;
export const VALIDATE_CALLBACK_PHONE_TOOL_NAME = 'validate_callback_phone';

const PHONE_CANDIDATE_CHARS = new Set([
    '+',
    '(',
    ')',
    '.',
    '/',
    ' ',
    '\t',
    '\n',
    '\r',
    '-',
    'ー',
    '−',
    '―',
    '‐',
    '‑',
    '‒',
    '–',
    '—',
    'ｰ',
    'の'
]);

const PLACEHOLDER_PHONE_NUMBERS = new Set([
    '0000000000',
    '00000000000',
    '0123456789',
    '01234567890',
    '0987654321',
    '09876543210'
]);

export const CALLBACK_PHONE_CLARIFICATION_PROMPTS = {
    empty: '折り返し先のお電話番号を、市外局番から10桁または11桁でお聞かせください。',
    noCandidate: '恐れ入ります。折り返し先のお電話番号を、市外局番から10桁または11桁でお願いします。',
    tooShort: '恐れ入ります。番号が短く聞こえました。市外局番から10桁または11桁で、もう一度お願いします。',
    tooLong: '恐れ入ります。番号が長く聞こえました。折り返し先のお電話番号を1つだけ、10桁または11桁でお願いします。',
    invalid: '恐れ入ります。日本国内の電話番号として確認できませんでした。0から始まる10桁または11桁の番号でお願いします。',
    multiple: '折り返し先のお電話番号が複数聞こえました。1つだけ、10桁または11桁でお伝えください。',
    suspicious: '恐れ入ります。電話番号が正しく聞き取れませんでした。市外局番から10桁または11桁で、もう一度お願いします。'
};

const isDigit = (char) => char >= '0' && char <= '9';

const isCandidateChar = (char) => isDigit(char) || PHONE_CANDIDATE_CHARS.has(char);

const normalizeInput = (value) => String(value ?? '').normalize('NFKC').trim();

const digitCount = (value) => (value.match(/\d/g) || []).length;

const digitsOnly = (value) => value.replace(/\D/g, '');

const trimCandidate = (value) => value
    .replace(/^[^\d+]+/, '')
    .replace(/[^\d)]+$/, '')
    .trim();

const isSuspiciousPhoneNumber = (phoneNumber) => {
    if (PLACEHOLDER_PHONE_NUMBERS.has(phoneNumber)) return true;

    const subscriberDigits = phoneNumber.slice(1);
    if (subscriberDigits.length > 0 && new Set(subscriberDigits).size === 1) return true;

    return /(\d)\1{7,}/.test(phoneNumber);
};

const promptForReason = (reason) => {
    if (reason === 'empty') return CALLBACK_PHONE_CLARIFICATION_PROMPTS.empty;
    if (reason === 'no_candidate') return CALLBACK_PHONE_CLARIFICATION_PROMPTS.noCandidate;
    if (reason === 'too_short') return CALLBACK_PHONE_CLARIFICATION_PROMPTS.tooShort;
    if (reason === 'too_long') return CALLBACK_PHONE_CLARIFICATION_PROMPTS.tooLong;
    if (reason === 'multiple_candidates') return CALLBACK_PHONE_CLARIFICATION_PROMPTS.multiple;
    if (reason === 'suspicious_model_expanded_number') return CALLBACK_PHONE_CLARIFICATION_PROMPTS.suspicious;
    return CALLBACK_PHONE_CLARIFICATION_PROMPTS.invalid;
};

const buildInvalidResult = (reason, normalizedInput, extra = {}) => ({
    valid: false,
    reason,
    normalizedInput,
    normalizedPhoneNumber: '',
    formattedSpokenDigits: '',
    confirmationPrompt: '',
    clarificationPrompt: promptForReason(reason),
    ...extra
});

export function formatSpokenPhoneDigits(phoneNumber) {
    return digitsOnly(String(phoneNumber || '')).split('').join('、');
}

export function extractPhoneDigits(value) {
    return digitsOnly(normalizeInput(value));
}

export function appendPhoneDigitFragments(previous, current) {
    const previousDigits = extractPhoneDigits(previous);
    const currentDigits = extractPhoneDigits(current);
    if (!previousDigits) return currentDigits;
    if (!currentDigits) return previousDigits;

    const maxOverlap = Math.min(previousDigits.length, currentDigits.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
        if (previousDigits.endsWith(currentDigits.slice(0, overlap))) {
            return previousDigits + currentDigits.slice(overlap);
        }
    }

    return previousDigits + currentDigits;
}

export function recoverRepeatedJapaneseCallbackPhoneNumber(value) {
    const digits = extractPhoneDigits(value);
    for (const phoneLength of [MIN_CALLBACK_PHONE_DIGITS, MAX_CALLBACK_PHONE_DIGITS]) {
        if (digits.length <= phoneLength || digits.length % phoneLength !== 0) continue;

        const firstNumber = digits.slice(0, phoneLength);
        if (firstNumber.repeat(digits.length / phoneLength) !== digits) continue;

        const validation = validateJapaneseCallbackPhoneNumber(firstNumber);
        if (validation.valid) return validation;
    }

    return null;
}

export function extractJapanesePhoneCandidates(value) {
    const normalizedInput = normalizeInput(value);
    const candidates = [];
    let buffer = '';

    const flush = () => {
        const raw = trimCandidate(buffer);
        buffer = '';
        if (digitCount(raw) < MIN_FRAGMENT_DIGITS) return;

        candidates.push(raw);
    };

    for (const char of normalizedInput) {
        if (!isCandidateChar(char)) {
            flush();
            continue;
        }

        if (!buffer && !isDigit(char) && char !== '+') continue;
        buffer += char;
    }

    flush();
    return candidates;
}

const normalizeCandidateToDomesticPhoneNumber = (candidate) => {
    const plusCount = (candidate.match(/\+/g) || []).length;
    const hasLeadingPlus = /^\+/.test(candidate);
    const digits = digitsOnly(candidate);

    if (!digits) {
        return { reason: 'no_candidate', phoneNumber: '' };
    }

    if (plusCount > 1 || (plusCount === 1 && !hasLeadingPlus)) {
        return { reason: 'invalid_plus_position', phoneNumber: digits };
    }

    if (!hasLeadingPlus) {
        return { reason: 'domestic', phoneNumber: digits };
    }

    if (!digits.startsWith('81')) {
        return { reason: 'unsupported_country_code', phoneNumber: digits };
    }

    const subscriberNumber = digits.slice(2);
    return {
        reason: 'domestic',
        phoneNumber: subscriberNumber.startsWith('0') ? subscriberNumber : `0${subscriberNumber}`
    };
};

const evaluateDomesticPhoneNumber = (phoneNumber) => {
    if (phoneNumber.length < MIN_CALLBACK_PHONE_DIGITS) return 'too_short';
    if (phoneNumber.length > MAX_CALLBACK_PHONE_DIGITS) return 'too_long';
    if (!/^0[1-9]\d+$/.test(phoneNumber)) return 'invalid_domestic_number';
    if (isSuspiciousPhoneNumber(phoneNumber)) return 'suspicious_model_expanded_number';
    return 'valid';
};

export function validateJapaneseCallbackPhoneNumber(value) {
    const normalizedInput = normalizeInput(value);

    if (!normalizedInput) {
        return buildInvalidResult('empty', normalizedInput);
    }

    const candidates = extractJapanesePhoneCandidates(normalizedInput);
    if (candidates.length === 0) {
        return buildInvalidResult('no_candidate', normalizedInput);
    }

    const evaluatedCandidates = candidates.map((candidate) => {
        const normalized = normalizeCandidateToDomesticPhoneNumber(candidate);
        const reason = normalized.reason === 'domestic'
            ? evaluateDomesticPhoneNumber(normalized.phoneNumber)
            : normalized.reason;

        return {
            raw: candidate,
            reason,
            normalizedPhoneNumber: reason === 'valid' ? normalized.phoneNumber : ''
        };
    });

    const validCandidates = evaluatedCandidates.filter((candidate) => candidate.reason === 'valid');
    if (validCandidates.length > 1) {
        return buildInvalidResult('multiple_candidates', normalizedInput);
    }

    if (validCandidates.length === 1) {
        const normalizedPhoneNumber = validCandidates[0].normalizedPhoneNumber;
        const formattedSpokenDigits = formatSpokenPhoneDigits(normalizedPhoneNumber);

        return {
            valid: true,
            reason: 'valid',
            normalizedInput,
            normalizedPhoneNumber,
            formattedSpokenDigits,
            confirmationPrompt: `折り返し先は ${formattedSpokenDigits} でよろしいでしょうか。`,
            clarificationPrompt: ''
        };
    }

    const primaryReason = evaluatedCandidates.find((candidate) => candidate.reason === 'too_short')?.reason
        || evaluatedCandidates.find((candidate) => candidate.reason === 'too_long')?.reason
        || evaluatedCandidates.find((candidate) => candidate.reason === 'suspicious_model_expanded_number')?.reason
        || evaluatedCandidates[0].reason;

    return buildInvalidResult(primaryReason, normalizedInput);
}

export function buildValidateCallbackPhoneTool() {
    return {
        type: 'function',
        name: VALIDATE_CALLBACK_PHONE_TOOL_NAME,
        description: [
            'Validate a callback phone number exactly as heard from the customer.',
            'Use this immediately after the customer gives a callback phone number.',
            'Do not add digits, infer missing prefixes, or convert a short fragment into a Japanese mobile number yourself.'
        ].join(' '),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                heard_phone_number: {
                    type: 'string',
                    description: 'The latest callback phone number phrase exactly as heard from the customer. Include only one utterance; do not include previous turns, instructions, confirmation text, or repeated attempts.'
                }
            },
            required: ['heard_phone_number']
        }
    };
}

export function appendCallbackPhoneValidationInstructions(systemMessage) {
    return [
        systemMessage,
        [
            '電話番号確認ルール:',
            '折り返し先の電話番号を聞いたら、番号を復唱する前に必ず validate_callback_phone ツールを呼び出してください。',
            'heard_phone_numberには顧客が直前に話した電話番号の発話だけを入れ、過去の会話、指示文、確認文、複数回分の番号を連結してはいけません。',
            '顧客が番号を話している途中で発話を差し込まず、発話が終わってからツールを呼び出してください。',
            '顧客が言っていない 090、080、市外局番、末尾番号を補完してはいけません。',
            'validate_callback_phone が valid=false を返した場合は、返された clarificationPrompt をそのまま自然に読み上げ、もう一度番号を聞いてください。',
            'validate_callback_phone が valid=true を返した場合だけ、返された confirmationPrompt で確認してください。',
            '折り返しが必要な受付では、電話番号が validate_callback_phone で有効判定され、顧客に確認するまでは finish_reception を呼び出してはいけません。'
        ].join('\n')
    ].join('\n\n');
}

export function findValidateCallbackPhoneToolCalls(event) {
    const outputs = Array.isArray(event?.response?.output) ? event.response.output : [];

    return outputs
        .filter((item) => item?.type === 'function_call' && item?.name === VALIDATE_CALLBACK_PHONE_TOOL_NAME)
        .map((item) => {
            let argumentsJson = {};
            try {
                argumentsJson = item.arguments ? JSON.parse(item.arguments) : {};
            } catch {
                argumentsJson = {};
            }

            return {
                callId: item.call_id || '',
                heardPhoneNumber: String(argumentsJson.heard_phone_number || '').trim()
            };
        })
        .filter((item) => item.callId);
}
