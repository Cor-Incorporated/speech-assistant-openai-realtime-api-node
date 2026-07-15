import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCallEndConfig } from '../lib/realtime-call-end.js';
import { handleRealtimeToolCalls } from '../lib/realtime-tool-flow.js';

const toolEvent = (name, callId, args) => ({
    response: {
        output: [{
            type: 'function_call',
            name,
            call_id: callId,
            arguments: JSON.stringify(args)
        }]
    }
});

test('Realtime tool flow validates callback phone before assistant confirmation', () => {
    const state = {};
    const result = handleRealtimeToolCalls({
        event: toolEvent('validate_callback_phone', 'phone_1', {
            heard_phone_number: '０９０ー１２３４ー５６７８'
        }),
        state,
        callEndConfig: buildCallEndConfig()
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(result.handled, true);
    assert.equal(result.responseReason, 'validate_callback_phone_tool_output');
    assert.equal(output.valid, true);
    assert.equal(output.normalizedPhoneNumber, '09012345678');
    assert.match(output.confirmationPrompt, /0、9、0/);
    assert.equal(state.callbackPhone.valid, true);
});

test('Realtime tool flow rejects invalid callback phone fragments', () => {
    const state = {};
    const result = handleRealtimeToolCalls({
        event: toolEvent('validate_callback_phone', 'phone_1', {
            heard_phone_number: '98765311'
        }),
        state,
        callEndConfig: buildCallEndConfig()
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(output.valid, false);
    assert.equal(output.reason, 'too_short');
    assert.match(output.clarificationPrompt, /短く/);
    assert.equal(state.callbackPhone.valid, false);
});

test('Realtime tool flow blocks finish_reception until callback phone is validated', () => {
    const state = {};
    const result = handleRealtimeToolCalls({
        event: toolEvent('finish_reception', 'finish_1', {
            reason: '受付完了',
            callback_required: true
        }),
        state,
        callEndConfig: buildCallEndConfig()
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(result.handled, true);
    assert.equal(result.responseReason, 'finish_reception_tool_output');
    assert.equal(output.ok, false);
    assert.equal(output.reason, 'callback_phone_not_validated');
    assert.deepEqual(result.callEndRequests, []);
});

test('Realtime tool flow allows finish_reception after callback phone validation', () => {
    const state = {
        callbackPhone: {
            valid: true,
            normalizedPhoneNumber: '09012345678'
        }
    };
    const result = handleRealtimeToolCalls({
        event: toolEvent('finish_reception', 'finish_1', {
            reason: '折り返し受付完了',
            callback_required: true
        }),
        state,
        callEndConfig: buildCallEndConfig({
            CALL_END_FINAL_PHRASE: 'お電話をお切りいただいて大丈夫です。'
        })
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(output.ok, true);
    assert.equal(output.final_phrase, 'お電話をお切りいただいて大丈夫です。');
    assert.deepEqual(result.callEndRequests, [{
        source: 'realtime_tool',
        reason: '折り返し受付完了'
    }]);
});

test('Realtime tool flow emits a handoff request only when enabled with recipients', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('transfer_to_human', 'handoff_1', {
            reason: '受託案件の相談',
            destination: 'contract'
        }),
        state: {},
        callEndConfig: buildCallEndConfig(),
        handoffConfig: {
            enabled: true,
            numbers: ['+819012345678'],
            destinationNumbers: { contract: '+819012345678', general: '+817085611659' }
        }
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(result.handled, true);
    assert.equal(result.responseReason, 'transfer_to_human_tool_output');
    assert.deepEqual(result.handoffRequests, [{
        callId: 'handoff_1',
        reason: '受託案件の相談',
        destination: 'contract'
    }]);
    assert.equal(output.status, 'starting');
    assert.equal(output.destination, 'contract');
});
