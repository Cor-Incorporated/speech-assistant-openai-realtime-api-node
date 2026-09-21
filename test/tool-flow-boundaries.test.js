import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleRealtimeToolCalls } from '../lib/realtime-tool-flow.js';

const fnCall = (name, callId, args = {}) => ({
    type: 'function_call',
    name,
    call_id: callId,
    arguments: JSON.stringify(args)
});

const doneEvent = (output, status = 'completed') => ({
    type: 'response.done',
    response: { status, output }
});

const baseArgs = (overrides = {}) => ({
    state: { turns: [] },
    callEndConfig: { finalPhrase: '本日はお電話ありがとうございました。' },
    handoffConfig: { enabled: false, numbers: [] },
    ...overrides
});

const run = (event, overrides = {}) => handleRealtimeToolCalls({ event, ...baseArgs(overrides) });

describe('F05 — tool call boundaries', () => {
    it('processes all categories in one pass instead of returning after the first', () => {
        const event = doneEvent([
            fnCall('validate_callback_phone', 'call_phone_1', { heard_phone_number: '09012345678' }),
            fnCall('finish_reception', 'call_finish_1', { reason: 'done', callback_required: false })
        ]);
        const result = run(event, {
            state: {
                turns: [],
                callbackPhone: { valid: true, confirmed: true, normalizedPhoneNumber: '+819012345678' }
            }
        });
        assert.equal(result.handled, true);
        // Both calls produced outputs — the second category is not dropped.
        const callIds = result.outputs.map((o) => o.item.call_id);
        assert.ok(callIds.includes('call_phone_1'));
        assert.ok(callIds.includes('call_finish_1'));
        assert.equal(result.callEndRequests.length, 1);
    });

    it('emits at most one output per call_id', () => {
        const dup = fnCall('validate_callback_phone', 'call_dup', { heard_phone_number: '09012345678' });
        const event = doneEvent([dup, { ...dup }]);
        const result = run(event);
        const outputs = result.outputs.filter((o) => o.item.call_id === 'call_dup');
        assert.equal(outputs.length, 1);
    });

    it('suppresses side effects from a failed/incomplete response', () => {
        for (const status of ['failed', 'incomplete', 'cancelled']) {
            const event = doneEvent([
                fnCall('finish_reception', 'call_f', { reason: 'done', callback_required: false }),
                fnCall('transfer_to_human', 'call_h', { reason: 'x', destination: 'general' })
            ], status);
            const result = run(event, {
                handoffConfig: { enabled: true, numbers: ['+819000000000'], destinationNumbers: { general: '+819000000000' }, enforceRoutingPolicy: false }
            });
            assert.equal(result.callEndRequests.length, 0, `status=${status} must not end calls`);
            assert.equal(result.handoffRequests.length, 0, `status=${status} must not transfer`);
            // The calls still get outputs so the model can retry.
            const finish = result.outputs.find((o) => o.item.call_id === 'call_f');
            assert.equal(JSON.parse(finish.item.output).reason, 'response_not_completed');
        }
    });

    it('executes side effects only for a completed response', () => {
        const event = doneEvent([
            fnCall('finish_reception', 'call_ok', { reason: 'done', callback_required: false })
        ], 'completed');
        const result = run(event);
        assert.equal(result.callEndRequests.length, 1);
    });
});
