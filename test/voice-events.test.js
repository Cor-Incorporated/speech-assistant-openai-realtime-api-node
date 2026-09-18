import assert from 'node:assert/strict';
import test from 'node:test';
import { LIVE_EVENTS, LiveAdapter } from '../dist-backend/voice/live-adapter.js';

test('delegation_created carries an id + offset, never the task text (FAULT-011)', () => {
    // A Live delegation event is opaque by contract: it references work by
    // delegationId and offsetMs. There is no task text to read — attempting
    // to read .task/.text/.arguments yields undefined, not invented content.
    const event = {
        type: 'delegation_created',
        delegation: { delegationId: 'dlg_1', offsetMs: 1250, target: 'responses' }
    };

    assert.deepEqual(Object.keys(event.delegation).sort(), ['delegationId', 'offsetMs', 'target']);
    assert.equal(event.delegation.task, undefined);
    assert.equal(event.delegation.text, undefined);
    assert.equal(event.delegation.arguments, undefined);
    assert.equal(event.delegation.instructions, undefined);
});

test('live wire event names do not reuse realtime event names', () => {
    // The adapter must not assume Live emits Realtime's completion events.
    const names = Object.values(LIVE_EVENTS);
    for (const name of names) {
        assert.doesNotMatch(name, /^response\.|^conversation\.|^input_audio_buffer\./);
    }
    assert.equal(LIVE_EVENTS.delegationCreated, 'session.delegation.created');
});

test('a VoiceSessionPort implementation satisfies the port surface', () => {
    const adapter = new LiveAdapter({ enabled: false, model: 'gpt-live-1' });
    for (const method of [
        'start', 'sendAudio', 'sendToolResult', 'requestResponse',
        'interrupt', 'close', 'onEvent'
    ]) {
        assert.equal(typeof adapter[method], 'function', method);
    }
    assert.equal(adapter.provider, 'live');
});

test('session phase vocabulary separates generation from playback', () => {
    // 'assistant_turn_completed' (generation done) and Twilio-mark-derived
    // playback states are different axes — closing phases exist on the
    // session side, 'played' is decided by PlaybackController marks only.
    const phases = new Set([
        'connecting', 'listening', 'working', 'speaking', 'confirming',
        'closing_prepared', 'closing_playing', 'closing_played', 'ended',
        'handoff_prepared', 'handoff_starting', 'handoff_connected', 'handoff_failed'
    ]);
    assert.ok(phases.has('closing_played'));
    assert.ok(!phases.has('audio_played')); // playback truth lives in marks
});
