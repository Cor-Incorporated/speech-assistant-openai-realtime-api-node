import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevShadow } from '../lib/jev-shadow.js';

const silent = { warn() {}, log() {} };

const baseEnv = {
    ROUTING_PROVIDER: 'jev_shadow',
    EXTERNAL_EVAL_ENABLED: 'true',
    TYPESAFE_API_KEY: 'test-key',
    JEV_MODEL: 'jev-1.13.0'
};

test('disabled by default — legacy routing returns null', () => {
    assert.equal(createJevShadow({ ROUTING_PROVIDER: 'legacy' }, silent), null);
    assert.equal(createJevShadow({}, silent), null);
});

test('shadow requires EXTERNAL_EVAL_ENABLED=true as the final switch', () => {
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), log() {} };
    const shadow = createJevShadow({ ...baseEnv, EXTERNAL_EVAL_ENABLED: 'false' }, logger);
    assert.equal(shadow, null);
    assert.match(warnings[0], /EXTERNAL_EVAL_ENABLED/);
});

test('shadow requires an API key — never sends without one', () => {
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), log() {} };
    const shadow = createJevShadow(
        { ROUTING_PROVIDER: 'jev_shadow', EXTERNAL_EVAL_ENABLED: 'true' },
        logger
    );
    assert.equal(shadow, null);
    assert.match(warnings[0], /API_KEY/);
});

test('JEV_API_KEY is accepted as the key source', () => {
    const shadow = createJevShadow(
        { ...baseEnv, TYPESAFE_API_KEY: undefined, JEV_API_KEY: 'alt-key' },
        silent
    );
    assert.ok(shadow);
});

test('invalid config disables shadow with a warning, never throws', () => {
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), log() {} };
    const shadow = createJevShadow(
        { ...baseEnv, JEV_MODEL: 'jev-latest' }, // aliases rejected — pin required
        logger
    );
    assert.equal(shadow, null);
    assert.match(warnings[0], /JEV_MODEL/);
});

test('observe never throws and never returns a promise to await', async () => {
    const shadow = createJevShadow(baseEnv, silent);
    assert.ok(shadow);
    // Network will fail in test env — observe must swallow it asynchronously.
    assert.doesNotThrow(() =>
        shadow.observe([{ role: 'user', text: 'テスト' }], 1, { tier: 'standard' })
    );
    // Give the rejected fetch a tick to settle inside the module.
    await new Promise((resolve) => setTimeout(resolve, 50));
});
