import assert from 'node:assert/strict';
import test from 'node:test';
import {
    RealtimeAdapter,
    realtimeMessageToVoiceEvents
} from '../dist-backend/voice/realtime-adapter.js';

test('response.done surfaces tool calls as provider-agnostic events', () => {
    const events = realtimeMessageToVoiceEvents({
        type: 'response.done',
        response: {
            output: [
                {
                    type: 'function_call',
                    name: 'finish_reception',
                    call_id: 'call_1',
                    arguments: '{"reason":"x","callback_required":true}'
                },
                { type: 'message', role: 'assistant' }
            ]
        }
    });

    assert.equal(events[0].type, 'assistant_turn_completed');
    const toolCall = events.find((event) => event.type === 'tool_call');
    assert.equal(toolCall.call.callId, 'call_1');
    assert.equal(toolCall.call.name, 'finish_reception');
});

test('audio deltas map both GA and legacy names', () => {
    for (const type of ['response.output_audio.delta', 'response.audio.delta']) {
        const events = realtimeMessageToVoiceEvents({ type, delta: 'QUJD' });
        assert.equal(events[0].type, 'assistant_audio_delta');
        assert.equal(events[0].audioBase64, 'QUJD');
    }
});

test('speech lifecycle maps to user_speech events', () => {
    assert.equal(
        realtimeMessageToVoiceEvents({ type: 'input_audio_buffer.speech_started' })[0].type,
        'user_speech_started'
    );
    assert.equal(
        realtimeMessageToVoiceEvents({ type: 'input_audio_buffer.speech_stopped' })[0].type,
        'user_speech_stopped'
    );
});

test('transcription completion produces a completed user turn', () => {
    const events = realtimeMessageToVoiceEvents({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '営業時間を教えてください'
    });
    assert.equal(events[0].type, 'user_transcript_completed');
    assert.equal(events[0].text, '営業時間を教えてください');
});

test('unknown message types map to nothing — counted, not crashed', () => {
    assert.deepEqual(realtimeMessageToVoiceEvents({ type: 'rate_limits.updated' }), []);
    assert.deepEqual(realtimeMessageToVoiceEvents('garbage'), []);
    assert.deepEqual(realtimeMessageToVoiceEvents(null), []);
});

test('malformed tool calls are skipped without losing the turn boundary', () => {
    const events = realtimeMessageToVoiceEvents({
        type: 'response.done',
        response: {
            output: [
                { type: 'function_call', name: 'finish_reception' },  // no call_id
                { type: 'function_call', name: 'x', call_id: 'c2', arguments: 42 }
            ]
        }
    });

    const calls = events.filter((event) => event.type === 'tool_call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].call.callId, 'c2');
    assert.equal(calls[0].call.rawArguments, '');
});

test('adapter dispatches events to its handler', () => {
    const adapter = new RealtimeAdapter();
    const received = [];
    adapter.onEvent((event) => received.push(event));

    adapter.dispatch({ type: 'input_audio_buffer.speech_started' });
    assert.equal(received[0].type, 'user_speech_started');
});
