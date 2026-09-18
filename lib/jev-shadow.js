// Jev shadow classifier — fire-and-forget comparison logging for production.
//
// Enabled only when ROUTING_PROVIDER=jev_shadow AND EXTERNAL_EVAL_ENABLED=true
// AND an API key is present (TYPESAFE_API_KEY or JEV_API_KEY). It never
// influences the call: the returned decision is logged for comparison with
// the legacy rules and then discarded. Transcript text is masked inside
// JevClassifier before it leaves the process.
//
// The compiled TypeScript layer (dist-backend/) is loaded lazily via dynamic
// import so index.js starts normally even when dist-backend has not been
// built — a missing build only degrades the shadow to error logs, never the
// call path.

const ENV_FLAG = 'ROUTING_PROVIDER';
const SHADOW_VALUE = 'jev_shadow';

// Mirrors the checks in src/config/schema.ts so a bad config fails at startup,
// not on the first call. The schema still validates inside the lazy init.
function validateShadowEnv(env) {
    const errors = [];
    const model = String(env.JEV_MODEL || 'jev-1.13.0').trim();
    if (!model || model === 'jev-latest' || model.includes('preview')) {
        errors.push(`JEV_MODEL must be a pinned release id (e.g. jev-1.13.0); got "${model}"`);
    }
    if (env.JEV_DEADLINE_MS !== undefined) {
        const parsed = Number(env.JEV_DEADLINE_MS);
        if (!Number.isInteger(parsed) || parsed < 50 || parsed > 5000) {
            errors.push(`JEV_DEADLINE_MS must be an integer in [50, 5000]; got "${env.JEV_DEADLINE_MS}"`);
        }
    }
    return { errors, model };
}

export function createJevShadow(env = process.env, logger = console) {
    if ((env[ENV_FLAG] ?? 'legacy') !== SHADOW_VALUE) {
        return null;
    }
    if (env.EXTERNAL_EVAL_ENABLED !== 'true') {
        logger.warn('ROUTING_PROVIDER=jev_shadow requires EXTERNAL_EVAL_ENABLED=true — shadow disabled');
        return null;
    }
    const apiKey = env.TYPESAFE_API_KEY || env.JEV_API_KEY;
    if (!apiKey) {
        logger.warn('jev_shadow configured but no TYPESAFE_API_KEY/JEV_API_KEY — shadow disabled');
        return null;
    }
    const { errors } = validateShadowEnv(env);
    if (errors.length > 0) {
        logger.warn(`jev_shadow config invalid: ${errors.join('; ')}`);
        return null;
    }

    let ready = null;
    const ensureClassifier = () => {
        ready ??= Promise.all([
            import('../dist-backend/routing/jev-classifier.js'),
            import('../dist-backend/routing/jev-http-transport.js'),
            import('../dist-backend/config/schema.js')
        ]).then(([classifierModule, transportModule, configModule]) => {
            const result = configModule.buildModernizationConfig(env);
            if (!result.ok) {
                throw new Error(`modernization config invalid: ${result.errors.join('; ')}`);
            }
            return new classifierModule.JevClassifier({
                model: result.config.jevModel,
                deadlineMs: result.config.jevDeadlineMs,
                transport: new transportModule.JevHttpTransport({
                    apiKey,
                    endpoint: env.JEV_ENDPOINT || transportModule.JEV_DEFAULT_ENDPOINT
                })
            });
        });
        return ready;
    };

    return {
        /**
         * Observe one completed user context. Never throws, never blocks —
         * the call path does not wait on Jev.
         */
        observe(turns, contextRevision, legacyClassification) {
            ensureClassifier()
                .then((classifier) => classifier.classify(turns, contextRevision))
                .then((decision) => {
                    logger.log(JSON.stringify({
                        event: 'jev_shadow',
                        revision: contextRevision,
                        jev: decision.kind === 'known'
                            ? {
                                intents: decision.intents,
                                risks: decision.risks,
                                humanRequested: decision.signals.humanRequested
                            }
                            : { uncertain: decision.reason },
                        legacy: {
                            tier: legacyClassification?.tier ?? null,
                            category: legacyClassification?.category ?? null
                        }
                    }));
                })
                .catch((error) => {
                    logger.log(JSON.stringify({
                        event: 'jev_shadow',
                        revision: contextRevision,
                        error: error?.name ?? 'unknown'
                    }));
                });
        }
    };
}
