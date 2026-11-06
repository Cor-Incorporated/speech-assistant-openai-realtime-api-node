// E2Eシナリオ: 実際の index.js を起動し、GPT-Live を模したWebSocketスタブから
// 「至急」の通話を流して、人間ゲート全体を通しで検証する。
//
//   発信者の発話 -> 緊急の人間対応と判定 -> Twilio REST で転送TwiML更新
//   -> 担当者応答 whisper（AI要約 + 1/2 の選択） -> 接続 / 留守電 -> メール通知
//
// Twilio REST / OpenAI HTTP / Resend は --import プリロードでローカルスタブへ
// 向ける。Twilio署名検証は有効のまま、テスト側で署名を付けてwebhookを呼ぶ。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createStreamToken } from '../lib/stream-auth.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(CURRENT_DIR, '..', 'index.js');
const PRELOAD_PATH = join(CURRENT_DIR, 'helpers', 'fetch-redirect.mjs');
const AUTH_TOKEN = 'e2e-twilio-auth-token';
const ACCOUNT_SID = `AC${'e'.repeat(32)}`;
const RECORDING_SID = `RE${'f'.repeat(32)}`;
const HUMAN_NUMBER = '+810000000000';
const AI_SUMMARY = '株式会社テストから、納品済みの画面が動かないため、至急の確認を求めています。';
const VOICEMAIL_TEXT = '先ほどの件ですが、折り返しの電話をお願いします。';
const CALLER = '+819011112222';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 10000, intervalMs = 40) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(intervalMs);
    }
    return null;
};
const decodeXml = (value) => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');

class ThirdPartyStub {
    constructor() {
        this.twilioCallUpdates = [];
        this.summaryRequests = [];
        this.emails = [];
        this.recordingDownloads = [];
    }

    async start() {
        this.server = createServer((request, response) => {
            const chunks = [];
            request.on('data', (chunk) => chunks.push(chunk));
            request.on('end', () => {
                const body = Buffer.concat(chunks);
                const path = request.url;
                const json = (payload, status = 200) => {
                    response.writeHead(status, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(payload));
                };
                if (request.method === 'POST' && /^\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[a-f0-9]{32}\/Calls\/(CA[a-f0-9]{32})\.json$/.test(path)) {
                    const callSid = path.match(/Calls\/(CA[a-f0-9]{32})\.json/)[1];
                    this.twilioCallUpdates.push({ callSid, form: new URLSearchParams(body.toString()), authorization: request.headers.authorization });
                    return json({ sid: callSid });
                }
                if (request.method === 'POST' && path === '/api.openai.com/v1/responses') {
                    this.summaryRequests.push(JSON.parse(body.toString()));
                    return json({ output_text: AI_SUMMARY });
                }
                if (request.method === 'POST' && path === '/api.openai.com/v1/audio/transcriptions') {
                    return json({ text: VOICEMAIL_TEXT });
                }
                if (request.method === 'GET' && path.startsWith(`/api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}`)) {
                    this.recordingDownloads.push({ path, authorization: request.headers.authorization });
                    response.writeHead(200, { 'content-type': 'audio/mpeg' });
                    return response.end(Buffer.from('e2e-mp3'));
                }
                if (request.method === 'POST' && path === '/api.resend.com/emails') {
                    this.emails.push(JSON.parse(body.toString()));
                    return json({ id: `email_${this.emails.length}` });
                }
                response.writeHead(404);
                return response.end(`unexpected ${request.method} ${path}`);
            });
        });
        this.server.listen(0, '127.0.0.1');
        await once(this.server, 'listening');
        this.port = this.server.address().port;
    }

    async stop() {
        this.server.close();
        await once(this.server, 'close').catch(() => {});
    }
}

class LiveProviderStub {
    constructor() {
        this.connections = [];
    }

