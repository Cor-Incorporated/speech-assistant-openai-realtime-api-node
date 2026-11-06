import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildVoicemailEmail,
    fetchTwilioRecording,
    isRecordingSid,
    parseTwilioRecordingUrl,
    transcribeVoicemail
} from '../lib/voicemail.js';

const ACCOUNT_SID = `AC${'1'.repeat(32)}`;
const RECORDING_SID = `RE${'2'.repeat(32)}`;
const URL_OK = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}`;

test('only the exact Twilio recording URL shape is accepted', () => {
    assert.deepEqual(parseTwilioRecordingUrl(URL_OK), { accountSid: ACCOUNT_SID, recordingSid: RECORDING_SID });
    for (const bad of [
        '',
        `http://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}`,
        `https://api.twilio.com.evil.test/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}`,
        `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}/../x`,
        `${URL_OK}?x=1`,
        'https://evil.example.test/'
    ]) {
        assert.equal(parseTwilioRecordingUrl(bad), null, bad);
    }
    assert.equal(isRecordingSid(RECORDING_SID), true);
    assert.equal(isRecordingSid('REshort'), false);
});

test('recording download authenticates with the account credentials and never contacts other hosts', async () => {
    const calls = [];
    const ok = await fetchTwilioRecording({
        recordingUrl: URL_OK,
        authToken: 'secret',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return new Response(Buffer.from('abc'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
        }
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.audio.toString(), 'abc');
    assert.equal(calls[0].url, `${URL_OK}.mp3`);
    assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from(`${ACCOUNT_SID}:secret`).toString('base64')}`);

    const forged = await fetchTwilioRecording({
        recordingUrl: 'https://evil.example.test/x',
        authToken: 'secret',
        fetchImpl: async () => { throw new Error('must not be called'); }
    });
    assert.deepEqual(forged, { ok: false, reason: 'invalid_recording_url' });
    assert.deepEqual(await fetchTwilioRecording({ recordingUrl: URL_OK, authToken: '' }), { ok: false, reason: 'missing_auth_token' });
});

test('transcription sends Japanese audio to the configured model and surfaces failures', async () => {
    let seen;
    const result = await transcribeVoicemail({
        audio: Buffer.from('abc'),
        apiKey: 'sk-test',
        model: 'gpt-4o-transcribe',
        fetchImpl: async (url, options) => {
            seen = { url, headers: options.headers, form: options.body };
            return new Response(JSON.stringify({ text: '折り返しをお願いします。' }), { status: 200 });
        }
    });
    assert.deepEqual(result, { ok: true, text: '折り返しをお願いします。' });
    assert.equal(seen.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(seen.form.get('model'), 'gpt-4o-transcribe');
    assert.equal(seen.form.get('language'), 'ja');
    assert.equal(seen.headers.Authorization, 'Bearer sk-test');

    assert.deepEqual(await transcribeVoicemail({ audio: Buffer.alloc(0), apiKey: 'k' }), { ok: false, reason: 'empty_audio' });
    assert.deepEqual(
        await transcribeVoicemail({ audio: Buffer.from('a'), apiKey: 'k', fetchImpl: async () => new Response('{}', { status: 200 }) }),
        { ok: false, reason: 'empty_transcript' }
    );
});

test('voicemail email states the action needed and does not invent missing facts', () => {
    const mail = buildVoicemailEmail({
        callSid: 'CA1',
        callerNumber: '',
        context: { destination: 'contract', reason: '開発の相談', whisperSummary: '開発の見積依頼' },
        receivedAt: new Date('2026-11-07T15:30:00Z')
    });
    assert.match(mail.subject, /留守電あり（要折り返し）/);
    assert.match(mail.text, /折り返しが必要です/);
    assert.match(mail.text, /受信日時: 2026\/11\/08 00:30:00（日本時間）/);
    assert.match(mail.text, /発信者番号（Twilio）: 非通知／取得不可/);
    assert.match(mail.text, /転送区分: 受託・開発など仕事の依頼/);
    assert.match(mail.text, /文字起こしを取得できませんでした/);
    assert.match(mail.text, /留守番電話の長さ: 未確認/);
});
