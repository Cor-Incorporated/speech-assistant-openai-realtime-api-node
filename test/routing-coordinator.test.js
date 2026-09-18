import assert from 'node:assert/strict';
import test from 'node:test';
import { RoutingCoordinator } from '../dist-backend/routing/routing-coordinator.js';
import { JevClassifier } from '../dist-backend/routing/jev-classifier.js';
import { LegacyRulesClassifier } from '../dist-backend/routing/legacy-classifier.js';

const contractTurns = [
    { role: 'user', text: '社内で使う申請システムを御社に開発していただきたいです。見積もりをお願いできますか。' }
];

const supportTurns = [
    { role: 'user', text: 'すみません、違いました。今使っているシステムの不具合の件です。' }
];

const jevWith = (transport, deadlineMs = 500) => new JevClassifier({
    transport,
    model: 'jev-1.13.0',
    deadlineMs
});

const transportReturning = (response, delayMs = 0) => ({
    classify: (_request, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response), delayMs);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('TimeoutError'));
        });
    })
});

test('legacy mode classifies via current rules only', async () => {
    const coordinator = new RoutingCoordinator({ mode: 'legacy' });
    const decision = await coordinator.classify(contractTurns);

    assert.equal(decision.kind, 'known');
    assert.deepEqual(decision.intents, ['contract_request']);
    assert.equal(decision.source, 'legacy');
});

test('a stale classification is discarded when the context moved on (FAULT-003)', async () => {
    // Jev resolves after the caller changed intent — the revision moved from
    // 1 to 2 mid-flight, so the result must not drive routing.
    const transport = transportReturning({ intent: 'contract_request' }, 30);
    const coordinator = new RoutingCoordinator({
        mode: 'jev',
        jev: jevWith(transport)
    });

    coordinator.noteContextChanged(); // revision 1 — contract intent
    const pending = coordinator.classify(contractTurns);
    coordinator.noteContextChanged(); // revision 2 — caller corrected

    const decision = await pending;
    assert.equal(decision.kind, 'uncertain');
    assert.equal(decision.signals.intentChanged, true);
    assert.equal(coordinator.decision, null);
});

test('Jev timeout degrades to uncertain + legacy fallback, never hangs (FAULT-004)', async () => {
    const transport = transportReturning({ intent: 'sales_offer' }, 200);
    const coordinator = new RoutingCoordinator({
        mode: 'jev',
        jev: jevWith(transport, 40)
    });

    const started = Date.now();
    const decision = await coordinator.classify(contractTurns);
    const elapsed = Date.now() - started;

    // Control returns near the deadline, not after the transport's 200ms.
    assert.ok(elapsed < 180, `took ${elapsed}ms`);
    assert.equal(decision.kind, 'known');
    assert.equal(decision.source, 'legacy');
    assert.deepEqual(decision.intents, ['contract_request']);
});

test('Jev 429/failure grants no authority — legacy path decides (FAULT-005)', async () => {
    const failing = {
        classify: () => Promise.reject(Object.assign(new Error('rate_limited'), { status: 429 }))
    };
    const coordinator = new RoutingCoordinator({
        mode: 'jev',
        jev: jevWith(failing)
    });

    const decision = await coordinator.classify(contractTurns);
    assert.equal(decision.kind, 'known');
    assert.equal(decision.source, 'legacy');
});

test('jev_shadow returns legacy now and records the shadow answer', async () => {
    const transport = transportReturning({ intent: 'sales_offer', intentProbabilities: { sales_offer: 0.7 } });
    const coordinator = new RoutingCoordinator({
        mode: 'jev_shadow',
        jev: jevWith(transport)
    });

    const decision = await coordinator.classify(contractTurns);
    assert.equal(decision.source, 'legacy');
    assert.deepEqual(decision.intents, ['contract_request']);

    // Shadow record arrives asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(coordinator.shadowRecords.length, 1);
    assert.equal(coordinator.shadowRecords[0].jev.kind, 'known');
    assert.equal(coordinator.shadowRecords[0].jev.intents[0], 'sales_offer');
});

test('context corrections bump revision so stale caches cannot match', async () => {
    const coordinator = new RoutingCoordinator({ mode: 'legacy' });
    const r0 = coordinator.revision;
    coordinator.noteContextChanged();
    assert.equal(coordinator.revision, r0 + 1);

    const first = await coordinator.classify(contractTurns);
    assert.equal(first.contextRevision, coordinator.revision);
});
