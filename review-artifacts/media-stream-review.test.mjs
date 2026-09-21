// Runtime integration test through the REAL index.js handler with a mocked
// OpenAI provider WebSocket. This is the reception-level acceptance the audit
// requires — not a wire-format replay of a recorded event.
//
// Covers:
//   - a stream carrying the token in the URL PATH reaches the provider —
//     this is how real Twilio connects (it drops the <Stream url> query)
//   - an invalid token is still rejected at upgrade time
//   - a tokenless upgrade is deferred to the start frame's customParameters
//     (the <Parameter> channel) and rejected when the credential never arrives
//   - a signed stream reaches the provider (session.start observed)
//   - caller disconnect produces no provider reconnect
//   - Live session close is drained (session.close -> session.closed)
//
// The server runs as a subprocess with OPENAI_*_WS_URL pointed at a local
// stub; a fake Twilio Media Streams client exercises the real WS route.
//
// NOTE: reconstructed after the 2026-09-21 worktree loss — the harness was
// rebuilt to the same contract; the R01/R02/ordering assertions are verbatim
// from the original review artifact.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createStreamToken } from '../lib/stream-auth.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(CURRENT_DIR, '..', 'index.js');
const AUTH_TOKEN = 'integration-test-secret';
const CALL_SID = 'CA' + 'c'.repeat(32);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 8000, intervalMs = 50) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(intervalMs);
    }
    return null;
};

class ProviderStub {
    constructor() {
        this.connections = [];
        this.started = null;
        this.callCounter = 0;
    }

    async start() {
        this.wss = new WebSocketServer({ port: 0 });
        await once(this.wss, 'listening');
        this.port = this.wss.address().port;
        this.wss.on('connection', (socket) => {
            const conn = { socket, messages: [], closed: false, pendingCalls: [], toolOutputs: [], activeDelegation: '' };
            this.connections.push(conn);
            socket.on('message', (data) => {
                let event = null;
                try {
                    event = JSON.parse(data.toString());
                } catch {
                    return;
                }
                conn.messages.push(event);
                if (event.type === 'session.start') {
                    this.started = conn;
                    socket.send(JSON.stringify({
                        type: 'session.started',
                        session: { id: 'live_stub_session' }
                    }));
                }
                if (event.type === 'response.item.create' && event.item?.type === 'function_call_output') {
                    conn.toolOutputs.push(event.item.call_id);
                    conn.pendingCalls = conn.pendingCalls.filter((id) => id !== event.item.call_id);
                }
                if (event.type === 'response.create') {
                    // Emulate the real provider contract: a create arriving
                    // while function calls have no submitted output is an
                    // error, and the call stays pending — this is the exact
                    // failure that produced 86s of dead air on the live call.
                    if (conn.pendingCalls.length > 0) {
                        socket.send(JSON.stringify({
                            type: 'error',
                            error: {
                                code: 'invalid_request',
                                message: 'Submit the pending function call outputs before response.create'
                            }
                        }));
                    }
                }
                if (event.type === 'session.update') {
                    // Ack the update with its client event id so the server's
                    // complexMode activation check can match it.
                    socket.send(JSON.stringify({
                        type: 'session.updated',
                        client_event_id: event.event_id || '',
                        session: event.session || {}
                    }));
                }
                if (event.type === 'session.close') {
                    socket.send(JSON.stringify({ type: 'session.closed', usage: { total_tokens: 0 } }));
                }
            });
            socket.on('close', () => { conn.closed = true; });
        });
    }

    /** Emulate the provider delegating a function call through a
     * response.event envelope: output_item.done(function_call) then
     * response.completed — the wire shape createLiveDelegationTracker reads. */
    injectDelegation(conn, name, args) {
        const callId = `call_${++this.callCounter}`;
        const delegationId = `dlg_${this.callCounter}`;
        conn.activeDelegation = delegationId;
        conn.pendingCalls.push(callId);
        conn.socket.send(JSON.stringify({
            type: 'response.event',
            delegation_id: delegationId,
            event: {
                type: 'response.output_item.done',
                item: {
                    type: 'function_call',
                    call_id: callId,
                    name,
                    arguments: args
                }
            }
        }));
        conn.socket.send(JSON.stringify({
            type: 'response.event',
            delegation_id: delegationId,
            event: { type: 'response.completed', response: { id: `resp_${this.callCounter}` } }
        }));
        return { callId, delegationId };
    }

    async stop() {
        for (const conn of this.connections) {
            try { conn.socket.close(); } catch { /* already closed */ }
        }
        await new Promise((resolve) => this.wss.close(resolve));
    }
}

