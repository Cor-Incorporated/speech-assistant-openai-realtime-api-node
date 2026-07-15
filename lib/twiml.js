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

export function buildMediaStreamTwimlWithParams({ host, from = '', to = '' } = {}) {
    const safeHost = escapeXml(host || 'localhost');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${safeHost}/media-stream">
      <Parameter name="from" value="${escapeXml(from)}" />
      <Parameter name="to" value="${escapeXml(to)}" />
    </Stream>
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
    timeoutSeconds = 7
} = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="${escapeXml(timeoutSeconds)}" finishOnKey="#"${xmlAttribute('action', confirmUrl)} method="POST">
    <Say language="ja-JP">Cor.株式会社コールセンターからの引き継ぎです。${escapeXml(summary)}。接続する場合は${escapeXml(acceptDigit)}を押してください。</Say>
  </Gather>
  <Hangup />
</Response>`;
}

export function buildWhisperConfirmTwiml({ accepted, acceptMessage = '接続します。', rejectMessage = '今回は接続せず終了します。' } = {}) {
    return accepted
        ? `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="ja-JP">${escapeXml(acceptMessage)}</Say></Response>`
        : `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="ja-JP">${escapeXml(rejectMessage)}</Say><Hangup /></Response>`;
}

export function buildDialStatusTwiml({ connected, fallbackMessage = '担当者が応答できませんでした。折り返しご連絡いたします。' } = {}) {
    return connected
        ? '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup /></Response>'
        : `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="ja-JP">${escapeXml(fallbackMessage)}</Say><Hangup /></Response>`;
}

export { escapeXml };
