import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
    loadEvalCases,
    runEval,
    runSemanticCase
} from '../dist-backend/eval/synthetic-eval.js';
import { LegacyRulesClassifier } from '../dist-backend/routing/legacy-classifier.js';

const seedPath = resolve('test/fixtures/synthetic-eval-seed.jsonl');
const cases = await loadEvalCases(seedPath);
const report = runEval(cases, seedPath);
const byId = new Map(report.semanticResults.map((result) => [result.id, result]));

test('seed loads all 48 cases with kinds intact', () => {
    assert.equal(cases.length, 48);
    assert.equal(cases.filter((item) => item.kind === 'semantic').length, 36);
    assert.equal(cases.filter((item) => item.kind === 'fault_injection').length, 12);
});

test('every semantic case produces a result row', () => {
    assert.equal(report.semanticResults.length, 36);
    for (const result of report.semanticResults) {
        assert.ok(result.currentIntents.length > 0, result.id);
        assert.ok(result.policy.contract);
        assert.ok(result.policy.general);
    }
});

test('every fault case maps to a test coverage point', () => {
    assert.equal(report.faultResults.length, 12);
    for (const result of report.faultResults) {
        assert.notEqual(result.coverage, 'not_mapped', result.id);
    }
});

test('JA-001 contract request vs JA-002 sales pitch — the hard pair', () => {
    assert.deepEqual(byId.get('JA-001').currentIntents, ['contract_request']);
    assert.deepEqual(byId.get('JA-002').currentIntents, ['sales_offer']);
    assert.match(byId.get('JA-002').policy.contract, /deny/);
});

test('JA-003 self-declared "not sales" still reads as sales', () => {
    assert.deepEqual(byId.get('JA-003').currentIntents, ['sales_offer']);
});

test('JA-005 applicant vs JA-006 recruiting solicitation', () => {
    assert.deepEqual(byId.get('JA-005').currentIntents, ['recruitment']);
    assert.deepEqual(byId.get('JA-006').currentIntents, ['sales_offer']);
});

test('JA-013 life-safety emergency keeps the risk and blocks transfers', () => {
    const result = byId.get('JA-013');
    assert.ok(result.currentRisks.includes('life_safety_emergency'));
    assert.equal(result.policy.general, 'deny:emergency_services');
    assert.equal(result.policy.contract, 'deny:emergency_services');
});

test('JA-016 aggression is flagged and never transferred', () => {
    const result = byId.get('JA-016');
    assert.ok(result.currentRisks.includes('caller_aggression'));
    assert.equal(result.policy.general, 'deny:customer_harassment_ai_handling');
});

test('JA-021 multi-intent keeps both billing and contract', () => {
    const result = byId.get('JA-021');
    assert.ok(result.currentIntents.includes('billing_complaint'));
    assert.ok(result.currentIntents.includes('contract_request'));
});

test('JA-023 bare "はい" inherits no free-standing approval', () => {
    const result = byId.get('JA-023');
    // The classifier sees no business content in a bare yes — it must not
    // mint an intent from it.
    assert.deepEqual(result.currentIntents, ['unknown']);
});

test('JA-031 injection text is not executed as policy', () => {
    const result = byId.get('JA-031');
    // The instruction text alone should not manufacture a contract intent.
    assert.ok(!result.currentIntents.includes('contract_request'));
    assert.match(result.policy.contract, /deny/);
});

test('report honestly separates current output from proposed labels', () => {
    assert.equal(report.split, 'design_seed_not_holdout');
    assert.ok(report.totals.semanticMatchingProposal <= report.totals.semantic);
    // Mismatches are expected and reported, not hidden.
    for (const result of report.semanticResults) {
        assert.equal(
            result.matchesProposal,
            result.proposedIntents.length === result.currentIntents.length
                && result.currentIntents.every((intent) => result.proposedIntents.includes(intent))
        );
    }
});

test('runSemanticCase honors policy flags for the transfer surface', () => {
    const classifier = new LegacyRulesClassifier();
    const evalCase = cases.find((item) => item.id === 'JA-019'); // 既存障害の急ぎ対応
    const result = runSemanticCase(evalCase, classifier, {
        handoffEnabled: true,
        handoffNumbersConfigured: true,
        blockNonHandoffBusiness: true,
        requireBusinessCallback: true,
        enforceRoutingPolicy: true,
        allowComplexComplaintHandoff: false
    });
    assert.ok(result.currentRisks.includes('urgency'));
    assert.equal(result.policy.general, 'allow:general');
});
