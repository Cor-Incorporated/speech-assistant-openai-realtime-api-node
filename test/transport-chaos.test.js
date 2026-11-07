// Exercise the actual Media Streams route; all provider traffic stays on localhost.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createStreamToken } from '../lib/stream-auth.js';

const INDEX_PATH = fileURLToPath(new URL('../index.js', import.meta.url));
const AUTH_TOKEN = 'transport-chaos-synthetic-secret';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await sleep(20);
    }
    return null;
};
let callCounter = 0;

async function createHarness(mode, { openingAudio = true, fallback = false, startTimeoutMs = 1000, delayedKnowledge = false } = {}) {
    const connections = [];
    const clients = [];
    let rejectNext = false;
    let log = '';
    const provider = new WebSocketServer({
        port: 0,
        host: '127.0.0.1',
        verifyClient: (_info, done) => {
            const reject = rejectNext;
            rejectNext = false;
            done(!reject, 429, 'synthetic rate limit');
        }
    });
    await once(provider, 'listening');
    provider.on('connection', (socket) => {
        const connection = { socket, messages: [] };
        connections.push(connection);
        socket.on('message', (raw) => {
            const event = JSON.parse(raw.toString());
            connection.messages.push(event);
            if (event.type === 'session.start') {
                socket.send(JSON.stringify({ type: 'session.started', session: { id: 'synthetic' } }));
                if (openingAudio) socket.send(JSON.stringify({
                    type: 'session.output_audio.delta', delta: Buffer.alloc(160, 0x55).toString('base64')
                }));
            } else if (event.type === 'session.update') {
                socket.send(JSON.stringify({ type: 'session.updated', session: event.session }));
            } else if (event.type === 'session.close' && !connection.holdClose) {
                socket.send(JSON.stringify({ type: 'session.closed', usage: { total_tokens: 0 } }));
            }
        });
    });
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const server = spawn(process.execPath, [
        ...(delayedKnowledge ? ['--import', fileURLToPath(new URL('./helpers/delayed-knowledge.mjs', import.meta.url))] : []),
        INDEX_PATH
    ], {
        // A separate cwd prevents dotenv from reading real credentials.
        cwd: tmpdir(),
        env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            PORT: String(port),
            OPENAI_API_KEY: 'synthetic-key',
            TWILIO_AUTH_TOKEN: AUTH_TOKEN,
            TWILIO_STREAM_AUTH_ENABLED: 'true',
            VOICE_PROVIDER: mode,
            OPENAI_LIVE_WS_URL: `ws://127.0.0.1:${provider.address().port}`,
            OPENAI_REALTIME_WS_URL: `ws://127.0.0.1:${provider.address().port}`,
            LIVE_FALLBACK_TO_REALTIME: String(fallback),
            LIVE_START_TIMEOUT_MS: String(startTimeoutMs),
            LIVE_TOOL_WATCHDOG_MS: '2000',
            LIVE_CLOSE_DRAIN_MS: '150',
            LIVE_USER_TURN_GAP_MS: '100',
            CALL_GATE_REQUIRED: 'false',
            LOG_REALTIME_EVENTS: 'true',
            CALL_LOG_FIRESTORE_ENABLED: 'false',
            CALL_LOG_SHEETS_ENABLED: 'false',
            NOTIFY_EMAIL_ENABLED: 'false',
            EXTRACTION_ENABLED: 'false',
            CALL_END_HANGUP_ENABLED: 'false',
            HANDOFF_ENABLED: 'false',
            ADMIN_BASIC_USER: 'chaos',
            ADMIN_BASIC_PASSWORD: 'synthetic-only'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (data) => { log += data; });
    server.stderr.on('data', (data) => { log += data; });
    assert.ok(await waitFor(() => log.includes('Server is listening'), 15000), log);

    return {
        get log() { return log; },
        get providerConnectionCount() { return connections.length; },
        get providerConnections() { return connections; },
        rejectNextConnection() { rejectNext = true; },
        async connectUnauthenticated() {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
            clients.push(socket);
            await once(socket, 'open');
            return socket;
        },
        async connect({ rejected = false, deferred = false, callSid = `CA${String(++callCounter).padStart(32, '0')}`, customParameters = {} } = {}) {
            const token = createStreamToken({ callSid, secret: AUTH_TOKEN });
            const count = connections.length;
            const socket = new WebSocket(`ws://127.0.0.1:${port}/media-stream${deferred ? '' : `/${encodeURIComponent(token)}`}`);
            clients.push(socket);
            const call = { socket, callSid, provider: null, close: null };
            socket.on('close', (code, reason) => { call.close = { code, reason: reason.toString() }; });
            await once(socket, 'open');
            socket.send(JSON.stringify({
                event: 'start',
                start: {
                    callSid, streamSid: 'MZ' + '1'.repeat(32),
                    customParameters: { ...customParameters, ...(deferred ? { stream_token: token } : {}) }
                }
            }));
            if (!rejected) {
                call.provider = await waitFor(() => {
                    const conn = connections[count];
                    return conn?.messages.some((event) => event.type === (mode === 'live' ? 'session.start' : 'session.update')) && conn;
                });
                assert.ok(call.provider, 'local provider never received session initialization');
            }
            return call;
        },
        async readCall(callSid) {
            const response = await fetch(`http://127.0.0.1:${port}/api/admin/v2/calls/${callSid}`, {
                headers: { authorization: `Basic ${Buffer.from('chaos:synthetic-only').toString('base64')}` }
            });
            return response.ok ? (await response.json()).call : null;
        },
        async stop() {
            for (const client of clients) client.terminate();
            server.kill('SIGKILL');
            await once(server, 'exit');
            for (const conn of connections) conn.socket.terminate();
            await new Promise((resolve) => provider.close(resolve));
        }
    };
}

function injectDelegation(connection, suffix) {
    const delegationId = `delegation_${suffix}`;
    for (const event of [
        { type: 'session.delegation.created', delegation: { id: delegationId, target: 'responses' } },
        {
            type: 'response.event', delegation_id: delegationId,
            event: {
                type: 'response.output_item.done',
                item: { type: 'function_call', call_id: `tool_${suffix}`, name: 'lookup_company_knowledge', arguments: '{"query":"営業時間"}' }
            }
        },
        {
            type: 'response.event', delegation_id: delegationId,
            event: { type: 'response.completed', response: { id: `response_${suffix}`, status: 'completed' } }
        }
    ]) connection.socket.send(JSON.stringify(event));
}

for (const mode of ['realtime', 'live']) describe(`${mode} transport chaos`, () => {
    let harness;
    before(async () => { harness = await createHarness(mode); });
    after(async () => { await harness?.stop(); });

    it('ends and records a failed call after the provider disconnects', async () => {
        const call = await harness.connect();
        call.provider.socket.terminate();
        assert.ok(await waitFor(() => call.close), 'caller remains connected to a dead provider');
        const record = await waitFor(async () => {
            const value = await harness.readCall(call.callSid);
            return value?.transportState === 'failed' && value;
        });
        assert.ok(record, 'provider failure must not be projected as a normal ended call');
    });

    it('rejects duplicate call ownership before provider work and permits an AI fallback after close', async () => {
        const first = await harness.connect();
        const before = harness.providerConnectionCount;
        for (const deferred of [false, true]) {
            const duplicate = await harness.connect({ callSid: first.callSid, deferred, rejected: true });
            assert.ok(await waitFor(() => duplicate.close));
            assert.equal(duplicate.close.code, 4409);
            assert.equal(harness.providerConnectionCount, before);
            assert.equal(first.socket.readyState, WebSocket.OPEN);
            assert.equal((await harness.readCall(first.callSid)).transportState, 'connected');
        }
        // Hold Live drain open until its deadline so the old cleanup finishes
        // after the fallback has already claimed the same call.
        if (mode === 'live') first.provider.holdClose = true;
        first.socket.close();
        assert.ok(await waitFor(() => first.close));
        const fallback = await harness.connect({ callSid: first.callSid, customParameters: { handoff_fallback: 'true' } });
        assert.ok(fallback.provider);
        // The old connection's delayed cleanup must not release the new claim.
        await sleep(250);
        const duplicate = await harness.connect({ callSid: first.callSid, rejected: true });
        assert.ok(await waitFor(() => duplicate.close));
        assert.equal(duplicate.close.code, 4409);
        assert.equal(fallback.socket.readyState, WebSocket.OPEN);
        fallback.socket.close();
    });

    it('ends after an HTTP 429 provider handshake rejection', async () => {
        harness.rejectNextConnection();
        const call = await harness.connect({ rejected: true });
        assert.ok(await waitFor(() => call.close), 'provider rejection leaves caller in indefinite silence');
    });

    it('bounds server-error silence while preserving request errors and audible recovery', async () => {
        const call = await harness.connect();
        const recovered = await harness.connect();
        call.provider.socket.send(JSON.stringify({
            type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'no active response' }
        }));
        await sleep(100);
        assert.equal(call.socket.readyState, WebSocket.OPEN);
        recovered.provider.socket.send(JSON.stringify({
            type: 'error', error: { type: 'server_error', message: 'temporary failure' }
        }));
        recovered.provider.socket.send(JSON.stringify({
            type: mode === 'live' ? 'session.output_audio.delta' : 'response.output_audio.delta',
            delta: Buffer.alloc(160, 0x55).toString('base64')
        }));
        call.provider.socket.send(JSON.stringify({
            type: 'error', error: { type: 'server_error', code: 'server_error', message: 'synthetic fatal failure' }
        }));
        call.provider.socket.send(JSON.stringify({
            type: mode === 'live' ? 'session.output_audio.delta' : 'response.output_audio.delta',
            delta: Buffer.alloc(160, 0xff).toString('base64')
        }));
        assert.ok(await waitFor(() => call.close), 'fatal provider error leaves caller in indefinite silence');
        assert.equal(recovered.socket.readyState, WebSocket.OPEN, 'audible provider recovery must preserve the call');
        recovered.socket.close();
    });

    it('finalizes a stop frame once and rejects late media without waiting for a socket close', async () => {
        const call = await harness.connect();
        const receivedBefore = call.provider.messages.length;
        for (const event of [
            { event: 'stop', stop: { callSid: call.callSid } },
            { event: 'stop', stop: { callSid: call.callSid } },
            { event: 'media', media: { payload: Buffer.alloc(160, 0xff).toString('base64') } }
        ]) call.socket.send(JSON.stringify(event));
        assert.ok(await waitFor(() => call.close), 'stop frame never finalized the stream');
        assert.ok(await waitFor(async () => (await harness.readCall(call.callSid))?.transportState === 'ended'));
        assert.equal(harness.log.split('\n').filter((line) => line.includes('"action":"call.completed"') && line.includes(call.callSid)).length, 1);
        const afterStop = call.provider.messages.slice(receivedBefore);
        assert.equal(afterStop.filter((event) => event.type.includes('audio') && event.type.endsWith('append')).length, 0);
        if (mode === 'live') assert.equal(afterStop.filter((event) => event.type === 'session.close').length, 1);
    });

    if (mode === 'live') {
        it('rejects an oversized unauthenticated frame before opening a provider session', async () => {
            const count = harness.providerConnectionCount;
            const socket = await harness.connectUnauthenticated();
            const closed = once(socket, 'close');
            socket.send(JSON.stringify({ event: 'connected', padding: 'x'.repeat(64 * 1024) }));
            const [code] = await closed;
            assert.equal(code, 1009);
            assert.equal(harness.providerConnectionCount, count);
        });

        it('ends when the provider declares its session closed but leaves its socket open', async () => {
            const call = await harness.connect();
            call.provider.socket.send(JSON.stringify({ type: 'session.closed', usage: { total_tokens: 0 } }));
            assert.ok(await waitFor(() => call.close), 'closed provider session strands the caller');
        });

        it('keeps the tool watchdog for rejected noise while accepted caller speech resolves it', async () => {
            const noisy = await harness.connect();
            const speaking = await harness.connect();
            injectDelegation(noisy.provider, 'noisy');
            injectDelegation(speaking.provider, 'speaking');
            for (const call of [noisy, speaking]) {
                assert.ok(await waitFor(() => call.provider.messages.some((event) => event.type === 'response.create')));
            }
            noisy.provider.socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hi.' }));
            speaking.provider.socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: '確認できました。ありがとうございます。' }));
            assert.ok(await waitFor(() => harness.log.includes('insufficient_speech_signal')));
            assert.ok(await waitFor(() => noisy.close, 5500), 'rejected noise disabled the pending tool watchdog');
            assert.equal(speaking.socket.readyState, WebSocket.OPEN, 'accepted caller speech should resolve the previous tool exchange');
            assert.equal(speaking.provider.messages.filter((event) => event.type === 'session.instructions.append').length, 0);
            speaking.socket.close();
        });
    }
});


