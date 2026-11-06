import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

// Exercise the actual CLI exit codes without API credentials, network access,
// or the macOS speech binaries. The provider controls each failure boundary.
const temp = mkdtempSync(join(tmpdir(), 'voice-smoke-result-'));
after(() => rmSync(temp, { recursive: true, force: true }));
const wsPath = join(temp, 'ws.mjs');
const speechPath = join(temp, 'speech.mjs');
const loaderPath = join(temp, 'loader.mjs');
writeFileSync(speechPath, `
import { writeFileSync } from 'node:fs';
export function execFileSync(command, args) {
    if (command === 'afconvert') writeFileSync(args.at(-1), Buffer.alloc(364));
    return Buffer.alloc(0);
}
`);
writeFileSync(wsPath, `
import { EventEmitter } from 'node:events';
export default class WebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); setImmediate(() => this.emit('open')); }
    close(code = 1000) { this.readyState = 3; this.emit('close', code); }
    send(raw) {
        const event = JSON.parse(raw);
        const scenario = process.env.VOICE_SMOKE_CASE;
        if (event.event === 'media' && scenario === 'media-cadence') {
            const index = this.inputFrames || 0;
            if (event.sequenceNumber !== String(index + 2)
                || event.media.chunk !== String(index + 1)
                || event.media.timestamp !== String(index * 20)
                || !Buffer.from(event.media.payload, 'base64').equals(Buffer.alloc(160, 0xff))) {
                throw new Error('invalid media frame sequence, timestamp or payload');
            }
            if (!index) this.firstFrameAt = Date.now();
            this.inputFrames = index + 1;
            if (this.inputFrames === 3) {
                if (Date.now() - this.firstFrameAt < 30) throw new Error('media frames were burst instead of paced');
                this.emit('message', JSON.stringify({ event: 'media', media: { payload: '/w==' } }));
            }
            return;
        }
        if (event.type !== 'session.start' && event.event !== 'start') return;
        setImmediate(() => {
            const message = (value) => this.emit('message', JSON.stringify(value));
            if (event.event === 'start') {
                if (scenario === 'media-cadence') return;
                if (scenario === 'media-ok') message({ event: 'media', media: { payload: '/w==' } });
                else if (scenario === 'media-error') this.emit('error', new Error('provider failed'));
                else this.close();
                return;
            }
            message({ type: 'session.started', session: { id: 'synthetic' } });
            if (scenario !== 'live-empty') {
                message({ type: 'session.input_transcript.delta', delta: '営業時間は' });
                message({ type: 'session.output_transcript.delta', delta: '確認します' });
                if (scenario !== 'live-text-only') message({ type: 'session.output_audio.delta', delta: '/w==' });
            }
            if (scenario === 'live-error') message({ type: 'error', error: { message: 'provider failed' } });
            if (scenario === 'live-abnormal') this.close(1006);
            else if (scenario === 'live-empty') this.close();
            else message({ type: 'session.closed', usage: {} });
        });
    }
}
`);
writeFileSync(loaderPath, `
const mocks = ${JSON.stringify({ ws: pathToFileURL(wsPath).href, 'node:child_process': pathToFileURL(speechPath).href })};
export function resolve(specifier, context, nextResolve) {
    return mocks[specifier] ? { url: mocks[specifier], shortCircuit: true } : nextResolve(specifier, context);
}
`);

function run(script, scenario, args = []) {
    const result = spawnSync(process.execPath, [
        '--no-warnings', '--loader', loaderPath,
        fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...args
    ], {
        cwd: temp,
        env: { PATH: process.env.PATH, OPENAI_API_KEY: 'synthetic-test-key', VOICE_SMOKE_CASE: scenario, MEDIA_STREAM_SMOKE_TIMEOUT_MS: '1000' },
        encoding: 'utf8', timeout: 5000
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
}

for (const scenario of ['media-empty', 'media-error']) {
    test(`media stream smoke fails for ${scenario}`, () => {
        const result = run('smoke-media-stream.js', scenario);
        assert.equal(result.status, 1, result.output);
    });
}
test('media stream smoke succeeds only after outbound audio', () => {
    const result = run('smoke-media-stream.js', 'media-ok');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /received outbound media payload/);
});
test('media stream smoke maintains paced input until the provider returns media', () => {
    const result = run('smoke-media-stream.js', 'media-cadence');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /received outbound media payload/);
});
for (const scenario of ['live-empty', 'live-text-only', 'live-error']) {
    test(`Live smoke fails for ${scenario}`, () => {
        const result = run('verify-live.js', scenario);
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /== FAIL ==/);
    });
}
test('Live smoke succeeds with input transcript and audio output', () => {
    const result = run('verify-live.js', 'live-ok');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /== PASS ==/);
});
test('Live forced tool smoke fails without a tool round trip', () => {
    const result = run('verify-live.js', 'live-ok', ['--force-tool']);
    assert.equal(result.status, 1, result.output);
});
test('Live smoke fails on abnormal closure even after receiving audio', () => {
    const result = run('verify-live.js', 'live-abnormal');
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /ws.close.*1006/);
    assert.match(result.output, /== FAIL ==/);
});
