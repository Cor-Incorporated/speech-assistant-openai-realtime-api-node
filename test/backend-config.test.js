import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModernizationConfig } from '../dist-backend/config/schema.js';

test('defaults are the safe posture: realtime + legacy, everything else off', () => {
    const result = buildModernizationConfig({});
    assert.equal(result.ok, true);
    assert.deepEqual(result.config, {
        voiceProvider: 'realtime',
        routingProvider: 'legacy',
        liveModel: 'gpt-live-1',
        jevModel: 'jev-1.13.0',
        jevDeadlineMs: 500,
        externalEvalEnabled: false
    });
});

test('unknown provider values are rejected, not normalized', () => {
    const bad = buildModernizationConfig({ VOICE_PROVIDER: 'livve' });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /VOICE_PROVIDER/);

    const badRouting = buildModernizationConfig({ ROUTING_PROVIDER: 'jevv' });
    assert.equal(badRouting.ok, false);
});

test('jev-latest and preview ids are refused as pinned models', () => {
    for (const jevModel of ['jev-latest', 'jev-2.0-preview']) {
        const result = buildModernizationConfig({ JEV_MODEL: jevModel });
        assert.equal(result.ok, false, jevModel);
    }
});

test('deadline must be an integer in range', () => {
    assert.equal(buildModernizationConfig({ JEV_DEADLINE_MS: '10' }).ok, false);
    assert.equal(buildModernizationConfig({ JEV_DEADLINE_MS: 'abc' }).ok, false);
    assert.equal(buildModernizationConfig({ JEV_DEADLINE_MS: '9999' }).ok, false);
    assert.equal(buildModernizationConfig({ JEV_DEADLINE_MS: '300' }).ok, true);
});

test('EXTERNAL_EVAL_ENABLED is strictly boolean', () => {
    assert.equal(buildModernizationConfig({ EXTERNAL_EVAL_ENABLED: '1' }).ok, false);
    assert.equal(buildModernizationConfig({ EXTERNAL_EVAL_ENABLED: 'true' }).config.externalEvalEnabled, true);
});

test('flagged configuration is honored verbatim', () => {
    const result = buildModernizationConfig({
        VOICE_PROVIDER: 'live',
        ROUTING_PROVIDER: 'jev_shadow',
        LIVE_MODEL: 'gpt-live-1',
        JEV_MODEL: 'jev-1.13.0',
        JEV_DEADLINE_MS: '300',
        EXTERNAL_EVAL_ENABLED: 'false'
    });
    assert.equal(result.ok, true);
    assert.equal(result.config.voiceProvider, 'live');
    assert.equal(result.config.routingProvider, 'jev_shadow');
});
