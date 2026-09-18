// Startup validation for modernization feature flags.
// Unknown enum values are rejected, never silently normalized — a misspelled
// provider name must fail loudly instead of falling back to a surprise default.

import type { VoiceProvider } from '../contracts/voice-events.js';

export const VOICE_PROVIDERS = ['realtime', 'live'] as const;
export const ROUTING_PROVIDERS = ['legacy', 'jev_shadow', 'jev'] as const;
export type RoutingProvider = (typeof ROUTING_PROVIDERS)[number];

export interface ModernizationConfig {
    voiceProvider: VoiceProvider;
    routingProvider: RoutingProvider;
    liveModel: string;
    jevModel: string;
    jevDeadlineMs: number;
    externalEvalEnabled: boolean;
}

export type ConfigResult =
    | { ok: true; config: ModernizationConfig }
    | { ok: false; errors: string[] };

const DEFAULTS: ModernizationConfig = {
    voiceProvider: 'realtime',
    routingProvider: 'legacy',
    liveModel: 'gpt-live-1',
    jevModel: 'jev-1.13.0',
    jevDeadlineMs: 500,
    externalEvalEnabled: false
};

const isBoolLike = (value: string | undefined): boolean =>
    value === 'true' || value === 'false';

export function buildModernizationConfig(
    env: Record<string, string | undefined> = process.env
): ConfigResult {
    const errors: string[] = [];

    const voiceProvider = env.VOICE_PROVIDER ?? DEFAULTS.voiceProvider;
    if (!(VOICE_PROVIDERS as readonly string[]).includes(voiceProvider)) {
        errors.push(`VOICE_PROVIDER must be one of ${VOICE_PROVIDERS.join('|')}; got "${voiceProvider}"`);
    }

    const routingProvider = env.ROUTING_PROVIDER ?? DEFAULTS.routingProvider;
    if (!(ROUTING_PROVIDERS as readonly string[]).includes(routingProvider)) {
        errors.push(`ROUTING_PROVIDER must be one of ${ROUTING_PROVIDERS.join('|')}; got "${routingProvider}"`);
    }

    const liveModel = (env.LIVE_MODEL ?? DEFAULTS.liveModel).trim();
    if (!liveModel) errors.push('LIVE_MODEL must not be empty');

    const jevModel = (env.JEV_MODEL ?? DEFAULTS.jevModel).trim();
    if (!jevModel || jevModel === 'jev-latest' || jevModel.includes('preview')) {
        errors.push(`JEV_MODEL must be a pinned release id (e.g. jev-1.13.0); got "${jevModel}"`);
    }

    let jevDeadlineMs = DEFAULTS.jevDeadlineMs;
    if (env.JEV_DEADLINE_MS !== undefined) {
        const parsed = Number(env.JEV_DEADLINE_MS);
        if (!Number.isInteger(parsed) || parsed < 50 || parsed > 5000) {
            errors.push(`JEV_DEADLINE_MS must be an integer in [50, 5000]; got "${env.JEV_DEADLINE_MS}"`);
        } else {
            jevDeadlineMs = parsed;
        }
    }

    const externalEval = env.EXTERNAL_EVAL_ENABLED ?? 'false';
    if (!isBoolLike(externalEval)) {
        errors.push(`EXTERNAL_EVAL_ENABLED must be "true" or "false"; got "${externalEval}"`);
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        config: {
            voiceProvider: voiceProvider as VoiceProvider,
            routingProvider: routingProvider as RoutingProvider,
            liveModel,
            jevModel,
            jevDeadlineMs,
            externalEvalEnabled: externalEval === 'true'
        }
    };
}
