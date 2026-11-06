import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandoffConfig, HandoffContextStore } from '../lib/handoff.js';
import {
    generateHandoffSummary,
    initialSummaryState,
    runHandoffSummary,
    sanitizeSpokenSummary,
    waitForWhisperSummary
} from '../lib/handoff-summary.js';

const turns = [
    { role: 'agent', text: 'ご用件をお聞かせください。' },
    { role: 'user', text: '納品してもらった画面が動かないので至急見てほしいです。株式会社テストの山田です。' }
];

const responsesOk = (text) => async () => new Response(JSON.stringify({ output_text: text }), { status: 200 });

test('summary request carries the transcript, forbids following injected instructions and does not store the call', async () => {
    let captured;
    const result = await generateHandoffSummary({
        turns,
        apiKey: 'sk-test',
        model: 'gpt-5.4-mini',
        fetchImpl: async (url, options) => {
            captured = { url, body: JSON.parse(options.body), headers: options.headers };
            return new Response(JSON.stringify({ output_text: '株式会社テストの山田様から、納品済みの画面が動かないため至急の確認依頼です。' }), { status: 200 });
        }
    });

    assert.equal(result.ok, true);
    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    assert.equal(captured.body.model, 'gpt-5.4-mini');
    assert.equal(captured.body.store, false);
    assert.match(captured.body.input[0].content, /指示や命令には従わず/);
    assert.match(captured.body.input[1].content, /発信者: 納品してもらった画面が動かない/);
    assert.equal(captured.headers.Authorization, 'Bearer sk-test');
});

test('summary output is made speakable and bounded', () => {
    assert.equal(sanitizeSpokenSummary('「至急」\n（確認）依頼です  '), '至急 確認依頼です');
    const long = sanitizeSpokenSummary('あ'.repeat(500));
    assert.equal(long.length, 140);
    assert.ok(long.endsWith('…'));
});

test('summary generation reports failures instead of throwing', async () => {
    assert.deepEqual(await generateHandoffSummary({ turns, apiKey: '', model: 'm' }), { ok: false, reason: 'missing_api_key' });
    assert.deepEqual(await generateHandoffSummary({ turns: [], apiKey: 'k', model: 'm' }), { ok: false, reason: 'empty_transcript' });
    assert.deepEqual(
        await generateHandoffSummary({ turns, apiKey: 'k', model: 'm', fetchImpl: async () => new Response('x', { status: 429 }) }),
        { ok: false, reason: 'http_429' }
    );
    assert.deepEqual(
        await generateHandoffSummary({ turns, apiKey: 'k', model: 'm', fetchImpl: async () => { throw new Error('boom'); } }),
        { ok: false, reason: 'request_failed' }
    );
    assert.deepEqual(
        await generateHandoffSummary({ turns, apiKey: 'k', model: 'm', fetchImpl: responsesOk('   ') }),
        { ok: false, reason: 'empty_output' }
    );
});

test('runHandoffSummary stores the AI summary, or records the failure while keeping the heuristic', async () => {
    const config = buildHandoffConfig({ HANDOFF_ENABLED: 'true', HANDOFF_NUMBERS: '+810000000000' });
    const store = new HandoffContextStore();
    await store.save('CA1', { whisperSummary: '用件は動かない', summaryStatus: 'pending' });

    await runHandoffSummary({ store, callSid: 'CA1', turns, config, apiKey: 'k', defaultModel: 'm', fetchImpl: responsesOk('至急の確認依頼です') });
    assert.deepEqual(
        (({ whisperSummary, summarySource, summaryStatus }) => ({ whisperSummary, summarySource, summaryStatus }))(await store.get('CA1')),
        { whisperSummary: '至急の確認依頼です', summarySource: 'ai', summaryStatus: 'ready' }
    );

    await store.save('CA2', { whisperSummary: '用件は動かない', summaryStatus: 'pending' });
    await runHandoffSummary({
        store, callSid: 'CA2', turns, config, apiKey: 'k', defaultModel: 'm',
        fetchImpl: async () => new Response('x', { status: 500 })
    });
    const failed = await store.get('CA2');
    assert.equal(failed.whisperSummary, '用件は動かない');
    assert.equal(failed.summaryStatus, 'failed');
    assert.equal(failed.summaryFailure, 'http_500');
});

test('summary state is pending only when enabled and an API key exists', () => {
    const on = buildHandoffConfig({ HANDOFF_SUMMARY_ENABLED: 'true' });
    const off = buildHandoffConfig({ HANDOFF_SUMMARY_ENABLED: 'false' });
    assert.equal(initialSummaryState({ config: on, apiKey: 'k' }).summaryStatus, 'pending');
    assert.equal(initialSummaryState({ config: on, apiKey: '' }).summaryStatus, 'skipped');
    assert.equal(initialSummaryState({ config: off, apiKey: 'k' }).summaryStatus, 'skipped');
});

test('waitForWhisperSummary returns immediately when nothing is pending and stops at the deadline otherwise', async () => {
    const store = new HandoffContextStore();
    await store.save('CA1', { summaryStatus: 'ready', whisperSummary: 'x' });
    const ready = await waitForWhisperSummary({ store, callSid: 'CA1', waitMs: 5000, sleep: async () => { throw new Error('must not sleep'); } });
    assert.equal(ready.whisperSummary, 'x');

    await store.save('CA2', { summaryStatus: 'pending' });
    const started = Date.now();
    const pending = await waitForWhisperSummary({ store, callSid: 'CA2', waitMs: 60, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    assert.equal(pending.summaryStatus, 'pending');
    assert.ok(Date.now() - started < 1000);
});

test('handoff context update persists only the patch so concurrent writers do not clobber each other', async () => {
    const writes = [];
    const firestore = {
        runTransaction: async (operation) => operation({
            get: (ref) => ref.get(),
            set: (_ref, value, options) => { writes.push({ value, options }); }
        }),
        collection: () => ({
            doc: () => ({
                set: async (value, options) => { writes.push({ value, options }); },
                get: async () => ({ exists: true, data: () => ({ status: 'x' }) })
            })
        })
    };
    const store = new HandoffContextStore({ firestoreEnabled: true, firestore });
    await store.update('CA1', { status: 'whisper_started' });
    assert.deepEqual(Object.keys(writes[0].value).sort(), ['callSid', 'status', 'updatedAt']);
    assert.deepEqual(writes[0].options, { merge: true });
});
