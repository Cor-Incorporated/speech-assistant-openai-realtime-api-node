const TIME_ZONE = 'Asia/Tokyo';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const dateKey = (milliseconds) => new Date(milliseconds + JST_OFFSET_MS).toISOString().split('T')[0];

const validDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(`${value}T`);
};

const minuteOfDay = (value, allowMidnightEnd = false) => {
    if (allowMidnightEnd && value === '24:00') return 1440;
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
};

/** Parse a JSON environment value or object. Missing configuration is unknown,
 * never an invented promise that the company is open around the clock. */
export function parseBusinessHoursConfig(raw) {
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
        return { ok: true, configured: false, config: null, issues: [] };
    }
    let input = raw;
    if (typeof raw === 'string') {
        try { input = JSON.parse(raw); }
        catch { return { ok: false, configured: true, config: null, issues: ['invalid_json'] }; }
    }
    const issues = [];
    if (!isObject(input)) {
        return { ok: false, configured: true, config: null, issues: ['configuration_must_be_object'] };
    }
    for (const key of Object.keys(input)) {
        if (!['timeZone', 'weekly', 'exceptions'].includes(key)) issues.push('unknown_configuration_field');
    }
    if (input.timeZone !== undefined && input.timeZone !== TIME_ZONE) issues.push('unsupported_time_zone');
    if (!own(input, 'weekly') && !own(input, 'exceptions')) issues.push('schedule_required');

    const parseIntervals = (rawIntervals, path) => {
        if (!Array.isArray(rawIntervals)) { issues.push(`${path}:intervals_must_be_array`); return []; }
        const intervals = [];
        for (const interval of rawIntervals) {
            if (!isObject(interval) || Object.keys(interval).some((key) => !['start', 'end'].includes(key))) {
                issues.push(`${path}:invalid_interval`);
                continue;
            }
            const start = minuteOfDay(interval.start);
            const end = minuteOfDay(interval.end, true);
            if (start === null || end === null || start >= end) {
                issues.push(`${path}:invalid_interval_time`);
                continue;
            }
            intervals.push({ start: interval.start, end: interval.end });
        }
        intervals.sort((a, b) => a.start.localeCompare(b.start));
        for (let i = 1; i < intervals.length; i += 1) {
            if (minuteOfDay(intervals[i].start) < minuteOfDay(intervals[i - 1].end, true)) {
                issues.push(`${path}:overlapping_intervals`);
            }
        }
        return intervals;
    };

    const weekly = Object.fromEntries(DAYS.map((day) => [day, []]));
    if (own(input, 'weekly')) {
        if (!isObject(input.weekly)) issues.push('weekly_must_be_object');
        else for (const [day, intervals] of Object.entries(input.weekly)) {
            if (!DAYS.includes(day)) { issues.push('invalid_weekday'); continue; }
            weekly[day] = parseIntervals(intervals, `weekly.${day}`);
        }
    }
    const exceptions = Object.create(null);
    if (own(input, 'exceptions')) {
        if (!isObject(input.exceptions)) issues.push('exceptions_must_be_object');
        else for (const [date, intervals] of Object.entries(input.exceptions)) {
            if (!validDate(date)) { issues.push('invalid_exception_date'); continue; }
            exceptions[date] = parseIntervals(intervals, `exceptions.${date}`);
        }
    }
    return {
        ok: issues.length === 0,
        configured: true,
        config: issues.length ? null : { timeZone: TIME_ZONE, weekly, exceptions },
        issues
    };
}

const timestamp = (now) => {
    if (now instanceof Date) return now.getTime();
    if (typeof now === 'number') return Number.isFinite(now) ? now : NaN;
    // Do not let the host's timezone decide a caller-supplied timestamp.
    if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(now)) return NaN;
    return validDate(now.slice(0, 10)) ? Date.parse(now) : NaN;
};

/** Information only. Emergency transfer eligibility must still pass the
 * existing routing/action gates; business hours never restrict it. */
export function evaluateBusinessHours(rawConfig, { now = new Date() } = {}) {
    const parsed = parseBusinessHoursConfig(rawConfig);
    const base = {
        configured: parsed.configured,
        state: 'unknown',
        open: null,
        closed: null,
        time_zone: TIME_ZONE,
        evaluated_at: null,
        next_available_at: null,
        schedule_source: null,
        emergency_transfer_allowed: true
    };
    if (!parsed.ok) return { ...base, reason: 'invalid_config', configuration_errors: parsed.issues };
    if (!parsed.configured) return { ...base, reason: 'not_configured' };
    const milliseconds = timestamp(now);
    // Guard the timezone shift as well as the Date conversion itself.
    if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds + JST_OFFSET_MS).getTime())) {
        return { ...base, reason: 'invalid_now' };
    }
    const evaluatedAt = new Date(milliseconds).toISOString();
    const today = dateKey(milliseconds);
    const midnight = Date.parse(`${today}T00:00:00+09:00`);
    const weekday = new Date(midnight + JST_OFFSET_MS).getUTCDay();
    const { weekly, exceptions } = parsed.config;
    const overridden = own(exceptions, today);
    const intervals = overridden ? exceptions[today] : weekly[DAYS[weekday]];
    const at = (dayStart, time) => dayStart + minuteOfDay(time, true) * 60_000;
    const open = intervals.some((interval) => milliseconds >= at(midnight, interval.start)
        && milliseconds < at(midnight, interval.end));
    let next = open ? milliseconds : null;

    const consider = (dayStart, candidates) => {
        for (const interval of candidates) {
            const start = at(dayStart, interval.start);
            if (start > milliseconds && (next === null || start < next)) next = start;
        }
    };
    if (!open) {
        // Exact next occurrence: each exception can suppress only one weekly
        // candidate date. No arbitrary one-year lookahead loses a long closure.
        for (let day = 0; day < DAYS.length; day += 1) {
            const candidates = weekly[DAYS[day]];
            if (!candidates.length) continue;
            let candidateDay = midnight + ((day - weekday + 7) % 7) * DAY_MS;
            while (own(exceptions, dateKey(candidateDay))
                || !candidates.some((interval) => at(candidateDay, interval.start) > milliseconds)) {
                candidateDay += 7 * DAY_MS;
            }
            consider(candidateDay, candidates);
        }
        for (const [date, candidates] of Object.entries(exceptions)) {
            if (date >= today) consider(Date.parse(`${date}T00:00:00+09:00`), candidates);
        }
    }
    return {
        ...base,
        state: open ? 'open' : 'closed',
        open,
        closed: !open,
        evaluated_at: evaluatedAt,
        next_available_at: next === null ? null : new Date(next).toISOString(),
        schedule_source: overridden ? 'exception' : 'weekly',
        reason: overridden ? (open ? 'exception_open' : 'exception_closed')
            : open ? 'within_business_hours'
                : next === null ? 'no_upcoming_business_hours' : 'outside_business_hours'
    };
}
