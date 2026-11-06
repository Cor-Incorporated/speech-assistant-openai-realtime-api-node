const escapeXml = (value = '') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const xmlAttribute = (name, value) => value === undefined || value === null || value === ''
    ? ''
    : ` ${name}="${escapeXml(value)}"`;

const normalizeUrl = (value = '') => String(value || '').trim().replace(/\/$/, '');

export function buildMediaStreamTwiml({ host } = {}) {
    const safeHost = escapeXml(host || 'localhost');
    return `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Connect>
                                      <Stream url="wss://${safeHost}/media-stream">
                                          <Parameter name="from" value="" />
                                          <Parameter name="to" value="" />
                                      </Stream>
                                  </Connect>
                              </Response>`;
}

export function buildMediaStreamTwimlWithParams({
    host,
    from = '',
    to = '',
    handoffFallback = false,
    introMessage = '',
    streamToken = ''
} = {}) {
    const safeHost = escapeXml(host || 'localhost');
    const introXml = introMessage
        ? `  <Say language="ja-JP">${escapeXml(introMessage)}</Say>\n`
        : '';
    const fallbackParameterXml = handoffFallback
        ? '      <Parameter name="handoff_fallback" value="true" />\n'
        : '';
    // Twilio does NOT forward the query string of <Connect><Stream url> on the
    // WebSocket handshake — the token must ride in the URL path (preserved) and
    // is also sent as a <Parameter> (arrives in start.customParameters) so the
    // credential reaches the server even if one channel is dropped.
    const tokenPath = streamToken ? `/${encodeURIComponent(streamToken)}` : '';
    const tokenParameterXml = streamToken
        ? `      <Parameter name="stream_token" value="${escapeXml(streamToken)}" />\n`
        : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${introXml}  <Connect>
    <Stream url="wss://${safeHost}/media-stream${escapeXml(tokenPath)}">
      <Parameter name="from" value="${escapeXml(from)}" />
      <Parameter name="to" value="${escapeXml(to)}" />
${tokenParameterXml}${fallbackParameterXml}    </Stream>
  </Connect>
</Response>`;
}

export function buildDtmfGatewayTwiml({ actionUrl, timeoutSeconds = 2, fallbackUrl } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" finishOnKey="#" timeout="${escapeXml(timeoutSeconds)}"${xmlAttribute('action', actionUrl)} method="POST"></Gather>
  <Redirect method="POST">${escapeXml(fallbackUrl || actionUrl || '')}</Redirect>
</Response>`;
}

