import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_POLICY_FLAGS,
    evaluateModelEscalation,
    evaluateTransferRequest
} from '../dist-backend/domain/routing-policy.js';

const flags = { ...DEFAULT_POLICY_FLAGS, handoffEnabled: true, handoffNumbersConfigured: true };

const known = (intents, risks = [], signals = {}) => ({
    kind: 'known',
    intents,
    risks,
    signals: { humanRequested: false, multipleIntents: false, intentChanged: false, ...signals },
    source: 'legacy',
    contextRevision: 0
});

const uncertain = (reason = 'unavailable') => ({
    kind: 'uncertain',
    reason,
    signals: { humanRequested: false, multipleIntents: false, intentChanged: false },
    contextRevision: 0
});

test('life-safety emergency never transfers to staff — guidance only', () => {
    const decision = known(['unknown'], ['life_safety_emergency']);
    for (const destination of ['contract', 'general']) {
        const verdict = evaluateTransferRequest(destination, decision, flags);
        assert.equal(verdict.allowed, false);
        assert.equal(verdict.reason, 'emergency_services');
    }
});

test('caller aggression never transfers', () => {
    const decision = known(['unknown'], ['caller_aggression']);
    const verdict = evaluateTransferRequest('general', decision, flags);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'customer_harassment_ai_handling');
});

test('contract destination requires a contract_request intent', () => {
    assert.equal(
        evaluateTransferRequest('contract', known(['contract_request']), flags).allowed,
        true
    );
    // A handoff-eligible intent that is not contract_request must be denied
    // with the destination-specific reason (non-handoff intents are blocked
    // earlier, by the non_handoff_business_call rule).
    const denied = evaluateTransferRequest('contract', known(['general_inquiry']), flags);
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'contract_request_not_detected');
});

test('sales / recruitment / partnership never auto-transfer', () => {
    for (const intent of ['sales_offer', 'recruitment', 'partnership_media']) {
        for (const destination of ['contract', 'general']) {
            const verdict = evaluateTransferRequest(destination, known([intent]), flags);
            assert.equal(verdict.allowed, false, `${intent}→${destination}`);
            assert.equal(verdict.reason, 'non_handoff_business_call');
        }
    }
});

test('urgent non-business support may use general', () => {
    const decision = known(['existing_support'], ['urgency']);
    const verdict = evaluateTransferRequest('general', decision, flags);
    assert.equal(verdict.allowed, true);
});

test('urgency claimed by a sales call does not unlock transfer', () => {
    const decision = known(['sales_offer'], ['urgency']);
    const verdict = evaluateTransferRequest('general', decision, flags);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'non_handoff_business_call');
});

test('complaint transfers only when the operator opted in', () => {
    const decision = known(['billing_complaint']);
    const denied = evaluateTransferRequest('general', decision, flags);
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'non_urgent_general_handoff');

    const allowed = evaluateTransferRequest(
        'general',
        decision,
        { ...flags, allowComplexComplaintHandoff: true }
    );
    assert.equal(allowed.allowed, true);
});

test('an uncertain decision grants no authority', () => {
    for (const destination of ['contract', 'general']) {
        const verdict = evaluateTransferRequest(destination, uncertain('timeout'), flags);
        assert.equal(verdict.allowed, false);
        assert.equal(verdict.reason, 'classification_uncertain');
    }
});

test('handoff disabled or unconfigured blocks everything', () => {
    const decision = known(['contract_request']);
    assert.equal(
        evaluateTransferRequest('contract', decision, DEFAULT_POLICY_FLAGS).reason,
        'handoff_unavailable'
    );
    assert.equal(
        evaluateTransferRequest(
            'contract',
            decision,
            { ...flags, handoffNumbersConfigured: false }
        ).reason,
        'handoff_unavailable'
    );
});

test('model escalation mirrors the current tiering', () => {
    assert.deepEqual(
        evaluateModelEscalation(known(['unknown'], ['caller_aggression'])),
        { tier: 'complex_complaint', category: 'customer_harassment', humanTransferAllowed: false }
    );
    assert.deepEqual(
        evaluateModelEscalation(known(['billing_complaint'])),
        { tier: 'complex_complaint', category: 'complaint', humanTransferAllowed: true }
    );
    assert.deepEqual(
        evaluateModelEscalation(known(['existing_support'], ['security_legal'])),
        { tier: 'complex_complaint', category: 'complex_support', humanTransferAllowed: true }
    );
    assert.deepEqual(
        evaluateModelEscalation(known(['general_inquiry'])),
        { tier: 'standard', category: 'standard', humanTransferAllowed: false }
    );
});
