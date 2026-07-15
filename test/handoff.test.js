import assert from 'node:assert/strict';
import test from 'node:test';
import {
    appendHandoffInstructions,
    buildHandoffConfig,
    buildTransferToHumanTool,
    findTransferToHumanToolCalls,
    HandoffContextStore,
    shouldAutoHandoffGeneral,
    summarizeHandoffTurns,
    updateTwilioCallTwiml
} from '../lib/handoff.js';

test('handoff configuration normalizes numbers and stays disabled by default', () => {
    const disabled = buildHandoffConfig();
    const enabled = buildHandoffConfig({
        HANDOFF_ENABLED: 'true',
        HANDOFF_NUMBERS: ' +819012345678, +818012345678 '
    });

    assert.equal(disabled.enabled, false);
    assert.equal(enabled.enabled, true);
    assert.deepEqual(enabled.numbers, ['+819012345678', '+818012345678']);
    assert.deepEqual(enabled.destinationNumbers, {
        contract: '+819012345678',
        general: '+818012345678'
    });
    assert.equal(buildTransferToHumanTool(disabled), null);
    assert.equal(buildTransferToHumanTool(enabled).name, 'transfer_to_human');
    assert.match(appendHandoffInstructions('base', enabled), /transfer_to_human/);
});

test('handoff configuration routes JSON destinations independently', () => {
    const config = buildHandoffConfig({
        HANDOFF_ENABLED: 'true',
        HANDOFF_NUMBERS: JSON.stringify({ contract: '+819010869492', general: '+817085611659' })
    });

    assert.deepEqual(config.numbers, ['+819010869492', '+817085611659']);
    assert.equal(config.destinationNumbers.contract, '+819010869492');
    assert.equal(config.destinationNumbers.general, '+817085611659');
});

test('handoff tool calls extract a safe reason', () => {
    const result = findTransferToHumanToolCalls({
        response: {
            output: [{
                type: 'function_call',
                name: 'transfer_to_human',
                call_id: 'handoff_1',
                arguments: JSON.stringify({ reason: '受託案件の相談', destination: 'contract' })
            }]
        }
    });

    assert.deepEqual(result, [{
        callId: 'handoff_1',
        reason: '受託案件の相談',
        destination: 'contract'
    }]);
});

test('handoff summary uses recent turns and caps its length', () => {
    const summary = summarizeHandoffTurns([
        { role: 'user', text: '最初の発話' },
        { role: 'agent', text: '確認します' },
        { role: 'user', text: '担当者に相談したいです' }
    ]);

    assert.match(summary, /発信者/);
    assert.match(summary, /担当者に相談したいです/);
    assert.ok(summary.length < 700);
});

test('handoff auto-detects billing disputes and representative requests', () => {
    assert.equal(shouldAutoHandoffGeneral([
        { role: 'user', text: '以前の取引について、支払った料金が足りなかったので相談したいです。' }
    ]), true);
    assert.equal(shouldAutoHandoffGeneral([
        { role: 'user', text: '代表の方に直接相談したいです。' }
    ]), true);
    assert.equal(shouldAutoHandoffGeneral([
        { role: 'user', text: '採用について質問があります。' }
    ]), false);
});

test('Twilio call update sends TwiML with basic authentication', async () => {
    let request;
    const result = await updateTwilioCallTwiml({
        accountSid: 'AC1234567890abcdef1234567890ABCDEF',
        callSid: 'CA1234567890abcdef1234567890ABCDEF',
        authToken: 'auth-token',
        twiml: '<Response><Hangup /></Response>',
        fetchImpl: async (...args) => {
            request = args;
            return { ok: true, status: 200 };
        }
    });

    assert.equal(result.ok, true);
    assert.match(request[0], /Calls\/CA1234567890abcdef1234567890ABCDEF\.json$/);
    assert.equal(request[1].method, 'POST');
    assert.match(request[1].headers.Authorization, /^Basic /);
    assert.equal(request[1].body.get('Twiml'), '<Response><Hangup /></Response>');
});

test('handoff context store supports in-memory UAT mode', async () => {
    const store = new HandoffContextStore({ firestoreEnabled: false });
    await store.save('CA_TEST', { summary: '資料請求', status: 'requested' });
    await store.update('CA_TEST', { status: 'connected' });

    assert.deepEqual(await store.get('CA_TEST'), {
        callSid: 'CA_TEST',
        summary: '資料請求',
        status: 'connected',
        updatedAt: (await store.get('CA_TEST')).updatedAt
    });
});