export function buildGatewayRouteTwiml({ digits, practiceRedirectUrl, fallbackTwiml } = {}) {
    if (String(digits || '').trim() === '5' && normalizeUrl(practiceRedirectUrl)) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${escapeXml(practiceRedirectUrl)}</Redirect>
</Response>`;
    }

    return fallbackTwiml || '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>';
}

export function buildHandoffDialTwiml({
    numbers = [],
    callSid = '',
    callerId = '',
    timeoutSeconds = 20,
    dialStatusUrl,
    legStatusUrl,
    whisperUrl,
    introMessage = 'ただいま担当者へおつなぎします。'
} = {}) {
    const normalizedNumbers = numbers
        .map((number) => String(number || '').trim())
        .filter(Boolean)
        .slice(0, 10);
    const safeWhisperUrl = normalizeUrl(whisperUrl);
    const numberXml = normalizedNumbers.map((number) => {
        const url = safeWhisperUrl
            ? `${safeWhisperUrl}?call_sid=${encodeURIComponent(String(callSid || ''))}`
            : '';
        return `    <Number${xmlAttribute('url', url)}${xmlAttribute('method', 'POST')}${xmlAttribute('statusCallback', legStatusUrl)}${xmlAttribute('statusCallbackMethod', 'POST')} statusCallbackEvent="initiated ringing answered completed">${escapeXml(number)}</Number>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP">${escapeXml(introMessage)}</Say>
  <Dial answerOnBridge="true" timeout="${escapeXml(timeoutSeconds)}"${xmlAttribute('callerId', callerId)}${xmlAttribute('action', dialStatusUrl)} method="POST">
${numberXml}
  </Dial>
</Response>`;
}

export function buildWhisperTwiml({
    summary = '受付内容の確認',
    confirmUrl,
    acceptDigit = '1',
    rejectDigit = '2',
    timeoutSeconds = 10,
    fallbackMode = 'voicemail'
} = {}) {
    const rejectGuidance = fallbackMode === 'voicemail'
        ? `今は対応できない場合は${escapeXml(rejectDigit)}を押してください。${escapeXml(rejectDigit)}を押した場合、または入力がない場合は、お客様を留守番電話へご案内します。`
        : `コールセンターに戻す場合は${escapeXml(rejectDigit)}を押してください。`;
    const timeoutNotice = fallbackMode === 'voicemail'
        ? '入力がなかったため、お客様を留守番電話へご案内します。'
        : '入力がなかったため、コールセンターに戻します。';

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="${escapeXml(timeoutSeconds)}" finishOnKey="#"${xmlAttribute('action', confirmUrl)} method="POST">
    <Say language="ja-JP">Cor.株式会社コールセンターからの引き継ぎです。${escapeXml(summary)}。今すぐ対応できる場合は${escapeXml(acceptDigit)}を押してください。${rejectGuidance}</Say>
  </Gather>
  <Say language="ja-JP">${timeoutNotice}</Say>
  <Hangup />
</Response>`;
}

export function buildWhisperConfirmTwiml({
    accepted,
    rejectedToCallCenter = false,
    fallbackMode = 'voicemail',
    acceptMessage = '接続します。',
    rejectMessage = '今回は接続せず終了します。',
    callCenterMessage = 'コールセンターに戻します。',
    voicemailMessage = 'お客様を留守番電話へご案内します。'
} = {}) {
    if (accepted) {
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="ja-JP">${escapeXml(acceptMessage)}</Say></Response>`;
    }
    const message = rejectedToCallCenter
        ? (fallbackMode === 'voicemail' ? voicemailMessage : callCenterMessage)
        : rejectMessage;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="ja-JP">${escapeXml(message)}</Say><Hangup /></Response>`;
}

export function buildDialStatusTwiml({ connected, fallbackMessage = '担当者が応答できませんでした。折り返しご連絡いたします。' } = {}) {
    return connected
        ? '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>'
        : `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="ja-JP">${escapeXml(fallbackMessage)}</Say><Hangup /></Response>`;
}

export function buildVoicemailTwiml({
    actionUrl,
    recordingStatusUrl,
    maxLengthSeconds = 120,
    silenceTimeoutSeconds = 6,
    promptMessage = '担当者はただいま電話に出ることができません。ピーという音のあとに、お名前、ご用件、折り返しのお電話番号をお話しください。内容は録音され、担当者が確認いたします。話し終わりましたら、シャープを押してください。',
    failureMessage = '録音を確認できませんでした。恐れ入りますが、改めてお電話ください。'
} = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP">${escapeXml(promptMessage)}</Say>
  <Record maxLength="${escapeXml(maxLengthSeconds)}" timeout="${escapeXml(silenceTimeoutSeconds)}" playBeep="true" finishOnKey="#" trim="trim-silence"${xmlAttribute('action', actionUrl)} method="POST"${xmlAttribute('recordingStatusCallback', recordingStatusUrl)}${recordingStatusUrl ? ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed absent"' : ''} />
  <Say language="ja-JP">${escapeXml(failureMessage)}</Say>
  <Hangup />
</Response>`;
}

export function buildVoicemailThanksTwiml({
    message = 'ありがとうございました。担当者が内容を確認し、必要に応じてご連絡いたします。失礼いたします。'
} = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="ja-JP">${escapeXml(message)}</Say><Hangup /></Response>`;
}

export { escapeXml };
