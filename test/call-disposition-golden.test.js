// ゴールデンテスト: 通話シナリオごとに「人間ゲート / AI完結+メール通知 / 高精度AI受付 /
// 緊急案内 / 迷惑対応」の判定が仕様どおりかを検証する。期待値は
// test/golden/call-scenarios.json に手書きされた仕様であり、実装出力のスナップショットではない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyCallDisposition, DISPOSITIONS } from '../lib/call-disposition.js';

const { scenarios } = JSON.parse(readFileSync(new URL('./golden/call-scenarios.json', import.meta.url), 'utf8'));

const toTurns = (turns) => turns.map((turn) => (
    Array.isArray(turn) ? { role: turn[0], text: turn[1] } : { role: 'user', text: turn }
));

test('golden scenarios have unique ids and use known dispositions', () => {
    const ids = scenarios.map((scenario) => scenario.id);
    assert.equal(new Set(ids).size, ids.length);
    const known = new Set(Object.values(DISPOSITIONS));
    for (const scenario of scenarios) {
        assert.ok(known.has(scenario.expected.disposition), `${scenario.id}: ${scenario.expected.disposition}`);
    }
});

test('golden scenarios cover every disposition and every use-case group', () => {
    const dispositions = new Set(scenarios.map((scenario) => scenario.expected.disposition));
    assert.deepEqual([...dispositions].sort(), Object.values(DISPOSITIONS).sort());
    const groups = new Set(scenarios.map((scenario) => scenario.group));
    for (const group of ['human_gate', 'ai_complete', 'ai_precision', 'emergency', 'harassment']) {
        assert.ok(groups.has(group), group);
    }
});

for (const scenario of scenarios) {
    test(`${scenario.id} ${scenario.name}`, () => {
        const result = classifyCallDisposition(toTurns(scenario.turns));
        assert.equal(result.disposition, scenario.expected.disposition);
        if (scenario.expected.destination) assert.equal(result.destination, scenario.expected.destination);
        if (scenario.expected.trigger) assert.equal(result.trigger, scenario.expected.trigger);
        if (scenario.expected.humanGatePossible !== undefined) {
            assert.equal(result.humanGatePossible, scenario.expected.humanGatePossible);
        }
        assert.equal(result.notifyEmail, true, 'every call ends with an email notification');
        assert.equal(result.handledBy, result.disposition === DISPOSITIONS.HUMAN_GATE ? 'human_gate' : 'ai');
    });
}
