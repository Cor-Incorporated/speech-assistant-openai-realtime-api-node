import assert from 'node:assert/strict';
import test from 'node:test';
import {
    appendCallbackPhoneValidationInstructions,
    buildValidateCallbackPhoneTool,
    extractJapanesePhoneCandidates,
    formatSpokenPhoneDigits,
    findValidateCallbackPhoneToolCalls,
    validateJapaneseCallbackPhoneNumber
} from '../lib/phone-number-validation.js';

test('callback phone validation accepts Japanese domestic numbers', () => {
    const mobile = validateJapaneseCallbackPhoneNumber('090-1234-5678');
    assert.equal(mobile.valid, true);
    assert.equal(mobile.normalizedPhoneNumber, '09012345678');
    assert.equal(mobile.formattedSpokenDigits, '0、9、0、1、2、3、4、5、6、7、8');
    assert.match(mobile.confirmationPrompt, /0、9、0、1、2、3、4、5、6、7、8/);

    const fixedLine = validateJapaneseCallbackPhoneNumber('03 1234 5678');
    assert.equal(fixedLine.valid, true);
    assert.equal(fixedLine.normalizedPhoneNumber, '0312345678');

    const ipPhone = validateJapaneseCallbackPhoneNumber('050 の 1234 の 5678');
    assert.equal(ipPhone.valid, true);
    assert.equal(ipPhone.normalizedPhoneNumber, '05012345678');
});

test('callback phone validation normalizes full-width digits and extracts from transcript text', () => {
    const result = validateJapaneseCallbackPhoneNumber('折り返しは ０８０ー１２３４ー５６７８ でお願いします。');

    assert.equal(result.valid, true);
    assert.equal(result.normalizedInput, '折り返しは 080ー1234ー5678 でお願いします。');
    assert.equal(result.normalizedPhoneNumber, '08012345678');
});

test('callback phone validation converts +81 numbers to domestic form', () => {
    const mobile = validateJapaneseCallbackPhoneNumber('+81 90 1234 5678');
    assert.equal(mobile.valid, true);
    assert.equal(mobile.normalizedPhoneNumber, '09012345678');

    const fixedLineWithOptionalTrunk = validateJapaneseCallbackPhoneNumber('+81 (0)3-1234-5678');
    assert.equal(fixedLineWithOptionalTrunk.valid, true);
    assert.equal(fixedLineWithOptionalTrunk.normalizedPhoneNumber, '0312345678');
});

test('callback phone validation rejects short fragments and non-domestic formats', () => {
    const fragment = validateJapaneseCallbackPhoneNumber('98765311');
    assert.equal(fragment.valid, false);
    assert.equal(fragment.reason, 'too_short');
    assert.match(fragment.clarificationPrompt, /短く/);

    const noDomesticPrefix = validateJapaneseCallbackPhoneNumber('1234567890');
    assert.equal(noDomesticPrefix.valid, false);
    assert.equal(noDomesticPrefix.reason, 'invalid_domestic_number');

    const foreign = validateJapaneseCallbackPhoneNumber('+1 202 555 0199');
    assert.equal(foreign.valid, false);
    assert.equal(foreign.reason, 'unsupported_country_code');
});

test('callback phone validation rejects suspicious or over-expanded numbers', () => {
    const tooLong = validateJapaneseCallbackPhoneNumber('090123456789');
    assert.equal(tooLong.valid, false);
    assert.equal(tooLong.reason, 'too_long');
    assert.match(tooLong.clarificationPrompt, /長く/);

    const placeholder = validateJapaneseCallbackPhoneNumber('01234567890');
    assert.equal(placeholder.valid, false);
    assert.equal(placeholder.reason, 'suspicious_model_expanded_number');

    const repeated = validateJapaneseCallbackPhoneNumber('09000000000');
    assert.equal(repeated.valid, false);
    assert.equal(repeated.reason, 'suspicious_model_expanded_number');
});

test('callback phone validation asks for clarification when multiple phone numbers are heard', () => {
    const result = validateJapaneseCallbackPhoneNumber('090-1234-5678 または 080-1111-2222');

    assert.equal(result.valid, false);
    assert.equal(result.reason, 'multiple_candidates');
    assert.match(result.clarificationPrompt, /複数/);
});

test('callback phone helper exposes candidate extraction and spoken digit formatting', () => {
    assert.deepEqual(
        extractJapanesePhoneCandidates('番号は+81 90 1234 5678です。内線は123です。'),
        ['+81 90 1234 5678']
    );
    assert.equal(formatSpokenPhoneDigits('090-1234-5678'), '0、9、0、1、2、3、4、5、6、7、8');
});

test('callback phone validation exposes Realtime tool schema and instructions', () => {
    const tool = buildValidateCallbackPhoneTool();
    const instructions = appendCallbackPhoneValidationInstructions('base prompt');

    assert.equal(tool.name, 'validate_callback_phone');
    assert.deepEqual(tool.parameters.required, ['heard_phone_number']);
    assert.match(instructions, /validate_callback_phone/);
    assert.match(instructions, /補完してはいけません/);
});

test('callback phone validation extracts Realtime tool calls', () => {
    const event = {
        response: {
            output: [{
                type: 'function_call',
                name: 'validate_callback_phone',
                call_id: 'call_phone_1',
                arguments: JSON.stringify({
                    heard_phone_number: '０９０ー１２３４ー５６７８'
                })
            }]
        }
    };

    assert.deepEqual(findValidateCallbackPhoneToolCalls(event), [{
        callId: 'call_phone_1',
        heardPhoneNumber: '０９０ー１２３４ー５６７８'
    }]);
});
