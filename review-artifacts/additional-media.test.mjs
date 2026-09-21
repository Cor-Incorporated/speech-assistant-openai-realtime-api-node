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

    it('a path-token stream reaches the provider — the real Twilio channel', async () => {
        // Production TwiML carries the token as /media-stream/<token> because
        // Twilio does not forward the <Stream url> query on connect.
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient(`/${encodeURIComponent(token)}`);
        sendStartFrame(socket);
        const liveConn = await waitFor(() => provider.started, 5000);
        assert.ok(liveConn, 'provider never received session.start via path token');
        socket.close();
    });

    it('a tokenless stream is rejected at the start frame when the Parameter channel is also empty', async () => {
        const socket = await connectClient();
        sendStartFrame(socket); // no stream_token in customParameters
        await once(socket, 'close');
        assert.ok(serverLog.includes('missing_or_invalid_stream_token'), `expected deferred rejection:\n${serverLog}`);
    });

    it('a tokenless stream sending non-start events is rejected', async () => {
        const socket = await connectClient();
        socket.send(JSON.stringify({ event: 'media', media: { payload: 'AA==' } }));
        await once(socket, 'close');
        assert.ok(serverLog.includes('stream_auth_required'), `expected stream_auth_required:\n${serverLog}`);
    });

    it('a tokenless stream authenticates via start.customParameters.stream_token', async () => {
        // The <Parameter> fallback channel — if both URL channels ever fail,
        // the credential still arrives in the start frame.
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const socket = await connectClient();
        sendStartFrame(socket, { stream_token: token });
        const liveConn = await waitFor(() => provider.started, 5000);
        assert.ok(liveConn, 'provider never received session.start via Parameter token');
        socket.close();
    });

    it('rejects a tampered token immediately at upgrade time', async () => {
        // Invalid (not missing) tokens never enter the deferred path — the
        // connection is closed before the start frame can even be processed.
        const socket = await connectClient('/v1.bad.bad');
        await once(socket, 'close');
        assert.ok(serverLog.includes('invalid_stream_token'));
    });

    it('a signed stream reaches the provider and drains on caller disconnect', async () => {
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const connIndex = provider.connections.length;
        const socket = await connectClient(`/${encodeURIComponent(token)}`);
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

        // Provider session.start must arrive — capture THIS stream's provider
        // connection by index (provider.started is overwritten by later tests).
        const liveConn = await waitFor(() => provider.connections[connIndex], 5000);
        assert.ok(liveConn, 'provider never received a connection for this stream');
        assert.ok(
            liveConn.messages.some((m) => m.type === 'session.start'),
            'provider never received session.start'
        );
        // Settle: deferred-auth tests legitimately create provider sockets
        // that may register in the stub a beat late — absorb them before
        // snapshotting so the count reflects only this stream's lifecycle.
        await sleep(500);
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

    it('submits function_call_output before response.create — the provider contract', async () => {
        // Regression for the production incident: the knowledge tool output
        // never reached the provider, so response.create was rejected with
        // "Submit the pending function call outputs" and the caller heard
        // 86 seconds of silence. The stub enforces the same contract — a
        // create arriving while a call is pending produces an error event.
        const token = createStreamToken({ callSid: CALL_SID, secret: AUTH_TOKEN });
        const connIndex = provider.connections.length;
        const socket = await connectClient(`/${encodeURIComponent(token)}`);
        sendStartFrame(socket);
        const liveConn = await waitFor(() => provider.connections[connIndex], 5000);
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
        socket.close();
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

    it('N08 watchdog must end a completely silent call within 25 seconds', async()=>{
        const count=provider.connections.length, token=createStreamToken({callSid:CALL_SID,secret:AUTH_TOKEN});
        const socket=await connectClient('/'+encodeURIComponent(token));
        try {
            sendStartFrame(socket);
            const conn=await waitFor(()=>provider.connections.slice(count).find(c=>c.messages.some(e=>e.type==='session.start')));
            provider.injectDelegation(conn,'lookup_company_knowledge','{"query":"営業時間"}');
            await sleep(26000);
            assert.notEqual(socket.readyState,WebSocket.OPEN,'Watchdog logged stages but never closed the silent call');
        }finally{socket.close();await sleep(300);}
    });
    it('N09 silent PCMU packets must not cancel the response watchdog',async()=>{
        const count=provider.connections.length, token=createStreamToken({callSid:CALL_SID,secret:AUTH_TOKEN});
        const socket=await connectClient('/'+encodeURIComponent(token));
        let ticker;
        try{
            sendStartFrame(socket);
            const conn=await waitFor(()=>provider.connections.slice(count).find(c=>c.messages.some(e=>e.type==='session.start')));
            const startLog=serverLog.length;
            provider.injectDelegation(conn,'lookup_company_knowledge','{"query":"営業時間"}');
            await waitFor(()=>conn.messages.some(e=>e.type==='response.create'));
            ticker=setInterval(()=>{if(conn.socket.readyState===WebSocket.OPEN)conn.socket.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(160,255).toString('base64')}));},100);
            await sleep(26000);
            assert.ok(/live.tool_response.(stalled|failed)/.test(serverLog.slice(startLog)) || socket.readyState!==WebSocket.OPEN,'Silent audio canceled watchdog, 26 seconds without any audible response');
        }finally{clearInterval(ticker);socket.close();await sleep(300);}
    });
it('B05 empty transcript delta must not cancel a stalled-tool watchdog',async()=>{
        const count=provider.connections.length,token=createStreamToken({callSid:CALL_SID,secret:AUTH_TOKEN});
        const socket=await connectClient('/'+encodeURIComponent(token));
        try{
            sendStartFrame(socket);
            const conn=await waitFor(()=>provider.connections.slice(count).find(c=>c.messages.some(e=>e.type==='session.start')));
            provider.injectDelegation(conn,'lookup_company_knowledge','{"query":"営業時間"}');
            await waitFor(()=>conn.messages.some(e=>e.type==='response.create'));
            conn.socket.send(JSON.stringify({type:'session.output_transcript.delta',delta:''}));
            await sleep(26000);
            assert.notEqual(socket.readyState,WebSocket.OPEN,'Empty transcript canceled watchdog; silence lasted 26 seconds');
        }finally{socket.close();await sleep(300);}
    });
    it('B06 brief filler then 26 seconds of silence still needs recovery',async()=>{
        const count=provider.connections.length,token=createStreamToken({callSid:CALL_SID,secret:AUTH_TOKEN});
        const socket=await connectClient('/'+encodeURIComponent(token));
        try{
            sendStartFrame(socket);
            const conn=await waitFor(()=>provider.connections.slice(count).find(c=>c.messages.some(e=>e.type==='session.start')));
            provider.injectDelegation(conn,'lookup_company_knowledge','{"query":"営業時間"}');
            await waitFor(()=>conn.messages.some(e=>e.type==='response.create'));
            conn.socket.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.from(Array.from({length:160},(_,i)=>i%2?0xd5:0x55)).toString('base64')}));
            conn.socket.send(JSON.stringify({type:'session.output_transcript.delta',delta:'少々お待ちください'}));
            await sleep(26000);
            assert.notEqual(socket.readyState,WebSocket.OPEN,'A brief filler permanently disabled recovery for the following silence');
        }finally{socket.close();await sleep(300);}
    });
    it('N10 unauthenticated connection must not create an operational call record',async()=>{
        const headers={Authorization:'Basic '+Buffer.from('recheck:local-only').toString('base64')};
        const get=()=>fetch(`http://127.0.0.1:${serverPort}/api/admin/v2/calls`,{headers}).then(r=>r.json());
        const before=await get();
        const ids=new Set(before.items.map(x=>x.callId));
        const socket=await connectClient();socket.close();await sleep(1000);
        const after=await get();
        const created=after.items.filter(x=>!ids.has(x.callId));
        assert.equal(created.length,0,'Unvalidated idle connection was projected as a real provider call');
    });

});
