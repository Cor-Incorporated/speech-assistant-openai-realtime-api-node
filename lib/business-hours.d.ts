export interface BusinessHoursInterval { start: string; end: string }
export interface BusinessHoursConfig {
    timeZone?: 'Asia/Tokyo';
    weekly?: Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', BusinessHoursInterval[]>>;
    exceptions?: Record<string, BusinessHoursInterval[]>;
}
export interface BusinessHoursResult {
    configured: boolean;
    state: 'open' | 'closed' | 'unknown';
    open: boolean | null;
    closed: boolean | null;
    time_zone: 'Asia/Tokyo';
    evaluated_at: string | null;
    next_available_at: string | null;
    schedule_source: 'weekly' | 'exception' | null;
    emergency_transfer_allowed: true;
    reason: 'not_configured' | 'invalid_config' | 'invalid_now' | 'exception_open' | 'exception_closed'
        | 'within_business_hours' | 'outside_business_hours' | 'no_upcoming_business_hours';
    configuration_errors?: string[];
}
export function parseBusinessHoursConfig(raw: unknown): {
    ok: boolean; configured: boolean; config: BusinessHoursConfig | null; issues: string[];
};
export function evaluateBusinessHours(rawConfig: unknown, options?: { now?: Date | string | number }): BusinessHoursResult;
