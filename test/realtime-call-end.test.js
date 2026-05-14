import assert from 'node:assert/strict';
import test from 'node:test';
import {
    appendCallEndInstructions,
    buildCallEndConfig,
    buildFinishReceptionTool,
    findFinishReceptionToolCalls,
    isTerminalAgentMessage,
    updateTwilioCallStatus
} from '../lib/realtime-call-end.js';

test('call end config appends explicit closing instructions and tool schema', () => {
    const config = buildCallEndConfig({
        CALL_END_FINAL_PHRASE: 'お切りいただいて大丈夫です。'
    });
    const instructions = appendCallEndInstructions('base prompt', config);
    const tool = buildFinishReceptionTool(config);

    assert.match(instructions, /finish_reception/);
    assert.match(instructions, /お切りいただいて大丈夫です。/);
    assert.equal(tool.name, 'finish_reception');
    assert.equal(tool.parameters.required.includes('reason'), true);
    assert.equal(tool.parameters.required.includes('callback_required'), true);
});

test('call end helpers detect terminal phrase and finish_reception tool calls', () => {
    const config = buildCallEndConfig({
        CALL_END_FINAL_PHRASE: 'このあとお電話をお切りいただいて大丈夫です。失礼いたします。'
    });
    const event = {
        response: {
            output: [{
                type: 'function_call',
                name: 'finish_reception',
                call_id: 'call_123',
                arguments: JSON.stringify({
                    reason: '折り返し案内まで完了',
                    callback_required: true
                })
            }]
        }
    };

    assert.equal(
        isTerminalAgentMessage('担当より折り返します。このあとお電話をお切りいただいて大丈夫です。失礼いたします。', config),
        true
    );
    assert.deepEqual(findFinishReceptionToolCalls(event), [{
        callId: 'call_123',
        reason: '折り返し案内まで完了',
        callbackRequired: true
    }]);
});

test('Twilio call status update posts completed status with basic auth', async () => {
    const accountSid = 'AC1234567890abcdef1234567890ABCDEF';
    const callSid = 'CA1234567890abcdef1234567890ABCDEF';
    const requests = [];
    const fetchImpl = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200
        };
    };

    const result = await updateTwilioCallStatus({
        accountSid,
        callSid,
        authToken: 'auth-token',
        fetchImpl
    });

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(
        requests[0].url,
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`
    );
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.body.get('Status'), 'completed');
    assert.equal(
        requests[0].options.headers.Authorization,
        `Basic ${Buffer.from(`${accountSid}:auth-token`).toString('base64')}`
    );
});

test('Twilio call status update skips invalid or unauthenticated calls', async () => {
    const invalidCall = await updateTwilioCallStatus({
        accountSid: 'AC1234567890abcdef1234567890ABCDEF',
        callSid: 'CA_SMOKE',
        authToken: 'auth-token',
        fetchImpl: async () => {
            throw new Error('should not call fetch');
        }
    });
    assert.equal(invalidCall.skipped, true);
    assert.equal(invalidCall.reason, 'invalid_call_sid');

    const missingToken = await updateTwilioCallStatus({
        accountSid: 'AC1234567890abcdef1234567890ABCDEF',
        callSid: 'CA1234567890abcdef1234567890ABCDEF',
        authToken: ''
    });
    assert.equal(missingToken.skipped, true);
    assert.equal(missingToken.reason, 'missing_auth_token');
});