    async start() {
        this.wss = new WebSocketServer({ port: 0 });
        await once(this.wss, 'listening');
        this.port = this.wss.address().port;
        this.wss.on('connection', (socket) => {
            const conn = { socket, messages: [] };
            this.connections.push(conn);
            socket.on('message', (data) => {
                const event = JSON.parse(data.toString());
                conn.messages.push(event);
                if (event.type === 'session.start') {
                    socket.send(JSON.stringify({ type: 'session.started', session: { id: 'live_e2e' } }));
                }
                if (event.type === 'session.close') {
                    socket.send(JSON.stringify({ type: 'session.closed', usage: { total_tokens: 1 } }));
                }
            });
        });
    }

    async stop() {
        for (const conn of this.connections) conn.socket.close();
        this.wss.close();
        await once(this.wss, 'close').catch(() => {});
    }
}

describe('human gate end to end (real index.js, stubbed Twilio/OpenAI/Resend)', () => {
    let server;
    let serverPort;
    let publicBase;
    let serverLog = '';
    let stub;
    let provider;
    let callCounter = 0;

    before(async () => {
        stub = new ThirdPartyStub();
        await stub.start();
        provider = new LiveProviderStub();
        await provider.start();

        serverPort = 19900 + Math.floor(Math.random() * 90);
        publicBase = `http://127.0.0.1:${serverPort}`;
        server = spawn(process.execPath, ['--import', PRELOAD_PATH, INDEX_PATH], {
            env: {
                PATH: process.env.PATH,
                FETCH_STUB_URL: `http://127.0.0.1:${stub.port}`,
                PORT: String(serverPort),
                OPENAI_API_KEY: 'e2e-openai-key',
                TWILIO_AUTH_TOKEN: AUTH_TOKEN,
                TWILIO_STREAM_AUTH_ENABLED: 'true',
                TWILIO_SIGNATURE_VALIDATION_ENABLED: 'true',
                TWILIO_PUBLIC_BASE_URL: publicBase,
                TWILIO_WEBHOOK_URL: `${publicBase}/incoming-call`,
                VOICE_PROVIDER: 'live',
                OPENAI_LIVE_WS_URL: `ws://127.0.0.1:${provider.port}`,
                LIVE_USER_TURN_GAP_MS: '150',
                LIVE_CLOSE_DRAIN_MS: '500',
                LIVE_FALLBACK_TO_REALTIME: 'false',
                CALL_GATE_REQUIRED: 'false',
                CALL_LOG_FIRESTORE_ENABLED: 'false',
                CALL_LOG_SHEETS_ENABLED: 'false',
                EXTRACTION_ENABLED: 'false',
                CALL_END_HANGUP_ENABLED: 'false',
                HANDOFF_ENABLED: 'true',
                HANDOFF_NUMBERS: HUMAN_NUMBER,
                HANDOFF_SUMMARY_MODEL: 'summary-test-model',
                NOTIFY_EMAIL_ENABLED: 'true',
                RESEND_API_KEY: 'e2e-resend-key',
                NOTIFY_EMAIL_TO: 'ops@example.test',
                NOTIFY_EMAIL_CC: 'k.isayama@cor-jp.com,team@example.test',
                NOTIFY_EMAIL_FROM: 'noreply@example.test',
                ADMIN_BASIC_USER: 'admin',
                ADMIN_BASIC_PASSWORD: 'e2e-admin-password'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        server.stdout.on('data', (d) => { serverLog += d.toString(); });
        server.stderr.on('data', (d) => { serverLog += d.toString(); });
        await waitFor(() => serverLog.includes('listening'), 15000);
        assert.ok(serverLog.includes('listening'), `server did not start:\n${serverLog}`);
    });

    after(async () => {
        if (server && !server.killed) server.kill('SIGKILL');
        await stub.stop();
        await provider.stop();
    });

    const sign = (url, params) => crypto
        .createHmac('sha1', AUTH_TOKEN)
        .update(Buffer.from(Object.keys(params).sort().reduce((acc, key) => `${acc}${key}${params[key]}`, url), 'utf8'))
        .digest('base64');

    const webhook = async (pathAndQuery, params = {}, { signed = true } = {}) => {
        const headers = { 'content-type': 'application/x-www-form-urlencoded' };
        if (signed) headers['x-twilio-signature'] = sign(`${publicBase}${pathAndQuery}`, params);
        const response = await fetch(`${publicBase}${pathAndQuery}`, {
            method: 'POST',
            headers,
            body: new URLSearchParams(params)
        });
        return { status: response.status, body: await response.text() };
    };

    const injectToolCall = (conn, name, args) => {
        const suffix = `${Date.now()}`;
        const delegationId = `item_e2e_${suffix}`;
        const callId = `call_e2e_${suffix}`;
        conn.socket.send(JSON.stringify({
            type: 'session.delegation.created',
            delegation: { id: delegationId, type: 'delegation', response_id: `resp_${suffix}`, target: 'responses' }
        }));
        conn.socket.send(JSON.stringify({
            type: 'response.event',
            delegation_id: delegationId,
            event: {
                type: 'response.output_item.done',
                item: { id: `fc_${suffix}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: callId, name },
                output_index: 0
            }
        }));
        conn.socket.send(JSON.stringify({
            type: 'response.event',
            delegation_id: delegationId,
            event: { type: 'response.completed', response: { id: `resp_${suffix}`, status: 'completed' } }
        }));
    };

    // Plays a caller and returns the transfer TwiML the server pushed to Twilio.
    // `toolCall` models the delegated backend deciding to call transfer_to_human.
    const startUrgentCall = async (utterance, { toolCall = null } = {}) => {
        callCounter += 1;
        const callSid = `CA${String(callCounter).padStart(2, '0')}${'0'.repeat(30)}`;
        const token = createStreamToken({ callSid, secret: AUTH_TOKEN });
        const connIndex = provider.connections.length;
        const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/media-stream/${encodeURIComponent(token)}`);
        await once(socket, 'open');
        socket.send(JSON.stringify({
            event: 'start',
            sequenceNumber: '1',
            start: {
                streamSid: `MZ${'d'.repeat(32)}`,
                accountSid: ACCOUNT_SID,
                callSid,
                customParameters: { from: CALLER, to: '+815000000000' }
            },
            streamSid: `MZ${'d'.repeat(32)}`
        }));
        const conn = await waitFor(() => provider.connections[connIndex]);
        assert.ok(conn, 'provider never connected');
        assert.ok(await waitFor(() => conn.messages.some((m) => m.type === 'session.start')), 'no session.start');

        conn.socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: utterance, start_ms: 0, end_ms: 3000 }));
        if (toolCall) {
            await sleep(400);
            injectToolCall(conn, 'transfer_to_human', toolCall);
        }
        const update = await waitFor(() => stub.twilioCallUpdates.find((item) => item.callSid === callSid), 12000);
        assert.ok(update, `no Twilio transfer update.\n${serverLog.slice(-3000)}`);
        socket.close();
        return { callSid, twiml: update.form.get('Twiml'), update };
    };

    const urlsFromTwiml = (twiml) => ({
        number: twiml.match(/<Number[^>]*>([^<]+)<\/Number>/)[1],
        whisper: decodeXml(twiml.match(/<Number[^>]* url="([^"]+)"/)[1]),
        dialStatus: decodeXml(twiml.match(/<Dial[^>]* action="([^"]+)"/)[1])
    });
    const pathOf = (url) => { const parsed = new URL(url); return parsed.pathname + parsed.search; };
    const readCall = async (callSid) => {
        const response = await fetch(`${publicBase}/api/admin/v2/calls/${callSid}`, {
            headers: { authorization: `Basic ${Buffer.from('admin:e2e-admin-password').toString('base64')}` }
        });
        return response.ok ? (await response.json()).call : null;
    };
    const mailsFor = (callSid) => stub.emails.filter((mail) => mail.subject.includes(callSid));

    it('urgent caller -> transfer to the human number with an AI summary and signed webhooks', async () => {
        const { callSid, twiml, update } = await startUrgentCall('御社に納品してもらった画面が動かなくなったので、至急見てほしいです。');
        const pending = await waitFor(async () => {
            const call = await readCall(callSid);
            return call?.humanCase.state === 'connecting' ? call : null;
        });
        assert.equal(pending?.ops.status, 'needs_callback');
        assert.equal(mailsFor(callSid).length, 0, 'transfer initiation must not send a completed-call email');

        assert.equal(update.authorization, `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`);
        const urls = urlsFromTwiml(twiml);
        assert.equal(urls.number, HUMAN_NUMBER);
        assert.match(twiml, /answerOnBridge="true"/);
        assert.match(urls.whisper, new RegExp(`/handoff/whisper\\?call_sid=${callSid}$`));

        assert.ok(await waitFor(() => stub.summaryRequests.length > 0), 'AI summary was never requested');
        assert.equal(stub.summaryRequests.at(-1).model, 'summary-test-model');

        const unsigned = await webhook(pathOf(urls.whisper), {}, { signed: false });
        assert.equal(unsigned.status, 403, 'unsigned whisper must be refused');

        const whisper = await webhook(pathOf(urls.whisper), { CallSid: callSid });
        assert.equal(whisper.status, 200);
        assert.ok(whisper.body.includes(AI_SUMMARY), `whisper must speak the AI summary:\n${whisper.body}`);
        assert.match(whisper.body, /今すぐ対応できる場合は1を押してください/);

        const confirm = await webhook(pathOf(decodeXml(whisper.body.match(/action="([^"]+)"/)[1])), { CallSid: callSid, Digits: '1' });
        assert.match(confirm.body, /接続します/);
        const dial = await webhook(pathOf(urls.dialStatus), { CallSid: callSid, DialCallStatus: 'completed', From: CALLER });
        assert.match(dial.body, /<Hangup \/>/);
        assert.doesNotMatch(dial.body, /<Record/);
        assert.equal((await readCall(callSid)).humanCase.state, 'connected');
        assert.equal((await readCall(callSid)).ops.status, 'done');
        await webhook(pathOf(urls.dialStatus), { CallSid: callSid, DialCallStatus: 'completed', From: CALLER });
        assert.equal(mailsFor(callSid).length, 1, 'accepted transfer has exactly one final email even after retry');
    });

    it('urgent caller, recipient presses 2 -> caller goes to voicemail -> email with transcript, no retired recipient', async () => {
        const emailsBefore = stub.emails.length;
        const { callSid, twiml } = await startUrgentCall('至急、担当の方とお話ししたいです。システムが止まっています。');
        const urls = urlsFromTwiml(twiml);

        const whisper = await webhook(pathOf(urls.whisper), { CallSid: callSid });
        assert.match(whisper.body, /今は対応できない場合は2を押してください/);
        const confirm = await webhook(pathOf(decodeXml(whisper.body.match(/action="([^"]+)"/)[1])), { CallSid: callSid, Digits: '2' });
        assert.match(confirm.body, /留守番電話へご案内します/);

        const dial = await webhook(pathOf(urls.dialStatus), { CallSid: callSid, DialCallStatus: 'completed', From: CALLER });
        assert.match(dial.body, /<Record /);
        assert.doesNotMatch(dial.body, /media-stream/);
        const statusCallback = decodeXml(dial.body.match(/recordingStatusCallback="([^"]+)"/)[1]);
        assert.equal(statusCallback, `${publicBase}/handoff/recording-status?call_sid=${callSid}#rc=2&rp=ct,rt,5xx`);

        const recorded = await webhook(pathOf(statusCallback), {
            CallSid: callSid,
            AccountSid: ACCOUNT_SID,
            RecordingStatus: 'completed',
            RecordingSid: RECORDING_SID,
            RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}`,
            RecordingDuration: '14'
        });
        assert.equal(recorded.status, 204);

        const voicemailMail = await waitFor(() => stub.emails.slice(emailsBefore).find((mail) => mail.subject.includes('留守電あり')));
        assert.ok(voicemailMail, `no voicemail email.\n${JSON.stringify(stub.emails.map((m) => m.subject))}`);
        assert.deepEqual(voicemailMail.to, ['ops@example.test']);
        assert.deepEqual(voicemailMail.cc, ['team@example.test']);
        assert.ok(voicemailMail.text.includes(VOICEMAIL_TEXT));
        assert.ok(voicemailMail.text.includes(`発信者番号（Twilio）: ${CALLER}`));
        assert.ok(voicemailMail.text.includes(AI_SUMMARY));
        assert.equal(mailsFor(callSid).length, 1, 'one voicemail email replaces the premature stream-close summary');
        assert.equal((await readCall(callSid)).humanCase.state, 'unavailable');
        assert.equal((await readCall(callSid)).ops.status, 'needs_callback');
        assert.match(stub.recordingDownloads.at(-1).authorization, /^Basic /);

        for (const mail of stub.emails) {
            assert.ok(!JSON.stringify(mail).includes('isayama'), 'retired recipient leaked into an email');
        }

        const unauthenticated = await fetch(`${publicBase}/api/admin/voicemails/${RECORDING_SID}?call_sid=${callSid}`);
        assert.equal(unauthenticated.status, 401);
        const authenticated = await fetch(`${publicBase}/api/admin/voicemails/${RECORDING_SID}?call_sid=${callSid}`, {
            headers: { authorization: `Basic ${Buffer.from('admin:e2e-admin-password').toString('base64')}` }
        });
        assert.equal(authenticated.status, 200);
        assert.equal(await authenticated.text(), 'e2e-mp3');
    });

    it('recipient never answers (no-answer) -> voicemail instead of looping back to the AI', async () => {
        const { callSid, twiml } = await startUrgentCall('至急、責任者とお話ししたいです。');
        const urls = urlsFromTwiml(twiml);
        const dial = await webhook(pathOf(urls.dialStatus), { CallSid: callSid, DialCallStatus: 'no-answer', From: CALLER });
        assert.match(dial.body, /<Record /);
        assert.doesNotMatch(dial.body, /handoff_fallback/);
    });

    for (const scenario of [
        { name: 'a non-urgent development inquiry', utterance: '新しい予約システムの開発をお願いしたいのですが、見積もりをいただけますか。', destination: 'contract' },
        { name: 'a sales call', utterance: '弊社の新しい広告サービスをご紹介したくお電話しました。', destination: 'general' }
    ]) it(`${scenario.name} stays with AI even if the backend tries to transfer it`, async () => {
        callCounter += 1;
        const callSid = `CA${String(callCounter).padStart(2, '0')}${'0'.repeat(30)}`;
        const token = createStreamToken({ callSid, secret: AUTH_TOKEN });
        const connIndex = provider.connections.length;
        const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/media-stream/${encodeURIComponent(token)}`);
        await once(socket, 'open');
        socket.send(JSON.stringify({
            event: 'start',
            start: { streamSid: `MZ${'d'.repeat(32)}`, accountSid: ACCOUNT_SID, callSid, customParameters: { from: CALLER } },
            streamSid: `MZ${'d'.repeat(32)}`
        }));
        const conn = await waitFor(() => provider.connections[connIndex]);
        assert.ok(await waitFor(() => conn.messages.some((m) => m.type === 'session.start')));
        conn.socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: scenario.utterance, start_ms: 0, end_ms: 2000 }));
        await sleep(400);
        injectToolCall(conn, 'transfer_to_human', { reason: scenario.name, destination: scenario.destination });
        await sleep(1500);
        assert.equal(stub.twilioCallUpdates.some((item) => item.callSid === callSid), false);

        // The AI finishes the call on its own and the team is told by email.
        socket.close();
        const summaryMail = await waitFor(() => stub.emails.find((mail) => mail.subject.includes(callSid)), 12000);
        assert.ok(summaryMail, `no call-summary email.\n${JSON.stringify(stub.emails.map((m) => m.subject))}`);
        assert.match(summaryMail.subject, /^【電話受付】/);
        assert.deepEqual(summaryMail.to, ['ops@example.test']);
        assert.deepEqual(summaryMail.cc, ['team@example.test']);
        assert.ok(summaryMail.text.includes(`発信者番号（Twilio）: ${CALLER}`));
        assert.ok(!JSON.stringify(summaryMail).includes('isayama'));
        assert.equal(mailsFor(callSid).length, 1);
    });
});
