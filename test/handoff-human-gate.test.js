// シナリオテスト: 人間ゲート（転送→要約読み上げ→接続/留守電）をTwilio webhook単位で通しで検証する。
// Twilio・OpenAI・ResendはfetchImplで差し替え、通知は本物のNotificationOutboxを経由して
// 実際の送信payload（宛先・件名・本文）を検査する。
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import { buildHandoffConfig, HandoffContextStore } from '../lib/handoff.js';
import { registerHandoffRoutes } from '../lib/handoff-routes.js';
import { NotificationOutbox } from '../lib/notification-outbox.js';

const CALL_SID = `CA${'a'.repeat(32)}`;
const ACCOUNT_SID = `AC${'b'.repeat(32)}`;
const RECORDING_SID = `RE${'c'.repeat(32)}`;
const RECORDING_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}`;
const PUBLIC_BASE = 'https://voice.example.test';
const CALLER = '+819011112222';

const form = (fields) => new URLSearchParams(fields).toString();
const post = (app, url, fields = {}) => app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'voice.example.test' },
    payload: form(fields)
});
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
});

async function buildHarness({
    configOverrides = {},
    contextSeed = {},
    transcript = '来週の打ち合わせの日程を変更したいです。折り返しをお願いします。',
    transcriptionStatus = 200,
    recordingStatus = 200,
    emailStatuses = [],
    beforeEmail = async () => {},
    signatureValid = true,
    notifyTo = 'ops@example.test',
    notifyCc = 'k.isayama@cor-jp.com,team@example.test'
} = {}) {
    const config = buildHandoffConfig({
        HANDOFF_ENABLED: 'true',
        HANDOFF_NUMBERS: '+810000000000',
        HANDOFF_SUMMARY_WAIT_MS: 400,
        ...configOverrides
    });
    const contextStore = new HandoffContextStore({ firestoreEnabled: false });
    await contextStore.save(CALL_SID, {
        reason: '緊急の人間対応',
        destination: 'general',
        summary: '発信者: 納品物が動かない。至急見てほしい。',
        whisperSummary: '用件は納品物が動かない、至急見てほしい',
        summaryStatus: 'skipped',
        from: '+8190****2222',
        status: 'requested',
        ...contextSeed
    });

    const emails = [];
    const upstream = [];
    const outcomes = [];
    const fetchImpl = async (url, options = {}) => {
        upstream.push({ url: String(url), options });
        const target = String(url);
        if (target === 'https://api.resend.com/emails') {
            await beforeEmail(contextStore);
            emails.push(JSON.parse(options.body));
            const status = emailStatuses[emails.length - 1] || 200;
            return jsonResponse(status === 200 ? { id: `email_${emails.length}` } : { message: 'temporary failure' }, status);
        }
        if (target.startsWith(RECORDING_URL)) {
            return recordingStatus === 200
                ? new Response(Buffer.from('fake-mp3-bytes'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
                : new Response('nope', { status: recordingStatus });
        }
        if (target === 'https://api.openai.com/v1/audio/transcriptions') {
            return transcriptionStatus === 200
                ? jsonResponse({ text: transcript })
                : jsonResponse({ error: 'bad' }, transcriptionStatus);
        }
        throw new Error(`unexpected fetch ${target}`);
    };
    const notificationOutbox = new NotificationOutbox({
        enabled: true,
        apiKey: 'resend-test',
        to: notifyTo,
        cc: notifyCc,
        from: 'noreply@example.test',
        fetchImpl
    });

    const audit = [];
    const app = Fastify();
    await app.register(fastifyFormBody);
    await app.register(registerHandoffRoutes, {
        config,
        contextStore,
        notificationOutbox,
        isValidTwilioWebhook: () => signatureValid,
        getPublicUrl: (_request, path) => `${PUBLIC_BASE}${path}`,
        createStreamToken: () => 'stream-token-for-test',
        twilioAuthToken: 'twilio-auth-token-test',
        openAiApiKey: 'sk-test',
        transcriptionModel: 'gpt-4o-transcribe',
        adminPreHandler: async (request, reply) => {
            if (request.headers.authorization !== 'Basic admin-ok') {
                reply.code(401).send({ error: 'unauthorized' });
            }
        },
        auditLog: (event, payload) => audit.push({ event, ...payload }),
        onHandoffOutcome: async (callSid, patch) => outcomes.push({ callSid, ...patch }),
        fetchImpl,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)))
    });
    await app.ready();
    return { app, config, contextStore, emails, upstream, audit, outcomes };
}

describe('human gate: recipient answers the transfer', () => {
    let harness;
    beforeEach(async () => { harness = await buildHarness(); });
    afterEach(async () => { await harness.app.close(); });

    it('speaks the summary, asks if the recipient can take the call now, and bridges on 1', async () => {
        const whisper = await post(harness.app, `/handoff/whisper?call_sid=${CALL_SID}`);
        assert.equal(whisper.statusCode, 200);
        assert.match(whisper.headers['content-type'], /text\/xml/);
        assert.match(whisper.body, /Cor\.株式会社コールセンターからの引き継ぎ/);
        assert.match(whisper.body, /用件は納品物が動かない/);
        assert.match(whisper.body, /今すぐ対応できる場合は1を押してください/);
        assert.match(whisper.body, /今は対応できない場合は2を押してください/);
        assert.match(whisper.body, /留守番電話/);
        assert.match(whisper.body, new RegExp(`action="${PUBLIC_BASE}/handoff/whisper-confirm\\?call_sid=${CALL_SID}"`));

        const confirm = await post(harness.app, `/handoff/whisper-confirm?call_sid=${CALL_SID}`, { Digits: '1' });
        assert.match(confirm.body, /接続します/);
        assert.doesNotMatch(confirm.body, /Hangup/);

        const dial = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, {
            DialCallStatus: 'completed',
            From: CALLER
        });
        assert.match(dial.body, /<Hangup \/>/);
        assert.doesNotMatch(dial.body, /<Record/);
        assert.doesNotMatch(dial.body, /media-stream/);

        const context = await harness.contextStore.get(CALL_SID);
        assert.equal(context.status, 'connected');
        assert.equal(harness.emails.length, 0, 'a connected transfer needs no voicemail email');
    });
});

describe('human gate: recipient cannot take the call -> voicemail', () => {
    let harness;
    beforeEach(async () => { harness = await buildHarness(); });
    afterEach(async () => { await harness.app.close(); });

    it('digit 2 announces voicemail and the caller is recorded instead of returned to the AI', async () => {
        await post(harness.app, `/handoff/whisper?call_sid=${CALL_SID}`);
        const confirm = await post(harness.app, `/handoff/whisper-confirm?call_sid=${CALL_SID}`, { Digits: '2' });
        assert.match(confirm.body, /留守番電話へご案内します/);
        assert.match(confirm.body, /Hangup/);

        const dial = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, {
            DialCallStatus: 'completed',
            From: CALLER
        });
        assert.match(dial.body, /<Record /);
        assert.match(dial.body, /maxLength="120"/);
        assert.match(dial.body, /finishOnKey="#"/);
        assert.match(dial.body, /recordingStatusCallback="[^"]*\/handoff\/recording-status\?call_sid=CA/);
        assert.match(dial.body, /#rc=2&amp;rp=ct,rt,5xx/);
        assert.match(dial.body, /ピーという音のあとに/);
        assert.doesNotMatch(dial.body, /media-stream/);

        const context = await harness.contextStore.get(CALL_SID);
        assert.equal(context.status, 'voicemail_started');
        assert.equal(context.callerNumber, CALLER);
    });

    it('no digit pressed (carrier voicemail or hang-up) still ends in the caller voicemail', async () => {
        await post(harness.app, `/handoff/whisper?call_sid=${CALL_SID}`);
        const dial = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, {
            DialCallStatus: 'completed',
            From: CALLER
        });
        assert.match(dial.body, /<Record /);
        assert.equal((await harness.contextStore.get(CALL_SID)).whisperAccepted, undefined);
    });

    for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
        it(`Dial status ${status} goes to voicemail`, async () => {
            const dial = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, {
                DialCallStatus: status,
                From: CALLER
            });
            assert.match(dial.body, /<Record /);
            assert.doesNotMatch(dial.body, /media-stream/);
        });
    }

    it('a completed dial without the explicit whisper acceptance is never treated as connected', async () => {
        await harness.contextStore.update(CALL_SID, { status: 'whisper_started' });
        const dial = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'completed', From: CALLER });
        assert.match(dial.body, /<Record /);
    });
});

describe('voicemail delivery by email', () => {
    let harness;
    beforeEach(async () => {
        harness = await buildHarness();
        await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer', From: CALLER });
    });
    afterEach(async () => { await harness.app.close(); });

    it('sends one email with transcript, caller number, AI summary and a login-gated recording link', async () => {
        const response = await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, {
            RecordingStatus: 'completed',
            RecordingSid: RECORDING_SID,
            RecordingUrl: RECORDING_URL,
            RecordingDuration: '23',
            AccountSid: ACCOUNT_SID,
            CallSid: CALL_SID
        });
        assert.equal(response.statusCode, 204);
        assert.equal(harness.emails.length, 1);

        const [mail] = harness.emails;
        assert.deepEqual(mail.to, ['ops@example.test']);
        assert.deepEqual(mail.cc, ['team@example.test'], 'the retired recipient must never receive mail');
        assert.match(mail.subject, /留守電あり（要折り返し）/);
        assert.match(mail.text, /来週の打ち合わせの日程を変更したいです/);
        assert.match(mail.text, /発信者番号（Twilio）: \+819011112222/);
        assert.match(mail.text, /留守番電話の長さ: 23秒/);
        assert.match(mail.text, /用件は納品物が動かない/);
        assert.match(mail.text, new RegExp(`${PUBLIC_BASE}/api/admin/voicemails/${RECORDING_SID}\\?call_sid=${CALL_SID}`));

        const context = await harness.contextStore.get(CALL_SID);
        assert.equal(context.status, 'voicemail_recorded');
        assert.equal(context.voicemailTranscribed, true);

        const recordingFetch = harness.upstream.find((item) => item.url === `${RECORDING_URL}.mp3`);
        assert.match(recordingFetch.options.headers.Authorization, /^Basic /);
    });

    it('a Twilio retry of the same recording does not send a second email', async () => {
        const fields = {
            RecordingStatus: 'completed',
            RecordingSid: RECORDING_SID,
            RecordingUrl: RECORDING_URL,
            RecordingDuration: '5'
        };
        await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, fields);
        await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, fields);
        assert.equal(harness.emails.length, 1);
    });

    it('rejects a recording reference that does not point at the Twilio API', async () => {
        const response = await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, {
            RecordingStatus: 'completed',
            RecordingSid: RECORDING_SID,
            RecordingUrl: 'https://evil.example.test/steal',
            RecordingDuration: '5'
        });
        assert.equal(response.statusCode, 400);
        assert.equal(harness.emails.length, 0);
        assert.equal(harness.upstream.some((item) => item.url.includes('evil.example.test')), false);
    });

    it('ignores non-completed recording events', async () => {
        const response = await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, {
            RecordingStatus: 'in-progress',
            RecordingSid: RECORDING_SID,
            RecordingUrl: RECORDING_URL
        });
        assert.equal(response.statusCode, 204);
        assert.equal(harness.emails.length, 0);
    });

    it('voicemail-complete thanks the caller and stays silent when a recording exists', async () => {
        const response = await post(harness.app, `/handoff/voicemail-complete?call_sid=${CALL_SID}`, { RecordingDuration: '12' });
        assert.match(response.body, /ありがとうございました/);
        assert.match(response.body, /Hangup/);
        assert.equal(harness.emails.length, 0);
    });

    it('uses the final absent callback for silent recordings even when the action duration is positive', async () => {
        const response = await post(harness.app, `/handoff/voicemail-complete?call_sid=${CALL_SID}`, { RecordingDuration: '5' });
        assert.match(response.body, /Hangup/);
        assert.equal(harness.emails.length, 0);
        const fields = { RecordingStatus: 'absent', RecordingSid: RECORDING_SID, CallSid: CALL_SID };
        assert.equal((await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, fields)).statusCode, 204);
        await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, fields);
        assert.equal(harness.emails.length, 1);
        assert.match(harness.emails[0].subject, /転送不成立・留守電なし/);
        assert.match(harness.emails[0].text, /\+819011112222/);
    });
});

describe('voicemail callback acceptance across retries', () => {
    const fields = { RecordingStatus: 'completed', RecordingSid: RECORDING_SID, RecordingUrl: RECORDING_URL, RecordingDuration: '9' };
    const path = `/handoff/recording-status?call_sid=${CALL_SID}`;

    it('retries failed mail delivery instead of acknowledging a permanently lost notification', async () => {
        const harness = await buildHarness({ emailStatuses: [503, 200] });
        try {
            assert.equal((await post(harness.app, path, fields)).statusCode, 503);
            assert.notEqual((await harness.contextStore.get(CALL_SID)).voicemailNotified, true);
            assert.equal((await post(harness.app, path, fields)).statusCode, 204);
            assert.equal((await harness.contextStore.get(CALL_SID)).voicemailNotified, true);
            await post(harness.app, path, fields);
            assert.equal(harness.emails.length, 2, 'one failed attempt and one accepted delivery');
        } finally { await harness.app.close(); }
    });

    it('persists the recording reference before email delivery so its playback link already works', async () => {
        const harness = await buildHarness({ beforeEmail: async (store) => {
            const context = await store.get(CALL_SID);
            assert.equal(context.voicemailRecordingSid, RECORDING_SID);
            assert.equal(context.voicemailRecordingUrl, RECORDING_URL);
        } });
        try {
            assert.equal((await post(harness.app, path, fields)).statusCode, 204);
            assert.equal(harness.emails.length, 1);
            assert.equal(harness.outcomes.at(-1).status, 'voicemail_recorded');
            assert.equal(harness.outcomes.at(-1).voicemailNotified, true);
        } finally { await harness.app.close(); }
    });

    it('concurrent recording callbacks deliver one message', async () => {
        const harness = await buildHarness({ beforeEmail: async () => new Promise((resolve) => setTimeout(resolve, 20)) });
        try {
            const responses = await Promise.all([post(harness.app, path, fields), post(harness.app, path, fields)]);
            assert.ok(responses.every((response) => [204, 503].includes(response.statusCode)));
            assert.equal(harness.emails.length, 1);
            assert.equal((await harness.contextStore.get(CALL_SID)).voicemailNotified, true);
        } finally { await harness.app.close(); }
    });

    it('does not claim callback success or send mail when shared context cannot be read', async () => {
        const harness = await buildHarness();
        harness.contextStore.get = async () => { throw new Error('store unavailable'); };
        try {
            assert.equal((await post(harness.app, path, fields)).statusCode, 503);
            assert.equal(harness.emails.length, 0);
        } finally { await harness.app.close(); }
    });

    it('does not deliver a broken playback link when recording metadata cannot be saved', async () => {
        const harness = await buildHarness();
        harness.contextStore.update = async () => { throw new Error('store unavailable'); };
        try {
            assert.equal((await post(harness.app, path, fields)).statusCode, 503);
            assert.equal(harness.emails.length, 0);
        } finally { await harness.app.close(); }
    });

    it('ignores action duration zero until the terminal callback confirms whether audio exists', async () => {
        const harness = await buildHarness();
        try {
            await post(harness.app, `/handoff/voicemail-complete?call_sid=${CALL_SID}`, { RecordingDuration: '0' });
            await post(harness.app, path, fields);
            assert.equal(harness.emails.length, 1);
            assert.match(harness.emails[0].subject, /留守電あり/);
        } finally { await harness.app.close(); }
    });

    it('a delayed dial callback cannot start another recording after voicemail has been delivered', async () => {
        const harness = await buildHarness();
        try {
            await post(harness.app, path, fields);
            const delayed = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer' });
            assert.match(delayed.body, /Hangup/);
            assert.doesNotMatch(delayed.body, /<Record/);
            assert.equal((await harness.contextStore.get(CALL_SID)).status, 'voicemail_recorded');
            assert.equal(harness.emails.length, 1);
        } finally { await harness.app.close(); }
    });

    it('uses the atomic update result when a dial callback read is stale', async () => {
        const harness = await buildHarness();
        try {
            await harness.contextStore.update(CALL_SID, { status: 'voicemail_recorded', voicemailNotified: true });
            const get = harness.contextStore.get.bind(harness.contextStore);
            let stale = true;
            harness.contextStore.get = async (callSid) => {
                if (stale) { stale = false; return { status: 'requested' }; }
                return get(callSid);
            };
            const response = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer' });
            assert.match(response.body, /Hangup/);
            assert.doesNotMatch(response.body, /<Record/);
            assert.equal((await get(CALL_SID)).status, 'voicemail_recorded');
        } finally { await harness.app.close(); }
    });
});

describe('voicemail delivery degrades without losing the message', () => {
    it('sends the email with the recording link when transcription fails', async () => {
        const harness = await buildHarness({ transcriptionStatus: 500 });
        await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer', From: CALLER });
        await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, {
            RecordingStatus: 'completed', RecordingSid: RECORDING_SID, RecordingUrl: RECORDING_URL, RecordingDuration: '9'
        });
        assert.equal(harness.emails.length, 1);
        assert.match(harness.emails[0].text, /文字起こしを取得できませんでした: transcription_http_500/);
        assert.match(harness.emails[0].text, /api\/admin\/voicemails/);
        assert.equal((await harness.contextStore.get(CALL_SID)).voicemailTranscribed, false);
        await harness.app.close();
    });

    it('sends the email even when the recording cannot be downloaded', async () => {
        const harness = await buildHarness({ recordingStatus: 404 });
        await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer', From: CALLER });
        await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, {
            RecordingStatus: 'completed', RecordingSid: RECORDING_SID, RecordingUrl: RECORDING_URL, RecordingDuration: '9'
        });
        assert.equal(harness.emails.length, 1);
        assert.match(harness.emails[0].text, /recording_http_404/);
        await harness.app.close();
    });

    it('skips transcription entirely when VOICEMAIL_TRANSCRIBE_ENABLED=false', async () => {
        const harness = await buildHarness({ configOverrides: { VOICEMAIL_TRANSCRIBE_ENABLED: 'false' } });
        await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer', From: CALLER });
        await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, {
            RecordingStatus: 'completed', RecordingSid: RECORDING_SID, RecordingUrl: RECORDING_URL, RecordingDuration: '9'
        });
        assert.equal(harness.upstream.some((item) => item.url.includes('audio/transcriptions')), false);
        assert.equal(harness.emails.length, 1);
        await harness.app.close();
    });
});

describe('AI whisper summary', () => {
    it('waits briefly for a pending AI summary and speaks it', async () => {
        const harness = await buildHarness({ contextSeed: { summaryStatus: 'pending' } });
        setTimeout(() => {
            void harness.contextStore.update(CALL_SID, {
                whisperSummary: '納品済みの画面が動かず、至急の確認を求めています',
                summarySource: 'ai',
                summaryStatus: 'ready'
            });
        }, 20);
        const whisper = await post(harness.app, `/handoff/whisper?call_sid=${CALL_SID}`);
        assert.match(whisper.body, /納品済みの画面が動かず、至急の確認を求めています/);
        assert.doesNotMatch(whisper.body, /用件は納品物/);
        await harness.app.close();
    });

    it('falls back to the heuristic summary when the AI summary does not arrive in time', async () => {
        const harness = await buildHarness({ contextSeed: { summaryStatus: 'pending' } });
        const whisper = await post(harness.app, `/handoff/whisper?call_sid=${CALL_SID}`);
        assert.match(whisper.body, /用件は納品物が動かない/);
        await harness.app.close();
    });

    it('still prompts the recipient when the context store is unavailable', async () => {
        const harness = await buildHarness();
        harness.contextStore.get = async () => { throw new Error('firestore down'); };
        const whisper = await post(harness.app, `/handoff/whisper?call_sid=${CALL_SID}`);
        assert.equal(whisper.statusCode, 200);
        assert.match(whisper.body, /受付内容の確認/);
        assert.match(whisper.body, /今すぐ対応できる場合は1/);
        await harness.app.close();
    });
});

describe('rollback mode and access control', () => {
    it('HANDOFF_FALLBACK_MODE=ai_reception returns the caller to the AI intake and keeps the old prompts', async () => {
        const harness = await buildHarness({ configOverrides: { HANDOFF_FALLBACK_MODE: 'ai_reception' } });
        const whisper = await post(harness.app, `/handoff/whisper?call_sid=${CALL_SID}`);
        assert.match(whisper.body, /コールセンターに戻す場合は2/);
        const dial = await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer', From: CALLER });
        assert.match(dial.body, /handoff_fallback/);
        assert.match(dial.body, /media-stream\/stream-token-for-test/);
        assert.doesNotMatch(dial.body, /<Record/);
        assert.equal(harness.emails.length, 1);
        assert.match(harness.emails[0].subject, /担当者不応答/);
        await harness.app.close();
    });

    it('returns 404 when the handoff is disabled and 403 for an invalid Twilio signature', async () => {
        const disabled = await buildHarness({ configOverrides: { HANDOFF_ENABLED: 'false' } });
        assert.equal((await post(disabled.app, `/handoff/whisper?call_sid=${CALL_SID}`)).statusCode, 404);
        assert.equal((await post(disabled.app, `/handoff/recording-status?call_sid=${CALL_SID}`)).statusCode, 404);
        await disabled.app.close();

        const forged = await buildHarness({ signatureValid: false });
        for (const path of ['whisper', 'whisper-confirm', 'leg-status', 'dial-status', 'voicemail-complete', 'recording-status']) {
            const response = await post(forged.app, `/handoff/${path}?call_sid=${CALL_SID}`, { Digits: '1' });
            assert.equal(response.statusCode, 403, path);
        }
        assert.equal(forged.emails.length, 0);
        await forged.app.close();
    });

    it('a notification failure never breaks the caller flow', async () => {
        const failing = await buildHarness({ notifyTo: '' });
        await post(failing.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer', From: CALLER });
        const response = await post(failing.app, `/handoff/voicemail-complete?call_sid=${CALL_SID}`, { RecordingDuration: '0' });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /Hangup/);
        assert.equal(failing.emails.length, 0);
        await failing.app.close();
    });
});

describe('admin voicemail playback', () => {
    let harness;
    beforeEach(async () => {
        harness = await buildHarness();
        await post(harness.app, `/handoff/dial-status?call_sid=${CALL_SID}`, { DialCallStatus: 'no-answer', From: CALLER });
        await post(harness.app, `/handoff/recording-status?call_sid=${CALL_SID}`, {
            RecordingStatus: 'completed', RecordingSid: RECORDING_SID, RecordingUrl: RECORDING_URL, RecordingDuration: '9'
        });
    });
    afterEach(async () => { await harness.app.close(); });

    const get = (headers = {}, sid = RECORDING_SID, callSid = CALL_SID) => harness.app.inject({
        method: 'GET',
        url: `/api/admin/voicemails/${sid}?call_sid=${callSid}`,
        headers
    });

    it('requires admin authentication', async () => {
        assert.equal((await get()).statusCode, 401);
    });

    it('streams the recording to an authenticated admin only for the matching call', async () => {
        const ok = await get({ authorization: 'Basic admin-ok' });
        assert.equal(ok.statusCode, 200);
        assert.equal(ok.headers['content-type'], 'audio/mpeg');
        assert.equal(ok.headers['cache-control'], 'private, no-store');
        assert.equal(ok.rawPayload.toString(), 'fake-mp3-bytes');

        const otherRecording = await get({ authorization: 'Basic admin-ok' }, `RE${'d'.repeat(32)}`);
        assert.equal(otherRecording.statusCode, 404);
        const malformed = await get({ authorization: 'Basic admin-ok' }, 'not-a-sid');
        assert.equal(malformed.statusCode, 400);
        assert.ok(harness.audit.some((entry) => entry.event === 'admin.voicemail.accessed' && entry.result === 'success'));
    });
});
