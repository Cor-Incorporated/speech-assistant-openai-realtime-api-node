import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBusinessHours, parseBusinessHoursConfig } from '../lib/business-hours.js';

const hours = {
    timeZone: 'Asia/Tokyo',
    weekly: {
        mon: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
        tue: [{ start: '09:00', end: '18:00' }]
    },
    exceptions: { '2026-11-03': [] }
};
const check = (config, now) => evaluateBusinessHours(config, { now });

test('unset hours do not invent opening hours or restrict emergency transfer', () => {
    for (const config of [undefined, null, '', '  ']) {
        const result = check(config, '2026-11-02T10:00:00+09:00');
        assert.equal(result.state, 'unknown');
        assert.equal(result.reason, 'not_configured');
        assert.equal(result.open, null);
        assert.equal(result.next_available_at, null);
        assert.equal(result.emergency_transfer_allowed, true);
    }
});

test('weekly intervals are start-inclusive and end-exclusive with a lunch break', () => {
    for (const [time, open, next] of [
        ['08:59:59', false, '2026-11-02T00:00:00.000Z'],
        ['09:00:00', true, '2026-11-02T00:00:00.000Z'],
        ['12:00:00', false, '2026-11-02T04:00:00.000Z'],
        ['13:00:00', true, '2026-11-02T04:00:00.000Z'],
        ['18:00:00', false, '2026-11-09T00:00:00.000Z']
    ]) {
        const result = check(hours, `2026-11-02T${time}+09:00`);
        assert.equal(result.open, open, time);
        assert.equal(result.closed, !open, time);
        assert.equal(result.next_available_at, next, time);
        assert.equal(result.emergency_transfer_allowed, true);
    }
});

test('Tokyo date boundary selects Monday even when the UTC date is Sunday', () => {
    const config = { weekly: { mon: [{ start: '00:00', end: '01:00' }] } };
    assert.equal(check(config, '2026-11-01T15:00:00Z').open, true);
    assert.equal(check(config, '2026-11-01T14:59:59Z').open, false);
    assert.equal(check(config, '2026-11-01T16:00:00Z').open, false);
});

test('explicit holiday closures replace the entire weekly schedule', () => {
    const result = check(hours, '2026-11-03T10:00:00+09:00');
    assert.equal(result.reason, 'exception_closed');
    assert.equal(result.schedule_source, 'exception');
    assert.equal(result.next_available_at, '2026-11-09T00:00:00.000Z');
    assert.equal(check({ weekly: hours.weekly }, '2026-11-03T10:00:00+09:00').open, true);
});

test('exception openings work on otherwise closed days and determine next availability', () => {
    const config = { ...hours, exceptions: { '2026-11-07': [{ start: '14:00', end: '16:00' }] } };
    assert.equal(check(config, '2026-11-07T13:00:00+09:00').next_available_at, '2026-11-07T05:00:00.000Z');
    assert.equal(check(config, '2026-11-07T14:00:00+09:00').reason, 'exception_open');
    assert.equal(check(config, '2026-11-07T16:00:00+09:00').open, false);
});

test('24:00 closes at the following date and overnight hours require explicit split days', () => {
    const config = { weekly: { sun: [{ start: '22:00', end: '24:00' }], mon: [{ start: '00:00', end: '02:00' }] } };
    assert.equal(check(config, '2026-11-01T23:59:59+09:00').open, true);
    assert.equal(check(config, '2026-11-02T00:00:00+09:00').open, true);
    assert.equal(check(config, '2026-11-02T02:00:00+09:00').open, false);
    assert.equal(check({ weekly: { mon: [{ start: '22:00', end: '02:00' }] } }).reason, 'invalid_config');
});

test('a finite all-closed schedule has no manufactured next opening', () => {
    const result = check({ weekly: {} }, '2026-11-02T10:00:00+09:00');
    assert.equal(result.state, 'closed');
    assert.equal(result.reason, 'no_upcoming_business_hours');
    assert.equal(result.next_available_at, null);
});

test('next opening remains exact beyond a one-year closure or an exceptions-only calendar', () => {
    const exceptions = {};
    for (let i = 0; i < 60; i += 1) {
        const date = new Date(Date.parse('2026-11-02T00:00:00Z') + i * 7 * 86400000).toISOString().slice(0, 10);
        exceptions[date] = [];
    }
    const config = { weekly: { mon: [{ start: '09:00', end: '10:00' }] }, exceptions };
    assert.equal(check(config, '2026-11-02T08:00:00+09:00').next_available_at,
        new Date(Date.parse('2026-11-02T00:00:00Z') + 60 * 7 * 86400000).toISOString());
    assert.equal(check({ exceptions: { '2028-02-29': [{ start: '09:00', end: '10:00' }] } },
        '2026-11-02T08:00:00+09:00').next_available_at, '2028-02-29T00:00:00.000Z');
});

test('invalid configuration fails visibly without changing emergency availability', () => {
    for (const config of ['{', 'null', '[]', {}, { timezone: 'Asia/Tokyo' },
        { timeZone: 'UTC', weekly: {} }, { weekly: [] }, { weekly: { monday: [] } },
        { exceptions: { '2026-02-30': [] } }, { exceptions: { '2027-02-29': [] } },
        { weekly: { mon: [{ start: '24:00', end: '24:00' }] } },
        { weekly: { mon: [{ start: '9:00', end: '18:00' }] } },
        { weekly: { mon: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] } }
    ]) {
        const result = check(config, '2026-11-02T10:00:00+09:00');
        assert.equal(result.reason, 'invalid_config', JSON.stringify(config));
        assert.equal(result.open, null);
        assert.equal(result.next_available_at, null);
        assert.equal(result.emergency_transfer_allowed, true);
        assert.ok(result.configuration_errors.length > 0);
    }
});

test('invalid and timezone-less query dates are rejected, independent of the host timezone', () => {
    for (const now of ['2026-11-02T10:00:00', '2026-02-30T10:00:00Z', '2026-11-02T24:00:00Z', 'bad', new Date(NaN), Infinity]) {
        assert.equal(check(hours, now).reason, 'invalid_now');
    }
    assert.equal(check(hours, new Date('2026-11-02T01:00:00Z')).open, true);
});

test('JSON config input is supported and normalization never mutates caller input', () => {
    const config = { weekly: { mon: [{ start: '13:00', end: '18:00' }, { start: '09:00', end: '12:00' }] } };
    const before = JSON.stringify(config);
    assert.equal(check(before, '2026-11-02T10:00:00+09:00').open, true);
    assert.equal(parseBusinessHoursConfig(config).ok, true);
    assert.equal(JSON.stringify(config), before);
});
