#!/usr/bin/env node
// Real GPT-Live API verification: connects a session, sends generated Japanese
// speech as caller audio, and reports transcripts, audio deltas, and any
// delegated tool calls. Never sends real customer data; the utterance is a
// fixed synthetic phrase generated locally with `say`/`afconvert`.
//
// Usage:
//   OPENAI_API_KEY=... node scripts/verify-live.js
//   OPENAI_API_KEY=... node scripts/verify-live.js --format audio/pcm --rate 8000

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
    buildLiveSessionStart,
    classifyLiveEvent,
    createLiveAudioCodec,
    createLiveDelegationTracker,
    liveAudioAppend,
    liveItemCreate,
    liveResponseCreate,
    liveSessionClose,
    pcm16ToMulaw
} from '../lib/live-session.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : fallback;
};

const AUDIO_FORMAT = opt('format', 'audio/pcmu');
const AUDIO_RATE = Number(opt('rate', '8000'));
const LIVE_MODEL = opt('model', process.env.LIVE_MODEL || 'gpt-live-1');
const BACKEND_MODEL = opt('backend', process.env.LIVE_BACKEND_MODEL || 'gpt-5.6-luna');
const VOICE = opt('voice', process.env.LIVE_VOICE || 'marin');
const UTTERANCE = opt('say', '営業時間を教えてください');
const TIMEOUT_MS = Number(opt('timeout', '45000'));
const FORCE_TOOL = args.includes('--force-tool');
const DUMP = args.includes('--dump');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.error('OPENAI_API_KEY is required');
    process.exit(1);
}

