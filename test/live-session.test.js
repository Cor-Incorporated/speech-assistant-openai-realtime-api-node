import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLiveSessionStart,
    classifyLiveEvent,
    createLiveAudioCodec,
    createLiveDelegationTracker,
    liveAudioAppend,
    liveItemCreate,
    liveResponseCreate,
    liveSessionClose,
    mulawDecodeSample,
    mulawEncodeSample,
    mulawToPcm16,
    pcm16ToMulaw,
    toLiveToolResultItem,
    toRealtimeDoneEvent
} from '../lib/live-session.js';

describe('live-session helpers', () => {
    describe('G.711 μ-law codec', () => {
        it('decodes μ-law silence to near-zero PCM', () => {
            assert.equal(mulawDecodeSample(0xFF), 0);
        });

        it('encode/decode roundtrip stays within quantization error', () => {
            for (const sample of [0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]) {
                const decoded = mulawDecodeSample(mulawEncodeSample(sample));
                const tolerance = Math.max(132, Math.abs(sample) * 0.1);
                assert.ok(Math.abs(decoded - sample) <= tolerance, `${sample} -> ${decoded}`);
            }
        });

        it('converts buffers both directions', () => {
            const mulaw = Buffer.from([0xFF, 0xFF, 0x7F, 0x00]);
            const pcm = mulawToPcm16(mulaw);
            assert.equal(pcm.length, 8);
            const back = pcm16ToMulaw(pcm);
            assert.equal(back.length, 4);
            assert.equal(back[0], 0xFF);
        });
    });

    describe('audio codec passthrough', () => {
        it('passes μ-law through unchanged at pcmu/8000', () => {
            const codec = createLiveAudioCodec({ inputFormatType: 'audio/pcmu', inputRate: 8000 });
            assert.equal(codec.passthrough, true);
            const payload = Buffer.from([0xFF, 0x7F]).toString('base64');
            assert.equal(codec.encodeInput(payload), payload);
            assert.equal(codec.decodeOutput(payload), payload);
        });

        it('converts μ-law to PCM16 for pcm input format', () => {
            const codec = createLiveAudioCodec({ inputFormatType: 'audio/pcm', inputRate: 8000 });
            assert.equal(codec.passthrough, false);
            const encoded = codec.encodeInput(Buffer.from([0xFF, 0xFF]).toString('base64'));
            const pcm = Buffer.from(encoded, 'base64');
            assert.equal(pcm.length, 4);
            assert.equal(pcm.readInt16LE(0), 0);
        });
    });

    describe('buildLiveSessionStart', () => {
        it('builds a session.start payload with delegation and audio format', () => {
            const start = buildLiveSessionStart({
                model: 'gpt-live-1',
                voice: 'marin',
                audioFormatType: 'audio/pcmu',
                audioRate: 8000,
                instructions: 'inst',
                delegationResponses: {
                    model: 'gpt-5.6-luna',
                    instructions: 'backend',
                    tools: [{ type: 'function', name: 'finish_reception' }],
                    tool_choice: 'auto'
                }
            });
            assert.equal(start.type, 'session.start');
            assert.equal(start.session.model, 'gpt-live-1');
            assert.equal(start.session.audio.format.type, 'audio/pcmu');
            assert.equal(start.session.audio.format.rate, 8000);
            assert.equal(start.session.audio.output.voice, 'marin');
            assert.equal(start.session.delegation.type, 'responses');
            assert.equal(start.session.delegation.responses.model, 'gpt-5.6-luna');
            assert.equal(start.session.delegation.responses.tool_choice, 'auto');
        });

        it('omits delegation when not configured', () => {
            const start = buildLiveSessionStart({
                model: 'gpt-live-1',
                voice: 'marin',
                audioFormatType: 'audio/pcm',
                audioRate: 24000,
                instructions: 'inst',
                delegationResponses: null
            });
            assert.equal(start.session.delegation, undefined);
        });
    });

    describe('classifyLiveEvent', () => {
        it('classifies the main event kinds', () => {
            assert.equal(classifyLiveEvent({ type: 'session.started' }).kind, 'started');
            assert.equal(classifyLiveEvent({ type: 'session.closed' }).kind, 'closed');
            assert.equal(classifyLiveEvent({ type: 'session.output_audio.delta', delta: 'x' }).kind, 'audio_delta');
            assert.equal(classifyLiveEvent({ type: 'session.input_transcript.delta', delta: 'a' }).kind, 'input_transcript_delta');
            assert.equal(classifyLiveEvent({ type: 'session.output_transcript.delta', delta: 'b' }).kind, 'output_transcript_delta');
            assert.equal(classifyLiveEvent({ type: 'error', error: { message: 'm' } }).kind, 'error');
            assert.equal(classifyLiveEvent({ type: 'session.unknown' }).kind, 'other');
        });

        it('extracts delegation metadata from the nested delegation object', () => {
            const c = classifyLiveEvent({
                type: 'session.delegation.created',
                delegation: { id: 'item_d1', type: 'delegation', response_id: 'resp_r1', target: 'responses' }
            });
            assert.equal(c.kind, 'delegation_created');
            assert.equal(c.delegationId, 'item_d1');
            assert.equal(c.responseId, 'resp_r1');
            assert.equal(c.target, 'responses');
        });

        it('unwraps response.event envelopes', () => {
            const c = classifyLiveEvent({
                type: 'response.event',
                delegation_id: 'd1',
                event: { type: 'response.output_item.done', item: { type: 'function_call' } }
            });
            assert.equal(c.kind, 'response_event');
            assert.equal(c.delegationId, 'd1');
            assert.equal(c.nested.type, 'response.output_item.done');
        });
    });

    describe('delegation tracker', () => {
        // Real wire shape observed 2026-09-18: nested output_item.done events
        // carry no response_id; the envelope delegation_id scopes them.
        it('collects function calls across nested events and returns them on completion', () => {
            const tracker = createLiveDelegationTracker();
            tracker.observeResponseEvent('item_d1', { type: 'response.created', response: { id: 'r1' } });
            tracker.observeResponseEvent('item_d1', {
                type: 'response.output_item.done',
                item: { type: 'function_call', call_id: 'call_1', name: 'finish_reception', arguments: '{"reason":"done","callback_required":false}' }
            });
            tracker.observeResponseEvent('item_d1', {
                type: 'response.output_item.done',
                item: { type: 'message', content: [] }
            });
            const done = tracker.observeResponseEvent('item_d1', {
                type: 'response.completed',
                response: { id: 'r1', output: [] }
            });
            assert.equal(done.responseId, 'r1');
            assert.equal(done.calls.length, 1);
            assert.equal(done.calls[0].name, 'finish_reception');
            assert.equal(done.calls[0].call_id, 'call_1');
        });

        it('does not treat an empty terminal output list as no pending calls', () => {
            const tracker = createLiveDelegationTracker();
            tracker.observeResponseEvent('item_d1', { type: 'response.created', response: { id: 'r2' } });
            tracker.observeResponseEvent('item_d1', {
                type: 'response.output_item.done',
                item: { type: 'function_call', call_id: 'call_9', name: 'transfer_to_human', arguments: '{}' }
            });
            const done = tracker.observeResponseEvent('item_d1', {
                type: 'response.completed',
                response: { id: 'r2', output: [] }
            });
            assert.equal(done.calls.length, 1);
        });

        it('returns null for in-progress events and clears after completion', () => {
            const tracker = createLiveDelegationTracker();
            assert.equal(tracker.observeResponseEvent('item_d1', { type: 'response.created', response: { id: 'r3' } }), null);
            assert.equal(tracker.pendingCount(), 1);
            tracker.observeResponseEvent('item_d1', { type: 'response.completed', response: { id: 'r3' } });
            assert.equal(tracker.pendingCount(), 0);
        });

        it('tracks calls for concurrent delegations independently', () => {
            const tracker = createLiveDelegationTracker();
            tracker.observeResponseEvent('d1', { type: 'response.created', response: { id: 'ra' } });
            tracker.observeResponseEvent('d2', { type: 'response.created', response: { id: 'rb' } });
            tracker.observeResponseEvent('d1', {
                type: 'response.output_item.done',
                item: { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' }
            });
            tracker.observeResponseEvent('d2', {
                type: 'response.output_item.done',
                item: { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' }
            });
            const d1Done = tracker.observeResponseEvent('d1', { type: 'response.completed', response: { id: 'ra' } });
            const d2Done = tracker.observeResponseEvent('d2', { type: 'response.completed', response: { id: 'rb' } });
            assert.equal(d1Done.calls[0].name, 'a');
            assert.equal(d2Done.calls[0].name, 'b');
        });
    });

    describe('tool call conversion', () => {
        it('wraps calls in a realtime-shaped response.done event', () => {
            const event = toRealtimeDoneEvent([
                { type: 'function_call', call_id: 'c1', name: 'finish_reception', arguments: '{}' }
            ]);
            assert.equal(event.type, 'response.done');
            assert.equal(event.response.output[0].name, 'finish_reception');
        });

        it('extracts the bare item from conversation.item.create envelopes', () => {
            const item = { type: 'function_call_output', call_id: 'c1', output: '{}' };
            assert.deepEqual(toLiveToolResultItem({ type: 'conversation.item.create', item }), item);
            assert.equal(toLiveToolResultItem({ type: 'other' }), null);
        });

        it('passes through bare function_call_output items unchanged', () => {
            // Regression: the knowledge runtime returns bare output items.
            // Dropping them here leaves the provider call pending and every
            // response.create rejected — 86s of dead air on a real call.
            const item = { type: 'function_call_output', call_id: 'call_1', output: '{"status":"found"}' };
            assert.deepEqual(toLiveToolResultItem(item), item);
            assert.equal(toLiveToolResultItem({ type: 'function_call_output' }), null);
        });
    });

    describe('outbound commands', () => {
        it('builds live protocol command shapes', () => {
            assert.deepEqual(liveAudioAppend('QUJD'), { type: 'session.input_audio.append', audio: 'QUJD' });
            assert.equal(liveItemCreate({ call_id: 'c' }, 'e1').type, 'response.item.create');
            assert.equal(liveResponseCreate('e2').type, 'response.create');
            assert.equal(liveSessionClose('e3').type, 'session.close');
        });
    });
});
