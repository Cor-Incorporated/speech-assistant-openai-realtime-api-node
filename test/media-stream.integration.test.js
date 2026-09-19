// Runtime integration test through the REAL index.js handler with a mocked
// OpenAI provider WebSocket. This is the reception-level acceptance the audit
// requires — not a wire-format replay of a recorded event.
//
// Covers:
//   - unsigned /media-stream upgrade is rejected BEFORE any provider socket
//   - a signed stream reaches the provider (session.start observed)
//   - caller disconnect produces no provider reconnect
//   - Live session close is drained (session.close -> session.closed)
//
// The server runs as a subprocess with OPENAI_*_WS_URL pointed at a local
// stub; a fake Twilio Media Streams client exercises the real WS route.

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
    }

    async start() {
        this.wss = new WebSocketServer({ port: 0 });
        await once(this.wss, 'listening');
        this.port = this.wss.address().port;
        this.wss.on('connection', (socket) => {
            const conn = { socket, messages: [], closed: false };
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
                if (event.type === 'session.close') {
                    socket.send(JSON.stringify({ type: 'session.closed', usage: { total_tokens: 1 } }));
                }
            });
            socket.on('close', () => {
                conn.closed = true;
            });
        });
    }

    async stop() {
        for (const conn of this.connections) {
            try {
                conn.socket.close();
            } catch {
                // already closed
            }
        }
        if (this.wss) {
            this.wss.close();
            await once(this.wss, 'close').catch(() => {});
        }
    }
}

describe('media-stream integration (real handler, mocked provider)', () => {
    let server;
    let serverPort;
    let provider;
    let serverLog = '';

    before(async () => {
        provider = new ProviderStub();
        await provider.start();

        serverPort = 19500 + Math.floor(Math.random() * 400);
        server = spawn(process.execPath, [INDEX_PATH], {
            env: {
                ...process.env,
                PATH: process.env.PATH,
                PORT: String(serverPort),
                OPENAI_API_KEY: 'integration-test-key',
                TWILIO_AUTH_TOKEN: AUTH_TOKEN,
                TWILIO_STREAM_AUTH_ENABLED: 'true',
                VOICE_PROVIDER: 'live',
                OPENAI_LIVE_WS_URL: `ws://127.0.0.1:${provider.port}`,
                LIVE_FALLBACK_TO_REALTIME: 'true',
                LIVE_CLOSE_DRAIN_MS: '1500',
                CALL_GATE_REQUIRED: 'false',
                LOG_TRANSCRIPTS: 'false',
                CALL_LOG_FIRESTORE_ENABLED: 'false',
                NOTIFY_EMAIL_ENABLED: 'false',
                EXTRACTION_ENABLED: 'false',
                CALL_END_HANGUP_ENABLED: 'false'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        server.stdout.on('data', (d) => { serverLog += d.toString(); });
        server.stderr.on('data', (d) => { serverLog += d.toString(); });
        await waitFor(() => serverLog.includes('listening'), 10000);
        assert.ok(serverLog.includes('listening'), `server did not start:\n${serverLog}`);
    });

    after(async () => {
        if (server && !server.killed) server.kill('SIGKILL');
        await provider.stop();
    });

    const connectClient = async (query = '') => {
        const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/media-stream${query}`);
        await once(socket, 'open');
        return socket;
    };

    it('rejects an unsigned upgrade before any provider connection is created', async () => {
        const before = provider.connections.length;
        const socket = await connectClient();
        await once(socket, 'close');
        await sleep(300);
        assert.equal(provider.connections.length, before, 'provider socket created for unauthenticated stream');
        assert.ok(serverLog.includes('missing_stream_token'), `expected missing token rejection:\n${serverLog}`);
    });

    it('rejects a tampered token before any provider connection is created', async () => {
        const before = provider.connections.length;
        const socket = await connectClient('?token=v1.bad.bad');
        await once(socket, 'close');
        await sleep(300);
        assert.equal(provider.connections.length, before);
        assert.ok(serverLog.includes('invalid_stream_token'));
    });

    it('a signed stream reaches the provider and drains on caller disconnect', async () => {
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient(`?token=${encodeURIComponent(token)}`);
        const messages = [];
        socket.on('message', (data) => {
            try {
                messages.push(JSON.parse(data.toString()));
            } catch {
                // ignore
            }
        });

        // Twilio start frame — the same callSid the token was issued for.
        socket.send(JSON.stringify({
            event: 'start',
            sequenceNumber: '1',
            start: {
                streamSid: 'MZ' + 'd'.repeat(32),
                accountSid: 'AC' + 'e'.repeat(32),
                callSid: CALL_SID,
                customParameters: { from: '+819011112222', to: '+81333334444' }
            },
            streamSid: 'MZ' + 'd'.repeat(32)
        }));

        // Provider session.start must arrive — signed stream reached OpenAI stub.
        const liveConn = await waitFor(() => provider.started, 5000);
        assert.ok(liveConn, 'provider never received session.start');
        const connectionCount = provider.connections.length;

        // Caller disconnects — the provider session must be drained, not
        // abandoned, and absolutely no provider reconnect may happen.
        socket.close();
        await sleep(1200);
        assert.equal(provider.connections.length, connectionCount,
            `provider reconnect after caller disconnect: ${JSON.stringify(provider.connections.map((c) => c.messages.map((m) => m.type)))}`);
        const closeEvent = liveConn.messages.find((m) => m.type === 'session.close');
        assert.ok(closeEvent, 'session.close was never sent to the provider on disconnect');
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
});
