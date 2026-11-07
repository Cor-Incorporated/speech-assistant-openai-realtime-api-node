import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDialStatusTwiml,
    buildDtmfGatewayTwiml,
    buildGatewayRouteTwiml,
    buildHandoffDialTwiml,
    buildMediaStreamTwimlWithParams,
    buildVoicemailThanksTwiml,
    buildVoicemailTwiml,
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

test('handoff timeout returns the caller to the media stream for follow-up intake', () => {
    const body = buildMediaStreamTwimlWithParams({
        host: 'voice.example',
        from: '+819012345678',
        to: '+815017929351',
        handoffFallback: true,
        introMessage: '担当者が応答できなかったため、引き続きご用件を確認します。'
    });

    assert.match(body, /担当者が応答できなかったため/);
    assert.match(body, /handoff_fallback/);
    assert.match(body, /media-stream/);
    assert.doesNotMatch(body, /Hangup/);
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

test('whisper asks whether the recipient can take the call now and sends the caller to voicemail on 2', () => {
    const body = buildWhisperTwiml({
        summary: 'イベント開催の相談',
        confirmUrl: 'https://voice.example/confirm',
        acceptDigit: '1',
        rejectDigit: '2'
    });
    const rejected = buildWhisperConfirmTwiml({ accepted: false, rejectedToCallCenter: true });

    assert.match(body, /イベント開催の相談/);
    assert.match(body, /今すぐ対応できる場合は1を押してください/);
    assert.match(body, /今は対応できない場合は2を押してください/);
    assert.match(body, /入力がない場合は、お客様を留守番電話へご案内します/);
    assert.match(rejected, /留守番電話へご案内します/);
    assert.match(rejected, /Hangup/);
});

test('whisper keeps the call-center wording in ai_reception rollback mode', () => {
    const body = buildWhisperTwiml({
        summary: 'イベント開催の相談',
        confirmUrl: 'https://voice.example/confirm',
        fallbackMode: 'ai_reception'
    });
    const rejected = buildWhisperConfirmTwiml({
        accepted: false,
        rejectedToCallCenter: true,
        fallbackMode: 'ai_reception'
    });

    assert.match(body, /コールセンターに戻す場合は2/);
    assert.doesNotMatch(body, /留守番電話/);
    assert.match(rejected, /コールセンターに戻します/);
});

test('voicemail TwiML announces recording, records with a beep and reports the finished recording', () => {
    const body = buildVoicemailTwiml({
        actionUrl: 'https://voice.example/handoff/voicemail-complete?call_sid=CA1',
        recordingStatusUrl: 'https://voice.example/handoff/recording-status?call_sid=CA1&x=1',
        maxLengthSeconds: 90
    });

    assert.match(body, /録音され、担当者が確認いたします/);
    assert.match(body, /<Record maxLength="90"[^>]*playBeep="true"[^>]*finishOnKey="#"/);
    assert.match(body, /action="https:\/\/voice\.example\/handoff\/voicemail-complete\?call_sid=CA1"/);
    assert.match(body, /recordingStatusCallback="https:\/\/voice\.example\/handoff\/recording-status\?call_sid=CA1&amp;x=1"/);
    assert.match(body, /recordingStatusCallbackEvent="completed absent"/);
    assert.match(buildVoicemailThanksTwiml(), /ありがとうございました[\s\S]*Hangup/);
});

test('whisper identifies the company reception without exposing AI wording', () => {
    const body = buildWhisperTwiml({ summary: '資料請求', confirmUrl: 'https://voice.example/confirm' });

    assert.match(body, /コー株式会社コールセンターからの引き継ぎ/);
    assert.doesNotMatch(body, /AI受付/);
});

test('whisper pronounces only the company name in audio without changing source text or third-party names', () => {
    const summary = 'Cor.株式会社とCor株式会社、Cor．株式会社について。Coral社・コル銀行・OtherCor株式会社の資料 <確認 & 連絡>。';
    const input = Object.freeze({ summary, confirmUrl: 'https://voice.example/confirm' });
    const body = buildWhisperTwiml(input);

    assert.ok(body.includes('コー株式会社とコー株式会社、コー株式会社について。Coral社・コル銀行・OtherCor株式会社の資料 &lt;確認 &amp; 連絡&gt;。'));
    assert.equal(input.summary, summary, 'stored/display summary must retain its original spelling');
    assert.doesNotMatch(body, /<確認/);
});

test('dial status TwiML distinguishes connected and fallback calls', () => {
    assert.match(buildDialStatusTwiml({ connected: true }), /Hangup/);
    assert.match(buildDialStatusTwiml({ connected: false }), /折り返し/);
});
