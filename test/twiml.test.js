import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDialStatusTwiml,
    buildDtmfGatewayTwiml,
    buildGatewayRouteTwiml,
    buildHandoffDialTwiml,
    buildMediaStreamTwimlWithParams,
    buildWhisperConfirmTwiml,
    buildWhisperTwiml
} from '../lib/twiml.js';

test('DTMF gateway TwiML collects one digit and redirects timeout to fallback', () => {
    const body = buildDtmfGatewayTwiml({
        actionUrl: 'https://voice.example/gateway/route',
        fallbackUrl: 'https://voice.example/gateway/route?digits=none',
        timeoutSeconds: 2
    });

    assert.match(body, /input="dtmf"/);
    assert.match(body, /finishOnKey="#"/);
    assert.match(body, /action="https:\/\/voice\.example\/gateway\/route"/);
    assert.match(body, /digits=none/);
});

test('gateway routes only digit 5 to the practice system', () => {
    const fallback = buildMediaStreamTwimlWithParams({ host: 'voice.example' });
    const practice = buildGatewayRouteTwiml({
        digits: '5',
        practiceRedirectUrl: 'https://practice.example/incoming-call',
        fallbackTwiml: fallback
    });
    const other = buildGatewayRouteTwiml({
        digits: '7',
        practiceRedirectUrl: 'https://practice.example/incoming-call',
        fallbackTwiml: fallback
    });

    assert.match(practice, /practice\.example\/incoming-call/);
    assert.doesNotMatch(practice, /media-stream/);
    assert.match(other, /media-stream/);
});

test('handoff TwiML includes caller bridge, whisper, and status callbacks', () => {
    const body = buildHandoffDialTwiml({
        callSid: 'CA1234567890abcdef1234567890ABCDEF',
        numbers: ['+819012345678', '+818012345678'],
        callerId: '+815017929351',
        dialStatusUrl: 'https://voice.example/handoff/dial-status',
        legStatusUrl: 'https://voice.example/handoff/leg-status',
        whisperUrl: 'https://voice.example/handoff/whisper'
    });

    assert.match(body, /answerOnBridge="true"/);
    assert.match(body, /<Number[^>]*>\+819012345678<\/Number>/);
    assert.match(body, /handoff\/whisper\?call_sid=CA1234567890abcdef1234567890ABCDEF/);
    assert.match(body, /handoff\/dial-status/);
    assert.match(body, /handoff\/leg-status/);
});

test('whisper confirmation keeps accepted leg connected and hangs up rejection', () => {
    assert.doesNotMatch(buildWhisperConfirmTwiml({ accepted: true }), /Hangup/);
    assert.match(buildWhisperConfirmTwiml({ accepted: false }), /Hangup/);
    assert.match(buildWhisperTwiml({ summary: '資料請求', confirmUrl: 'https://voice.example/confirm' }), /資料請求/);
});

test('whisper identifies the company reception without exposing AI wording', () => {
    const body = buildWhisperTwiml({ summary: '資料請求', confirmUrl: 'https://voice.example/confirm' });

    assert.match(body, /Cor\.株式会社コールセンターからの引き継ぎ/);
    assert.doesNotMatch(body, /AI受付/);
});

test('dial status TwiML distinguishes connected and fallback calls', () => {
    assert.match(buildDialStatusTwiml({ connected: true }), /Hangup/);
    assert.match(buildDialStatusTwiml({ connected: false }), /折り返し/);
});
