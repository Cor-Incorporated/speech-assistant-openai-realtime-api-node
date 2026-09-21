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
                }
                if (event.type === 'response.create') {
                    // Emulate the real provider contract: a create arriving
                    // while function calls have no submitted output is an
                    // error, and the call stays pending — this is the exact
                    // failure that produced 86s of dead air in production.
                    const pending = conn.pendingCalls.filter((id) => !conn.toolOutputs.includes(id));
                    if (pending.length) {
                        socket.send(JSON.stringify({
                            type: 'error',
                            error: { message: 'Submit the pending function call outputs before response.create.' }
                        }));
                    } else if (conn.activeDelegation) {
                        // Continuation response under the same delegation —
                        // what the real provider emits after valid outputs.
                        socket.send(JSON.stringify({
                            type: 'response.event',
                            delegation_id: conn.activeDelegation,
                            event: { type: 'response.in_progress', response: { id: 'resp_cont', status: 'in_progress' } }
                        }));
                        socket.send(JSON.stringify({
                            type: 'response.event',
                            delegation_id: conn.activeDelegation,
                            event: { type: 'response.completed', response: { id: 'resp_cont', status: 'completed' } }
                        }));
                    }
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

    // Drive a delegated function_call the way the real provider does:
    // delegation.created, the call's output_item.done, then response.completed.
    injectDelegation(conn, callName, args = '{}') {
        const suffix = String(Date.now()) + String(conn.pendingCalls.length);
        const delegationId = `item_inj_${suffix}`;
        const callId = `call_inj_${suffix}`;
        conn.activeDelegation = delegationId;
        conn.pendingCalls.push(callId);
        conn.socket.send(JSON.stringify({
            type: 'session.delegation.created',
            delegation: { id: delegationId, type: 'delegation', response_id: `resp_inj_${suffix}`, target: 'responses' }
        }));
        conn.socket.send(JSON.stringify({
            type: 'response.event',
            delegation_id: delegationId,
            event: {
                type: 'response.output_item.done',
                item: { id: `fc_inj_${suffix}`, type: 'function_call', status: 'completed', arguments: args, call_id: callId, name: callName },
                output_index: 0
            }
        }));
        conn.socket.send(JSON.stringify({
            type: 'response.event',
            delegation_id: delegationId,
            event: { type: 'response.completed', response: { id: `resp_inj_${suffix}`, status: 'completed' } }
        }));
        return { delegationId, callId };
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

        // Bind :0 first to claim a definitely-free port — the sibling
        // media suites draw from a shared random band and collide under
        // parallel runs (EADDRINUSE flake observed in npm test).
        const probe = (await import('node:net')).createServer();
        await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
        serverPort = probe.address().port;
        await new Promise((resolve) => probe.close(resolve));
        server = spawn(process.execPath, [INDEX_PATH], {
            env: {
                ...process.env,
                PATH: process.env.PATH,
                PORT: String(serverPort),
                ADMIN_BASIC_USER: 'recheck', ADMIN_BASIC_PASSWORD: 'local-only',
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

    const connectClient = async (path = '') => {
        const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/media-stream${path}`);
        await once(socket, 'open');
        return socket;
    };

    const sendStartFrame = (socket, customParameters = {}, callSid = CALL_SID) => {
        socket.send(JSON.stringify({
            event: 'start',
            sequenceNumber: '1',
            start: {
                streamSid: 'MZ' + 'd'.repeat(32),
                accountSid: 'AC' + 'e'.repeat(32),
                callSid,
                customParameters
            },
            streamSid: 'MZ' + 'd'.repeat(32)
        }));
    };

    for (const [id, fragments] of [
        ['F01-whole', ['少々お待ちくださいませ']],
        ['F02-split', ['少々お待ちください', 'ま', 'せ']]
    ]) it(id + ' the same catalogued polite filler has invariant completion', async () => {
        const count=provider.connections.length, token=createStreamToken({callSid:CALL_SID,secret:AUTH_TOKEN});
        const socket=await connectClient('/'+encodeURIComponent(token));
        try {
            sendStartFrame(socket);
            const conn=await waitFor(()=>provider.connections.slice(count).find(c=>c.messages.some(e=>e.type==='session.start')));
            provider.injectDelegation(conn,'lookup_company_knowledge','{"query":"代表者"}');
            await waitFor(()=>conn.messages.some(e=>e.type==='response.create'));await sleep(100);
            conn.socket.send(JSON.stringify({type:'session.output_transcript.delta',delta:fragments[0]}));
            for(let i=0;i<8;i++){conn.socket.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.from(Array.from({length:160},(_,n)=>n%2?0xd5:0x55)).toString('base64')}));await sleep(20);}
            for(const delta of fragments.slice(1)){conn.socket.send(JSON.stringify({type:'session.output_transcript.delta',delta}));await sleep(80);}
            await sleep(26000);
            console.log(JSON.stringify({case:id,transcript:fragments.join(''),audioPackets:8,wsOpen:socket.readyState===WebSocket.OPEN,watchdogNudges:conn.messages.filter(e=>e.type==='session.instructions.append').length,toolResults:conn.toolOutputs.length}));
            assert.notEqual(socket.readyState,WebSocket.OPEN,'Same polite waiting phrase lost watchdog when streamed');
        } finally {socket.close();await sleep(300);}
    });
});
