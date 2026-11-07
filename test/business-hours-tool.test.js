import assert from 'node:assert/strict';
import test from 'node:test';
import { BUSINESS_HOURS_TOOL, executeBusinessHoursCall, findBusinessHoursToolCalls } from '../lib/business-hours-tool.js';

const config = { weekly: { mon: [{ start: '09:00', end: '18:00' }] }, exceptions: { '2026-11-09': [] } };
test('business hours tool returns current JST closure and next availability without granting transfer authority', () => {
    const output = executeBusinessHoursCall({ callId: 'hours-1', arguments: '{"at":null}' }, {
        config, now: new Date('2026-11-09T10:00:00+09:00')
    });
    const body = JSON.parse(output.output);
    assert.equal(body.closed, true);
    assert.equal(body.reason, 'exception_closed');
    assert.equal(body.next_available_at, '2026-11-16T00:00:00.000Z');
    assert.equal(body.emergency_transfer_allowed, true);
    assert.match(body.instruction, /保証ではありません/);
    assert.equal(output.call_id, 'hours-1');
    assert.equal(output.type, 'function_call_output');
});

test('missing configuration and malformed arguments never invent opening hours', () => {
    for (const args of ['{', 'null', '[]', '{"at":1}', '{"configuration":{"weekly":{}}}', 'x'.repeat(1025)]) {
        const output = executeBusinessHoursCall({ arguments: args }, { config });
        assert.equal(JSON.parse(output.output).reason, 'invalid_arguments');
    }
    const missing = JSON.parse(executeBusinessHoursCall({ arguments: '{}' }, { config: '' }).output);
    assert.equal(missing.state, 'unknown');
    assert.equal(missing.open, null);
    assert.match(missing.instruction, /推測/);
    const invalid = JSON.parse(executeBusinessHoursCall({ arguments: '{"at":"next Monday"}' }, { config }).output);
    assert.equal(invalid.reason, 'invalid_now');
});

test('only the advertised read-only business hours tool is selected', () => {
    const output = [
        { type: 'function_call', name: BUSINESS_HOURS_TOOL.name, call_id: 'hours', arguments: '{}' },
        { type: 'function_call', name: 'transfer_to_human', call_id: 'transfer', arguments: '{}' }
    ];
    assert.deepEqual(findBusinessHoursToolCalls({ response: { output } }).map((call) => call.callId), ['hours']);
    assert.deepEqual(Object.keys(BUSINESS_HOURS_TOOL.parameters.properties), ['at']);
});
