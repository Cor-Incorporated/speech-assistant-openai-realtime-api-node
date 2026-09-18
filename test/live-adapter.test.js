import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveAdapter, LIVE_EVENTS } from '../dist-backend/voice/live-adapter.js';

const config = {
    model: 'gpt-live-1',
    voice: 'coral',
    instructions: 'test',
    inputAudioFormat: 'audio/pcmu',
    inputAudioRate: 8000,
    outputAudioFormat: 'audio/pcmu',
    outputAudioRate: 8000
};

test('disabled adapter refuses to start — no silent reconnect loop (FAULT-010)', async () => {
    const adapter = new LiveAdapter({ enabled: false, model: 'gpt-live-1' });
    const result = await adapter.start(config);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'live_disabled');
});

test('model mismatch is a config error, not an auto-correction', async () => {
    const adapter = new LiveAdapter({ enabled: true, model: 'gpt-live-1' });
    const result = await adapter.start({ ...config, model: 'something-else' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'live_model_unconfigured');
});

test('enabled adapter reports structured unavailability — real API is BLOCKED', async () => {
    const adapter = new LiveAdapter({ enabled: true, model: 'gpt-live-1' });
    const result = await adapter.start(config);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'live_api_not_verified');
    // Never retryable in-process: a failed start falls back to realtime once,
    // at the orchestrator level — no silent loop here.
    assert.equal(result.retryable, false);
});

test('audio contract matches the Twilio μ-law passthrough', () => {
    const adapter = new LiveAdapter({ enabled: true, model: 'gpt-live-1' });
    assert.deepEqual(adapter.describeAudioContract(), { format: 'audio/pcmu', rateHz: 8000 });
});

test('Live wire event names are distinct constants, not Realtime names', () => {
    assert.notEqual(LIVE_EVENTS.inputAudioAppend, 'input_audio_buffer.append');
    assert.equal(LIVE_EVENTS.delegationCreated, 'session.delegation.created');
    assert.equal(LIVE_EVENTS.commentaryAppend, 'session.commentary.append');
});