const wavPath = join(tmpdir(), `verify-live-${Date.now()}.wav`);
const aiffPath = join(tmpdir(), `verify-live-${Date.now()}.aiff`);
execFileSync('say', ['-v', 'Eddy', '-o', aiffPath, UTTERANCE]);
execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${AUDIO_RATE}`, '-c', '1', aiffPath, wavPath]);
const wav = readFileSync(wavPath);
// Standard PCM WAVE has a 44-byte header before the data chunk.
const pcm = wav.subarray(44);
const mulaw = pcm16ToMulaw(pcm);
console.log(`[setup] utterance="${UTTERANCE}" pcm=${pcm.length}B mulaw=${mulaw.length}B @${AUDIO_RATE}Hz`);

const codec = createLiveAudioCodec({ inputFormatType: AUDIO_FORMAT, inputRate: AUDIO_RATE });
const tracker = createLiveDelegationTracker();

const counts = {
    inputTranscriptDeltas: 0,
    outputTranscriptDeltas: 0,
    audioDeltas: 0,
    audioBytes: 0,
    delegations: 0,
    functionCalls: [],
    errors: []
};
let inputTranscript = '';
let outputTranscript = '';
let started = false;
let finished = false;

const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: { Authorization: `Bearer ${apiKey}` }
});

const timeout = setTimeout(() => {
    if (!finished) {
        console.error(`\n[timeout] ${TIMEOUT_MS}ms elapsed`);
        report(1);
    }
}, TIMEOUT_MS);

function report(code) {
    finished = true;
    clearTimeout(timeout);
    console.log('\n== RESULT ==');
    console.log(`started=${started}`);
    console.log(`inputTranscript="${inputTranscript.trim()}"`);
    console.log(`outputTranscript="${outputTranscript.trim().slice(0, 200)}"`);
    console.log(`counts=${JSON.stringify({ ...counts, functionCalls: counts.functionCalls.map((c) => c.name) })}`);
    const pass = started && inputTranscript.length > 0
        && (counts.audioDeltas > 0 || outputTranscript.length > 0)
        && (!FORCE_TOOL || counts.functionCalls.length > 0);
    console.log(pass ? '== PASS ==' : '== FAIL ==');
    try { ws.close(); } catch { /* ignore */ }
    process.exit(code ?? (pass ? 0 : 1));
}

ws.on('open', () => {
    const start = buildLiveSessionStart({
        model: LIVE_MODEL,
        voice: VOICE,
        audioFormatType: AUDIO_FORMAT,
        audioRate: AUDIO_RATE,
        instructions: FORCE_TOOL
            ? 'あなたはCor.株式会社の電話受付を行う日本語の音声AIです。発信者の発話への応答はすべてバックエンドに委譲し、自分では回答を生成しないでください。'
            : [
                'あなたはCor.株式会社の電話受付を行う日本語の音声AIです。簡潔で丁寧な自然な日本語で話してください。',
                '業務上の判断はすべてバックエンドに委譲してください。',
                '「営業時間」「営業日」は営業勧誘ではなく会社案内への一般質問です。'
            ].join('\n'),
        delegationResponses: {
            model: BACKEND_MODEL,
            instructions: FORCE_TOOL
                ? 'あなたは電話受付の業務判断バックエンドです。発信者が何か言ったら、内容に関係なく必ずfinish_receptionツールを呼び出してください。reasonは"test"、callback_requiredはfalseにしてください。'
                : 'あなたは電話受付の業務判断バックエンドです。営業時間への質問には「確認して折り返します」とだけ回答してください。',
            tools: [{
                type: 'function',
                name: 'finish_reception',
                description: 'Use when reception is complete.',
                parameters: {
                    type: 'object',
                    properties: {
                        reason: { type: 'string' },
                        callback_required: { type: 'boolean' }
                    },
                    required: ['reason', 'callback_required']
                }
            }, {
                type: 'function',
                name: 'transfer_to_human',
                description: 'Transfer the call to a human agent when the caller explicitly requests a human or urgent human handling is required.',
                parameters: {
                    type: 'object',
                    properties: {
                        reason: { type: 'string' },
                        destination: { type: 'string', enum: ['general', 'contract'] }
                    },
                    required: ['reason']
                }
            }],
            tool_choice: 'auto'
        }
    });
    console.log(`[start] model=${LIVE_MODEL} backend=${BACKEND_MODEL} format=${AUDIO_FORMAT}@${AUDIO_RATE}`);
    ws.send(JSON.stringify(start));
});

ws.on('message', (data) => {
    let event;
    try {
        event = JSON.parse(data);
    } catch {
        return;
    }
    const c = classifyLiveEvent(event);
    if (DUMP && c.kind !== 'audio_delta' && c.kind !== 'output_transcript_delta') {
        console.log(`[evt] ${JSON.stringify(event).slice(0, 500)}`);
    }
    switch (c.kind) {
        case 'started':
            started = true;
            console.log(`[started] session=${event.session?.id}`);
            // Stream caller audio at real-time pace (20ms frames).
            const input = codec.passthrough ? mulaw : pcm;
            const frameBytes = codec.passthrough ? 160 : 320; // 20ms @8kHz
            let offset = 0;
            const sender = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN || offset >= input.length) {
                    clearInterval(sender);
                    if (offset >= input.length) {
                        console.log(`[audio] sent ${offset} bytes`);
                        // keep silence flowing so the model can finish its turn
                        const silence = Buffer.alloc(frameBytes, codec.passthrough ? 0xFF : 0);
                        let silenceFrames = 0;
                        const silenceSender = setInterval(() => {
                            if (ws.readyState !== WebSocket.OPEN || silenceFrames >= 400) {
                                clearInterval(silenceSender);
                                setTimeout(() => report(), 5000);
                                return;
                            }
                            ws.send(JSON.stringify(liveAudioAppend(silence.toString('base64'))));
                            silenceFrames += 1;
                        }, 20);
                    }
                    return;
                }
                const frame = input.subarray(offset, offset + frameBytes);
                offset += frameBytes;
                ws.send(JSON.stringify(liveAudioAppend(frame.toString('base64'))));
            }, 20);
            break;
        case 'audio_delta': {
            counts.audioDeltas += 1;
            const out = Buffer.from(c.delta, 'base64');
            counts.audioBytes += out.length;
            break;
        }
        case 'input_transcript_delta':
            counts.inputTranscriptDeltas += 1;
            inputTranscript += c.delta || '';
            break;
        case 'output_transcript_delta':
            counts.outputTranscriptDeltas += 1;
            outputTranscript += c.delta || '';
            process.stdout.write(`\r[agent] ${outputTranscript.trim().slice(0, 120)}`);
            break;
        case 'delegation_created':
            counts.delegations += 1;
            console.log(`\n[delegation] id=${c.delegationId} target=${c.target}`);
            break;
        case 'response_event': {
            const done = tracker.observeResponseEvent(c.delegationId, c.nested);
            if (done?.calls?.length) {
                for (const call of done.calls) {
                    counts.functionCalls.push(call);
                    console.log(`\n[tool_call] ${call.name} ${call.arguments}`);
                    ws.send(JSON.stringify(liveItemCreate({
                        type: 'function_call_output',
                        call_id: call.call_id,
                        output: JSON.stringify({ status: 'ok' })
                    }, `tr_${call.call_id}`)));
                    ws.send(JSON.stringify(liveResponseCreate(`rc_${Date.now()}`)));
                }
            }
            break;
        }
        case 'closed':
            console.log(`\n[closed] usage=${JSON.stringify(event.usage)}`);
            report();
            break;
        case 'error':
            counts.errors.push(event.error?.message || 'unknown');
            console.error(`\n[error] ${JSON.stringify(event.error || event).slice(0, 300)}`);
            if (!started) report(1);
            break;
        default:
            break;
    }
});

ws.on('error', (err) => {
    console.error(`[ws.error] ${err.message}`);
    report(1);
});

ws.on('close', (code) => {
    if (!finished) {
        console.error(`\n[ws.close] code=${code}`);
        report(started ? 0 : 1);
    }
});
