import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseFinishReceptionArgs,
    parseToolArguments,
    parseTransferToHumanArgs,
    parseValidateCallbackPhoneArgs
} from '../dist-backend/contracts/tool-arguments.js';

test('finish_reception: string "false" for callback_required is rejected (FAULT-006)', () => {
    const result = parseFinishReceptionArgs(JSON.stringify({
        reason: '合成試験',
        callback_required: 'false'
    }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_callback_required_type');
});

test('finish_reception: real boolean accepted', () => {
    const result = parseFinishReceptionArgs(JSON.stringify({
        reason: '受付完了',
        callback_required: false
    }));

    assert.equal(result.ok, true);
    assert.equal(result.value.callbackRequired, false);
});

test('finish_reception: rejects malformed JSON and non-objects', () => {
    assert.equal(parseFinishReceptionArgs('{broken').reason, 'invalid_json');
    assert.equal(parseFinishReceptionArgs('[]').reason, 'arguments_not_object');
    assert.equal(parseFinishReceptionArgs(42).reason, 'arguments_not_string');
});

test('finish_reception: unexpected properties are rejected', () => {
    const result = parseFinishReceptionArgs(JSON.stringify({
        reason: 'x',
        callback_required: true,
        stealth: 'payload'
    }));

    assert.equal(result.ok, false);
    assert.match(result.reason, /unexpected_properties:stealth/);
});

test('transfer_to_human: unlisted destination is rejected, never normalized to general (FAULT-007)', () => {
    const result = parseTransferToHumanArgs(JSON.stringify({
        reason: '合成試験',
        destination: 'unlisted'
    }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_destination');
});

test('transfer_to_human: enum destinations accepted', () => {
    for (const destination of ['contract', 'general']) {
        const result = parseTransferToHumanArgs(JSON.stringify({ reason: 'r', destination }));
        assert.equal(result.ok, true);
        assert.equal(result.value.destination, destination);
    }
});

test('validate_callback_phone: requires a non-empty string', () => {
    assert.equal(parseValidateCallbackPhoneArgs(JSON.stringify({})).reason, 'invalid_heard_phone_number_type');
    assert.equal(parseValidateCallbackPhoneArgs(JSON.stringify({ heard_phone_number: '  ' })).reason, 'empty_heard_phone_number');

    const result = parseValidateCallbackPhoneArgs(JSON.stringify({ heard_phone_number: '０９０ー１２３４' }));
    assert.equal(result.ok, true);
    assert.equal(result.value.heardPhoneNumber, '０９０ー１２３４');
});

test('parseToolArguments: oversized payloads refused', () => {
    const result = parseToolArguments(`{"a":"${'x'.repeat(9000)}"}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'arguments_too_large');
});
