import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DisabledJevTransport,
    JevClassifier,
    maskSensitiveText
} from '../dist-backend/routing/jev-classifier.js';

const turns = [{ role: 'user', text: '請求額を確認したいです' }];

const makeClassifier = (transport, deadlineMs = 500) => new JevClassifier({
    transport,
    model: 'jev-1.13.0',
    deadlineMs
});

test('timeout returns uncertain, not a hang (FAULT-004)', async () => {
    const slow = {
        classify: (_req, signal) => new Promise((resolve, reject) => {
            // A real transport holds sockets that keep the loop alive; the
            // ref'd timer simulates that so the deadline's unref'd timer can fire.
            const timer = setTimeout(() => resolve({ intent: 'billing_complaint' }), 5000);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason ?? new Error('TimeoutError'));
            });
        })
    };
    const classifier = makeClassifier(slow, 40);

    const started = Date.now();
    const decision = await classifier.classify(turns, 0);
    assert.ok(Date.now() - started < 200);
    assert.equal(decision.kind, 'uncertain');
    assert.equal(decision.reason, 'timeout');
});

test('429/5xx/transport errors degrade to uncertain:unavailable (FAULT-005)', async () => {
    for (const status of [429, 500, 503]) {
        const failing = {
            classify: () => Promise.reject(Object.assign(new Error('http_error'), { status }))
        };
        const decision = await makeClassifier(failing).classify(turns, 0);
        assert.equal(decision.kind, 'uncertain');
        assert.equal(decision.reason, 'unavailable');
    }
});

test('unknown intent labels are ambiguous, never coerced', async () => {
    const weird = { classify: () => Promise.resolve({ intent: 'make_me_a_sandwich' }) };
    const decision = await makeClassifier(weird).classify(turns, 0);
    assert.equal(decision.kind, 'uncertain');
    assert.equal(decision.reason, 'ambiguous');
});

test('out-of-range probabilities invalidate the whole answer', async () => {
    const bad = {
        classify: () => Promise.resolve({
            intent: 'billing_complaint',
            risks: { urgency: 1.7 }
        })
    };
    const decision = await makeClassifier(bad).classify(turns, 0);
    assert.equal(decision.kind, 'uncertain');
    assert.equal(decision.reason, 'unavailable');
});

test('valid answers map to a known decision with risk flags', async () => {
    const good = {
        classify: () => Promise.resolve({
            intent: 'billing_complaint',
            intentProbabilities: { billing_complaint: 0.82 },
            risks: { urgency: 0.8, life_safety_emergency: 0.01 },
            humanRequested: 0.9
        })
    };
    const decision = await makeClassifier(good).classify(turns, 2);

    assert.equal(decision.kind, 'known');
    assert.deepEqual(decision.intents, ['billing_complaint']);
    assert.deepEqual(decision.risks, ['urgency']);
    assert.equal(decision.signals.humanRequested, true);
    assert.equal(decision.source, 'jev');
    assert.equal(decision.contextRevision, 2);
});

test('disabled transport is a clean unavailable, not an exception path', async () => {
    const decision = await makeClassifier(new DisabledJevTransport()).classify(turns, 0);
    assert.equal(decision.kind, 'uncertain');
    assert.equal(decision.reason, 'unavailable');
});

test('phone numbers and emails are masked before leaving the process', async () => {
    let captured = '';
    const spy = {
        classify: (request) => {
            captured = request.text;
            return Promise.resolve({ intent: 'billing_complaint' });
        }
    };

    await makeClassifier(spy).classify([
        { role: 'user', text: '090-1234-5678 に折り返してください。メールは tanaka@example.co.jp です。' }
    ], 0);

    assert.ok(!captured.includes('090-1234-5678'), captured);
    assert.ok(captured.includes('<CALLBACK_PHONE>'));
    assert.ok(!captured.includes('tanaka@example.co.jp'));
    assert.ok(captured.includes('<EMAIL>'));
});

test('maskSensitiveText leaves ordinary text untouched', () => {
    assert.equal(maskSensitiveText('営業時間を教えてください'), '営業時間を教えてください');
});

test('empty context is insufficient_context without a transport call', async () => {
    let called = false;
    const spy = {
        classify: () => {
            called = true;
            return Promise.resolve({});
        }
    };
    const decision = await makeClassifier(spy).classify([], 0);
    assert.equal(decision.reason, 'insufficient_context');
    assert.equal(called, false);
});

// --- REVIEW-R06: full-width digits/punctuation must not bypass masking ---

test('maskSensitiveText masks full-width Japanese phone numbers', () => {
    const masked = maskSensitiveText('連絡先は０９０－００００－００００です');
    assert.ok(!masked.includes('０９０'), masked);
    assert.ok(!masked.includes('090'), masked);
    assert.ok(masked.includes('<CALLBACK_PHONE>'), masked);
});

test('maskSensitiveText masks a +81 number with a separator after the country code', () => {
    const masked = maskSensitiveText('連絡先は +81-90-0000-0000 です');
    assert.ok(!masked.includes('90-0000'), masked);
    assert.ok(masked.includes('<CALLBACK_PHONE>'), masked);
});

test('maskSensitiveText masks full-width plus and mixed separators', () => {
    const masked = maskSensitiveText('電話は＋８１　９０ー１２３４ー５６７８へ');
    assert.ok(!masked.includes('９０'), masked);
    assert.ok(!masked.includes('90'), masked);
    assert.ok(masked.includes('<CALLBACK_PHONE>'), masked);
});

test('full-width digits never reach the transport payload', async () => {
    let captured = '';
    const spy = {
        classify: (request) => {
            captured = request.text;
            return Promise.resolve({ intent: 'billing_complaint' });
        }
    };

    await makeClassifier(spy).classify([
        { role: 'user', text: '折り返し先は０９０－１２３４－５６７８です' }
    ], 0);

    assert.ok(!/[0-9０-９]{4}/.test(captured), captured);
    assert.ok(captured.includes('<CALLBACK_PHONE>'), captured);
});
