const RECORDING_SID_PATTERN = /^RE[a-fA-F0-9]{32}$/;
const TWILIO_RECORDING_URL_PATTERN = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/(AC[a-fA-F0-9]{32})\/Recordings\/(RE[a-fA-F0-9]{32})$/;
const MAX_TRANSCRIPT_CHARS = 2000;

const DESTINATION_LABELS = Object.freeze({
    contract: '受託・開発など仕事の依頼',
    general: '緊急または人間の判断が必要な相談'
});

const display = (value, fallback) => {
    if (value === null || value === undefined) return fallback;
    return String(value).trim() || fallback;
};

const formatJst = (date = new Date()) => new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
}).format(date);

export function parseTwilioRecordingUrl(value) {
    const match = TWILIO_RECORDING_URL_PATTERN.exec(String(value || '').trim());
    return match ? { accountSid: match[1], recordingSid: match[2] } : null;
}

export const isRecordingSid = (value) => RECORDING_SID_PATTERN.test(String(value || ''));

// Twilio recordings need the account credentials. Only the exact Twilio API
// URL shape is fetched so a forged callback cannot point the server at
// another host.
export async function fetchTwilioRecording({
    recordingUrl,
    authToken,
    format = 'mp3',
    timeoutMs = 6000,
    fetchImpl = fetch
} = {}) {
    const parsed = parseTwilioRecordingUrl(recordingUrl);
    if (!parsed) return { ok: false, reason: 'invalid_recording_url' };
    if (!authToken) return { ok: false, reason: 'missing_auth_token' };

    try {
        const response = await fetchImpl(`${recordingUrl}.${format === 'wav' ? 'wav' : 'mp3'}`, {
            headers: {
                Authorization: `Basic ${Buffer.from(`${parsed.accountSid}:${authToken}`).toString('base64')}`
            },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) return { ok: false, reason: `http_${response.status}` };
        return {
            ok: true,
            audio: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers?.get?.('content-type') || 'audio/mpeg'
        };
    } catch (error) {
        return { ok: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'request_failed' };
    }
}

export async function transcribeVoicemail({
    audio,
    apiKey,
    model = 'gpt-4o-transcribe',
    timeoutMs = 8000,
    fetchImpl = fetch
} = {}) {
    if (!apiKey) return { ok: false, reason: 'missing_api_key' };
    if (!audio?.length) return { ok: false, reason: 'empty_audio' };

    try {
        const form = new FormData();
        form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voicemail.mp3');
        form.append('model', model);
        form.append('language', 'ja');
        const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) return { ok: false, reason: `http_${response.status}` };
        const data = await response.json();
        const text = String(data?.text || '').trim();
        return text ? { ok: true, text: text.slice(0, MAX_TRANSCRIPT_CHARS) } : { ok: false, reason: 'empty_transcript' };
    } catch (error) {
        return { ok: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'request_failed' };
    }
}

export function buildVoicemailEmail({
    callSid = '',
    callerNumber = '',
    context = {},
    recordingSid = '',
    durationSeconds = null,
    recordingLink = '',
    transcript = '',
    transcriptFailure = '',
    receivedAt = new Date()
} = {}) {
    const destinationLabel = DESTINATION_LABELS[context?.destination] || DESTINATION_LABELS.general;
    const transcriptBlock = transcript
        ? transcript
        : `（文字起こしを取得できませんでした${transcriptFailure ? `: ${transcriptFailure}` : ''}。録音を直接ご確認ください）`;
    const text = [
        '転送先の担当者が今すぐ対応できなかったため、発信者は留守番電話に入りました。折り返しが必要です。',
        '',
        `通話ID: ${display(callSid, '未確認')}`,
        `受信日時: ${formatJst(receivedAt)}（日本時間）`,
        `発信者番号（Twilio）: ${display(callerNumber, '非通知／取得不可')}`,
        `転送区分: ${destinationLabel}`,
        `転送理由: ${display(context?.reason, '未確認')}`,
        `留守番電話の長さ: ${durationSeconds === null || durationSeconds === undefined ? '未確認' : `${durationSeconds}秒`}`,
        `録音ID: ${display(recordingSid, '未確認')}`,
        `録音（管理画面のログインが必要）: ${display(recordingLink, '未確認')}`,
        '',
        '--- 留守番電話の文字起こし（AI自動生成・誤認識の可能性があります） ---',
        transcriptBlock,
        '',
        '--- 転送前のAI受付の要約 ---',
        display(context?.whisperSummary || context?.summary, '未確認'),
        '',
        '--- 転送前の受付内容 ---',
        display(context?.summary, '未確認')
    ].join('\n');

    return {
        subject: `【電話受付】留守電あり（要折り返し） ${display(callSid, '')}`.trim(),
        text
    };
}

export { RECORDING_SID_PATTERN };
