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

test('Realtime tool flow combines callback phone fragments across interrupted turns', () => {
    const state = {};
    const validationEvents = [];

    for (const [callId, heardPhoneNumber] of [
        ['phone_fragment_1', '090'],
        ['phone_fragment_2', '1234'],
        ['phone_fragment_3', '5678']
    ]) {
        const result = handleRealtimeToolCalls({
            event: toolEvent('validate_callback_phone', callId, { heard_phone_number: heardPhoneNumber }),
            state,
            callEndConfig: buildCallEndConfig(),
            onPhoneValidation: (metadata) => validationEvents.push(metadata)
        });
        const output = JSON.parse(result.outputs[0].item.output);

        if (callId !== 'phone_fragment_3') {
            assert.equal(output.valid, false);
        } else {
            assert.equal(output.valid, true);
            assert.equal(output.normalizedPhoneNumber, '09012345678');
        }
    }

    assert.equal(state.callbackPhone.valid, true);
    assert.equal(state.callbackPhoneCapture, undefined);
    assert.deepEqual(validationEvents.map((event) => event.captureAction), [
        'buffered_fragment',
        'buffered_fragment',
        'combined_fragments'
    ]);
});

test('Realtime tool flow reports safe metadata for an over-expanded phone argument', () => {
    const validationEvents = [];
    const result = handleRealtimeToolCalls({
        event: toolEvent('validate_callback_phone', 'phone_repeated', {
            heard_phone_number: '0901234567809012345678'
        }),
        state: {},
        callEndConfig: buildCallEndConfig(),
        onPhoneValidation: (metadata) => validationEvents.push(metadata)
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(output.valid, true);
    assert.equal(output.normalizedPhoneNumber, '09012345678');
    assert.deepEqual(validationEvents[0], {
        callId: 'phone_repeated',
        reason: 'valid',
        rawReason: 'too_long',
        captureAction: 'recovered_repeated',
        inputChars: 22,
        inputDigits: 22,
        candidateCount: 1,
        bufferedDigits: 0,
        valid: true
    });
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

test('Realtime tool flow routes payment disputes to general even if model requests contract', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('transfer_to_human', 'handoff_payment_1', {
            reason: '業務委託費の支払い差額',
            destination: 'contract'
        }),
        state: {
            turns: [{ role: 'user', text: '私に払った業務委託費が1万円ほど足りなかったので、現状を確認したいです。' }]
        },
        callEndConfig: buildCallEndConfig(),
        handoffConfig: {
            enabled: true,
            numbers: ['+819012345678', '+817085611659'],
            destinationNumbers: { contract: '+819012345678', general: '+817085611659' },
            enforceRoutingPolicy: true
        },
        allowComplexComplaintHandoff: true
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.deepEqual(result.handoffRequests, [{
        callId: 'handoff_payment_1',
        reason: '業務委託費の支払い差額',
        destination: 'general'
    }]);
    assert.equal(output.destination, 'general');
});

test('Realtime tool flow blocks complaint transfer until complex model approval', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('transfer_to_human', 'handoff_payment_blocked', {
            reason: '支払い差額の相談',
            destination: 'general'
        }),
        state: {
            turns: [{ role: 'user', text: '業務委託費が1万円足りないので確認したいです。' }]
        },
        callEndConfig: buildCallEndConfig(),
        handoffConfig: {
            enabled: true,
            numbers: ['+819012345678', '+817085611659'],
            destinationNumbers: { contract: '+819012345678', general: '+817085611659' },
            enforceRoutingPolicy: true
        }
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.deepEqual(result.handoffRequests, []);
    assert.equal(output.reason, 'non_urgent_general_handoff');
});

test('Realtime tool flow keeps harassment in AI handling even after complex escalation', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('transfer_to_human', 'handoff_harassment_blocked', {
            reason: '責任者対応',
            destination: 'general'
        }),
        state: {
            turns: [{ role: 'user', text: 'ふざけるな。脅迫だ。責任者を出せ。' }]
        },
        callEndConfig: buildCallEndConfig(),
        handoffConfig: {
            enabled: true,
            numbers: ['+817085611659'],
            destinationNumbers: { contract: '', general: '+817085611659' },
            enforceRoutingPolicy: true
        },
        allowComplexComplaintHandoff: true
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.deepEqual(result.handoffRequests, []);
    assert.equal(output.reason, 'customer_harassment_ai_handling');
});

test('Realtime tool flow blocks human transfer for non-handoff business calls', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('transfer_to_human', 'handoff_sales_1', {
            reason: '採用支援サービスの営業提案',
            destination: 'general'
        }),
        state: {},
        callEndConfig: buildCallEndConfig(),
        handoffConfig: {
            enabled: true,
            numbers: ['+819012345678'],
            blockNonHandoffBusiness: true
        }
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(result.handled, true);
    assert.deepEqual(result.handoffRequests, []);
    assert.equal(output.ok, false);
    assert.equal(output.reason, 'non_handoff_business_call');
    assert.match(output.instruction, /担当者へ報告/);
    assert.doesNotMatch(output.instruction, /営業|採用|緊急性/);
});

test('Realtime tool flow requires a contact number before closing a business call', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('finish_reception', 'finish_sales_1', {
            reason: '営業提案の報告完了',
            callback_required: false
        }),
        state: {},
        callEndConfig: buildCallEndConfig(),
        handoffConfig: { requireCallbackContact: true }
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(result.handled, true);
    assert.equal(output.ok, false);
    assert.equal(output.reason, 'business_callback_contact_not_validated');
    assert.deepEqual(result.callEndRequests, []);
});

test('Realtime tool flow requires callback_required for non-sales non-urgent business calls', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('finish_reception', 'finish_event_1', {
            reason: 'イベント相談の受付完了',
            callback_required: false
        }),
        state: {
            callbackPhone: {
                valid: true,
                normalizedPhoneNumber: '09012345678'
            }
        },
        callEndConfig: buildCallEndConfig(),
        handoffConfig: {
            requireCallbackContact: true,
            requireBusinessCallback: true
        }
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(result.handled, true);
    assert.equal(output.ok, false);
    assert.equal(output.reason, 'business_callback_required');
    assert.deepEqual(result.callEndRequests, []);
});

test('Realtime tool flow allows sales call without callback when contact is validated', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('finish_reception', 'finish_sales_2', {
            reason: '営業提案の報告完了',
            callback_required: false
        }),
        state: {
            callbackPhone: {
                valid: true,
                normalizedPhoneNumber: '09012345678'
            }
        },
        callEndConfig: buildCallEndConfig(),
        handoffConfig: { requireCallbackContact: true }
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(output.ok, true);
    assert.equal(output.callback_required, false);
    assert.equal(result.callEndRequests.length, 1);
});

test('Realtime tool flow blocks non-urgent general handoff', () => {
    const result = handleRealtimeToolCalls({
        event: toolEvent('transfer_to_human', 'handoff_event_1', {
            reason: 'イベント開催の相談',
            destination: 'general'
        }),
        state: {
            turns: [{ role: 'user', text: 'エンジニアを集めたイベントを開催したい相談です。' }]
        },
        callEndConfig: buildCallEndConfig(),
        handoffConfig: {
            enabled: true,
            numbers: ['+819012345678'],
            enforceRoutingPolicy: true
        }
    });
    const output = JSON.parse(result.outputs[0].item.output);

    assert.equal(result.handled, true);
    assert.deepEqual(result.handoffRequests, []);
    assert.equal(output.reason, 'non_urgent_general_handoff');
});