describe('Live opening audio', () => {
    let harness;
    before(async () => { harness = await createHarness('live', { openingAudio: false, fallback: true }); });
    after(async () => { await harness?.stop(); });

    it('seeds and requests the same greeting once, then preserves a voiced opening', async () => {
        const call = await harness.connect();
        const start = call.provider.messages.find((event) => event.type === 'session.start');
        const greeting = start.session.input?.[0];
        assert.equal(greeting?.role, 'developer');
        assert.equal(greeting?.content?.[0]?.type, 'input_text');
        assert.match(greeting.content[0].text, /日本語/);
        assert.match(greeting.content[0].text, /コー株式会社/);
        assert.ok(await waitFor(() => call.provider.messages.some((event) => event.type === 'session.commentary.append')));
        const commentary = call.provider.messages.find((event) => event.type === 'session.commentary.append');
        assert.equal(commentary.content, greeting.content[0].text);
        assert.equal(commentary.delegation_id, null);
        assert.ok(commentary.event_id);
        call.provider.socket.send(JSON.stringify({ type: 'session.started', session: { id: 'duplicate' } }));
        call.provider.socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(160, 0x55).toString('base64') }));
        const count = harness.providerConnectionCount;
        await sleep(1250);
        assert.equal(call.provider.messages.filter((event) => event.type === 'session.commentary.append').length, 1);
        assert.equal(harness.providerConnectionCount, count);
        assert.equal(call.socket.readyState, WebSocket.OPEN);
        call.socket.close();
    });

    it('bounds silence despite ACKs, transcript-only output and duplicate starts, and falls back once', async () => {
        const call = await harness.connect();
        const count = harness.providerConnectionCount;
        const timer = setInterval(() => {
            if (call.provider.socket.readyState !== WebSocket.OPEN) return;
            for (const event of [
                { type: 'session.started', session: { id: 'duplicate' } },
                { type: 'session.commentary.appended', client_event_id: 'greeting' },
                { type: 'session.output_transcript.delta', delta: 'お電話ありがとうございます。' },
                { type: 'session.output_audio.delta', delta: Buffer.alloc(160, 0xff).toString('base64') }
            ]) call.provider.socket.send(JSON.stringify(event));
        }, 100);
        try {
            assert.ok(await waitFor(() => harness.providerConnectionCount === count + 1, 2500), 'silent opening never left Live');
        } finally { clearInterval(timer); }
        const realtime = harness.providerConnections.at(-1);
        assert.ok(await waitFor(() => realtime.messages.some((event) => event.type === 'response.create')));
        assert.match(JSON.stringify(realtime.messages.find((event) => event.type === 'conversation.item.create')), /コー株式会社/);
        await sleep(1250);
        assert.equal(harness.providerConnectionCount, count + 1);
        assert.equal(call.socket.readyState, WebSocket.OPEN, 'old Live close must not close the replacement provider');
        call.socket.close();
    });

    it('discards an unvoiced terminal transcript before replacing Live', async () => {
        const call = await harness.connect();
        const messages = [];
        call.socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
        const count = harness.providerConnectionCount;
        call.provider.socket.send(JSON.stringify({
            type: 'session.output_transcript.delta',
            delta: 'このあとお電話をお切りいただいて大丈夫です。失礼いたします。'
        }));
        assert.ok(await waitFor(() => harness.providerConnectionCount === count + 1, 2500));
        await sleep(1700);
        assert.equal(messages.filter((event) => event.event === 'mark').length, 0, 'old terminal transcript reached the replacement');
        assert.equal(call.socket.readyState, WebSocket.OPEN);
        assert.equal((await harness.readCall(call.callSid)).transportState, 'connected');
        call.socket.close();
    });

    it('revokes an unvoiced terminal turn whose playback mark was already scheduled', async () => {
        const isolated = await createHarness('live', { openingAudio: false, fallback: true, startTimeoutMs: 1700 });
        try {
            const call = await isolated.connect();
            const messages = [];
            call.socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
            call.provider.socket.send(JSON.stringify({
                type: 'session.output_transcript.delta',
                delta: 'このあとお電話をお切りいただいて大丈夫です。失礼いたします。'
            }));
            assert.ok(await waitFor(() => isolated.providerConnectionCount === 2, 2500));
            await sleep(1700);
            assert.equal(messages.filter((event) => event.event === 'mark').length, 0, 'old scheduled mark reached the replacement');
            assert.equal(call.socket.readyState, WebSocket.OPEN);
        } finally { await isolated.stop(); }
    });

    it('discards the old Live server-error deadline before replacing it', async () => {
        const call = await harness.connect();
        const count = harness.providerConnectionCount;
        call.provider.socket.send(JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'synthetic startup error' } }));
        assert.ok(await waitFor(() => harness.providerConnectionCount === count + 1, 2500));
        await sleep(1250);
        assert.equal(call.socket.readyState, WebSocket.OPEN, 'old server-error deadline ended the replacement');
        call.socket.close();
    });

    it('discards delayed old-provider tool outputs and continuation after fallback', async () => {
        const isolated = await createHarness('live', { openingAudio: false, fallback: true, delayedKnowledge: true });
        try {
            const call = await isolated.connect();
            assert.ok(call.provider.messages[0].session.delegation.responses.tools.some((tool) => tool.name === 'lookup_company_knowledge'));
            injectDelegation(call.provider, 'startup_stale');
            assert.ok(await waitFor(() => isolated.providerConnectionCount === 2, 2500));
            const realtime = isolated.providerConnections.at(-1);
            await sleep(1000);
            assert.equal(realtime.messages.filter((event) => event.item?.type === 'function_call_output').length, 0);
            assert.equal(realtime.messages.filter((event) => event.type === 'response.create').length, 1);
            assert.equal(call.socket.readyState, WebSocket.OPEN);
        } finally { await isolated.stop(); }
    });

    it('preserves accepted caller speech before the greeting and rejects noise as progress', async () => {
        const speaking = await harness.connect();
        speaking.provider.socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: '営業時間を教えてください。' }));
        const noisy = await harness.connect();
        noisy.provider.socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hi.' }));
        const count = harness.providerConnectionCount;
        assert.ok(await waitFor(() => harness.providerConnectionCount === count + 1, 2500));
        assert.equal(speaking.provider.socket.readyState, WebSocket.OPEN);
        assert.equal(speaking.socket.readyState, WebSocket.OPEN);
        assert.equal(noisy.provider.socket.readyState, WebSocket.CLOSED);
        speaking.socket.close();
        noisy.socket.close();
    });

    it('preserves a caller still speaking across the opening deadline', async () => {
        const call = await harness.connect();
        const count = harness.providerConnectionCount;
        await sleep(650);
        const timer = setInterval(() => {
            call.provider.socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: '営業時間を教えてください。' }));
        }, 60);
        try { await sleep(750); } finally { clearInterval(timer); }
        assert.equal(harness.providerConnectionCount, count);
        assert.equal(call.socket.readyState, WebSocket.OPEN);
        call.socket.close();
    });

    it('does not start a replacement after stop or caller close', async () => {
        const stopped = await harness.connect();
        const disconnected = await harness.connect();
        const count = harness.providerConnectionCount;
        stopped.socket.send(JSON.stringify({ event: 'stop', stop: { callSid: stopped.callSid } }));
        disconnected.socket.close();
        assert.ok(await waitFor(() => stopped.close && disconnected.close));
        await sleep(1250);
        assert.equal(harness.providerConnectionCount, count);
    });

    it('records failure and ends a silent opening when fallback is disabled', async () => {
        const isolated = await createHarness('live', { openingAudio: false });
        try {
            const call = await isolated.connect();
            assert.ok(await waitFor(() => call.close, 2500), 'silent opening remains connected without fallback');
            assert.equal(call.close.code, 1011);
            assert.ok(await waitFor(async () => (await isolated.readCall(call.callSid))?.transportState === 'failed'));
            assert.equal(isolated.providerConnectionCount, 1);
            const resumed = await isolated.connect({ customParameters: { handoff_fallback: 'true' } });
            assert.ok(await waitFor(() => resumed.close, 2500), 'handoff fallback leg remains connected in silence');
            assert.equal(resumed.close.code, 1011);
            assert.ok(await waitFor(async () => (await isolated.readCall(resumed.callSid))?.transportState === 'failed'));

        } finally { await isolated.stop(); }
    });
});