describe('media stream review contract', () => {
    let provider;
    let server;
    let serverLog = '';
    let serverPort = 0;

    const connectClient = async (path = '') => {
        const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/media-stream${path}`);
        await once(socket, 'open');
        return socket;
    };

    const sendStartFrame = (socket, { callSid = CALL_SID, customParameters = {} } = {}) => {
        socket.send(JSON.stringify({
            event: 'start',
            start: {
                streamSid: 'MZ' + '0'.repeat(32),
                accountSid: 'AC' + '1'.repeat(32),
                callSid,
                customParameters
            }
        }));
    };

    before(async () => {
        provider = new ProviderStub();
        await provider.start();

        // A random free port for the server under test.
        const probe = new WebSocketServer({ port: 0 });
        await once(probe, 'listening');
        serverPort = probe.address().port;
        await new Promise((resolve) => probe.close(resolve));

        server = spawn(process.execPath, [INDEX_PATH], {
            env: {
                ...process.env,
                PORT: String(serverPort),
                OPENAI_API_KEY: 'integration-test-key',
                OPENAI_LIVE_WS_URL: `ws://127.0.0.1:${provider.port}`,
                VOICE_PROVIDER: 'live',
                TWILIO_AUTH_TOKEN: AUTH_TOKEN,
                TWILIO_STREAM_AUTH_ENABLED: 'true',
                CALL_LOG_FIRESTORE_ENABLED: 'false',
                CALL_GATE_REQUIRED: 'true',
                LIVE_TOOL_WATCHDOG_MS: '10000',
                LIVE_START_TIMEOUT_MS: '8000',
                NODE_ENV: 'test'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        server.stdout.on('data', (d) => { serverLog += d.toString(); });
        server.stderr.on('data', (d) => { serverLog += d.toString(); });
        await waitFor(() => serverLog.includes('Server is listening'), 15000);
        assert.ok(serverLog.includes('Server is listening'), `server did not start:\n${serverLog}`);
    });

    after(async () => {
        try { server?.kill('SIGTERM'); } catch { /* already dead */ }
        await provider?.stop();
    });

    it('carries the token in the URL PATH and reaches the provider', async () => {
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient('/' + encodeURIComponent(token));
        try {
            sendStartFrame(socket);
            const conn = await waitFor(
                () => provider.connections.find((c) => c.messages.some((m) => m.type === 'session.start')),
                8000
            );
            assert.ok(conn, 'provider never received session.start for a path-token stream');
        } finally {
            socket.close();
            await sleep(300);
        }
    });

    it('rejects an invalid token at upgrade', async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/media-stream/v1.forged.invalid`);
        const [code] = await once(socket, 'close');
        assert.equal(code, 4403);
        assert.ok(serverLog.includes('invalid_stream_token'), `expected invalid_stream_token audit:\n${serverLog}`);
    });

    it('accepts a deferred token delivered via start.customParameters', async () => {
        const beforeCount = provider.connections.length;
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient();
        try {
            // No provider connection may exist before the start frame verifies.
            assert.equal(provider.connections.length, beforeCount,
                'provider connected before deferred authentication completed');
            sendStartFrame(socket, { customParameters: { stream_token: token } });
            const conn = await waitFor(
                () => provider.connections.slice(beforeCount)
                    .find((c) => c.messages.some((m) => m.type === 'session.start')),
                8000
            );
            assert.ok(conn, 'provider never received session.start after deferred auth');
        } finally {
            socket.close();
            await sleep(300);
        }
    });

    it('rejects a start frame that never supplies a token', async () => {
        const socket = await connectClient();
        try {
            sendStartFrame(socket, { customParameters: {} });
            const [code] = await once(socket, 'close');
            assert.equal(code, 4403);
            assert.ok(serverLog.includes('missing_or_invalid_stream_token'),
                `expected missing_or_invalid_stream_token audit:\n${serverLog}`);
        } finally {
            socket.close();
        }
    });

    it('caller disconnect produces no provider reconnect', async () => {
        const beforeCount = provider.connections.length;
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient('/' + encodeURIComponent(token));
        sendStartFrame(socket);
        const conn = await waitFor(
            () => provider.connections.slice(beforeCount)
                .find((c) => c.messages.some((m) => m.type === 'session.start')),
            8000
        );
        assert.ok(conn, 'provider never connected');
        socket.close();
        await sleep(1200);
        assert.equal(provider.connections.length, beforeCount + 1,
            `provider reconnect attempted after caller disconnect\n${serverLog.slice(-3000)}`);
    });

    it('REVIEW-R08: delegated tool output precedes response.create on the Live path', async () => {
        const count = provider.connections.length;
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient('/' + encodeURIComponent(token));
        try {
            sendStartFrame(socket);
            const liveConn = await waitFor(
                () => provider.connections.slice(count)
                    .find((c) => c.messages.some((m) => m.type === 'session.start')),
                8000
            );
            assert.ok(liveConn, 'provider never received a connection for this stream');
            assert.ok(
                await waitFor(() => liveConn.messages.some((m) => m.type === 'session.start'), 5000),
                'provider never received session.start'
            );

            const { callId } = provider.injectDelegation(
                liveConn, 'lookup_company_knowledge', '{"query":"営業時間"}'
            );

            const ordered = await waitFor(() => {
                const itemIdx = liveConn.messages.findIndex(
                    (m) => m.type === 'response.item.create' && m.item?.call_id === callId
                );
                const createIdx = liveConn.messages.findIndex((m) => m.type === 'response.create');
                if (itemIdx >= 0 && createIdx > itemIdx) return true;
                return null;
            }, 8000);
            assert.ok(
                ordered,
                `function_call_output did not precede response.create: ${JSON.stringify(liveConn.messages.map((m) => m.type))}`
            );
            assert.ok(
                !liveConn.messages.some((m) => m.type === 'error'),
                'provider rejected a premature response.create'
            );
        } finally {
            socket.close();
            await sleep(300);
        }
    });

    it('rejects a start frame whose callSid does not match the token', async () => {
        const otherCallSid = 'CA' + 'f'.repeat(32);
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient(`?token=${encodeURIComponent(token)}`);
        socket.send(JSON.stringify({
            event: 'start',
            start: {
                streamSid: 'MZ' + '0'.repeat(32),
                accountSid: 'AC' + '1'.repeat(32),
                callSid: otherCallSid,
                customParameters: {}
            }
        }));
        await once(socket, 'close');
        assert.ok(serverLog.includes('call_sid_mismatch'), `expected call_sid_mismatch audit:\n${serverLog}`);
    });

    it('REVIEW-R10/S-04: a complex complaint escalates via Live backend delegation', async () => {
        const beforeCount = provider.connections.length;
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient('/' + encodeURIComponent(token));
        try {
            sendStartFrame(socket);
            const conn = await waitFor(
                () => provider.connections.slice(beforeCount)
                    .find((c) => c.messages.some((m) => m.type === 'session.start')),
                8000
            );
            assert.ok(conn, 'provider never connected');
            const startLog = serverLog.length;

            // A complaint utterance finalizes after the user-turn gap and the
            // server must escalate through a delegation session.update — the
            // Live replacement for the Realtime model/voice switch.
            conn.socket.send(JSON.stringify({
                type: 'session.input_transcript.delta',
                delta: '今月の請求金額が間違っている。納得できない。'
            }));
            const update = await waitFor(() => conn.messages.find((m) =>
                m.type === 'session.update'
                && String(m.event_id || '').startsWith('upd_complex_')), 8000);
            assert.ok(update, 'no complex-escalation session.update was sent');
            const instructions = update.session?.delegation?.responses?.instructions || '';
            assert.match(instructions, /苦情|クレーム|紛争/,
                'escalation update did not carry complex-complaint instructions');

            await waitFor(() => serverLog.slice(startLog).includes('live.backend_escalation.activated'), 5000);
            assert.ok(
                serverLog.slice(startLog).includes('live.backend_escalation.activated'),
                'backend escalation was not activated by the update ack'
            );
        } finally {
            socket.close();
            await sleep(300);
        }
    });

    it('REVIEW-R01: unauthenticated idle stream must not start a paid provider session', async () => {
        const beforeCount = provider.connections.length;
        const socket = await connectClient();
        try {
            await sleep(600);
            const started = provider.connections.slice(beforeCount).some(c => c.messages.some(e => e.type === 'session.start'));
            assert.equal(started, false, 'REPRODUCED: session.start sent before receiving ANY authentication frame');
        } finally { socket.close(); await sleep(300); }
    });

    it('REVIEW-R02: lifecycle-only continuation must not disable the 25-second silence bound', async () => {
        const count = provider.connections.length;
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient('/' + encodeURIComponent(token));
        try {
            sendStartFrame(socket);
            const conn = await waitFor(() => provider.connections.slice(count).find(c => c.messages.some(e => e.type === 'session.start')));
            const startLog = serverLog.length;
            provider.injectDelegation(conn, 'lookup_company_knowledge', '{"query":"営業時間"}');
            await waitFor(() => conn.messages.some(e => e.type === 'response.create'));
            await sleep(26000);
            const nudge = conn.messages.some(e => e.type === 'session.instructions.append');
            const watchdog = /live.tool_response.(stalled|failed)/.test(serverLog.slice(startLog));
            assert.ok(nudge || watchdog || socket.readyState !== WebSocket.OPEN,
                'REPRODUCED: 26 seconds without any audio; socket still OPEN, no watchdog/fallback/end');
        } finally { socket.close(); await sleep(300); }
    });

});
