import assert from 'node:assert/strict';
import test from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreEscalationRepository } from '../dist-backend/escalations/firestore-escalation-repository.js';
import { EscalationService, InMemoryEscalationRepository } from '../dist-backend/escalations/escalation-service.js';
import { FirestoreCallRepository } from '../dist-backend/calls/firestore-call-repository.js';
import { firestoreRecordPage } from '../dist-backend/pagination/record-page.js';

const timestamp = (index) => new Date(Date.UTC(2026, 10, 7, 0, 0, index)).toISOString();
const actor = { subject: 'test-supervisor', roles: ['supervisor'], sharedAccount: false };
const caseRow = (id, index, state = 'required') => ({
    caseId: id, createdAt: timestamp(index), state, acknowledgedAt: null,
    ackDeadlineAt: '2026-11-06T00:00:00.000Z', importance: 'critical'
});

// A query stub implements the ordered tuple and the raw scan bound; the
// production repository/service and cursor encoding remain under test.
function firestoreFixture(records, idField) {
    const rows = new Map(records.map((record) => [record[idField], record]));
    const reads = [];
    const collection = {
        orderBy(field, direction) {
            const orders = [[String(field), direction]];
            let after = null, limit = null;
            const query = {
                orderBy(nextField, nextDirection) { orders.push([String(nextField), nextDirection]); return query; },
                startAfter(...values) { after = values; return query; },
                limit(count) { limit = count; return query; },
                async get() {
                    reads.push({ orders, after, limit });
                    assert.deepEqual(orders, [[String(field), 'desc'], ['__name__', 'desc']]);
                    assert.equal(limit, 501);
                    const ordered = [...rows.entries()].map(([id, record]) => ({ id, record, key: record[String(field)] ?? null }))
                        .sort((a, b) => a.key === b.key ? Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)) : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? 1 : -1)
                        .filter((row) => !after || row.key < after[0] || (row.key === after[0] && Buffer.compare(Buffer.from(row.id), Buffer.from(after[1])) < 0));
                    return { docs: ordered.slice(0, limit).map(({ id, record }) => ({ id, data: () => structuredClone(record) })) };
                }
            };
            return query;
        }
    };
    return { firestore: { collection: () => collection }, rows, reads };
}

test('a filtered empty scan page continues to the 501st unacknowledged escalation', async () => {
    const records = [caseRow('old-open', 0), ...Array.from({ length: 500 }, (_, i) => caseRow(`closed-${i}`, i + 1, 'resolved'))];
    const { firestore, reads } = firestoreFixture(records, 'caseId');
    const service = new EscalationService(new FirestoreEscalationRepository({ firestore }), { now: () => '2026-11-08T00:00:00.000Z' });
    const first = await service.list(actor, { unacknowledgedOnly: true });
    assert.equal(first.items.length, 0);
    assert.equal(first.partial, true);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    const next = await service.list(actor, { unacknowledgedOnly: true, cursor: first.nextCursor });
    assert.deepEqual(next.items.map((record) => record.caseId), ['old-open']);
    assert.equal(next.hasMore, false);
    assert.equal(next.nextCursor, null);
    assert.equal(reads.length, 2);
});

test('call status filters can reach an old call beyond 500 newer records', async () => {
    const records = Array.from({ length: 501 }, (_, i) => ({
        callId: `call-${i}`, startedAt: timestamp(i), deletedAt: null, origin: 'provider',
        ops: { status: i === 0 ? 'needs_callback' : 'done' }, severity: { importance: 'normal' }
    }));
    const { firestore } = firestoreFixture(records, 'callId');
    const repo = new FirestoreCallRepository({ firestore });
    const first = await repo.list({ businessState: 'needs_callback', limit: 50 });
    assert.equal(first.items.length, 0);
    assert.equal(first.hasMore, true);
    const second = await repo.list({ businessState: 'needs_callback', limit: 50, cursor: first.nextCursor });
    assert.deepEqual(second.items.map((record) => record.callId), ['call-0']);
    assert.equal(second.hasMore, false);
});

test('tuple cursors survive deletion, equal timestamps, and inserts without repeating consumed records', async () => {
    const records = ['d', 'c', 'b', 'a'].map((id) => caseRow(id, 0));
    const { firestore, rows } = firestoreFixture(records, 'caseId');
    const repo = new FirestoreEscalationRepository({ firestore });
    const first = await repo.list({ limit: 2 });
    assert.deepEqual(first.items.map((record) => record.caseId), ['d', 'c']);
    rows.delete('c');
    rows.set('z', caseRow('z', 0)); // ahead of the cursor: visible on refresh
    rows.set('ab', caseRow('ab', 0)); // behind the cursor: visible in continuation
    const next = await repo.list({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual(next.items.map((record) => record.caseId), ['b', 'ab']);
    const last = await repo.list({ limit: 2, cursor: next.nextCursor });
    assert.deepEqual(last.items.map((record) => record.caseId), ['a']);
    assert.equal(last.nextCursor, null);
    assert.deepEqual((await repo.list({ limit: 2 })).items.map((record) => record.caseId), ['z', 'd']);
});

test('malformed, cross-filter and cross-collection cursors fail before reading Firestore', async () => {
    const { firestore, reads } = firestoreFixture([caseRow('b', 0), caseRow('a', 0)], 'caseId');
    const repo = new FirestoreEscalationRepository({ firestore });
    const first = await repo.list({ limit: 1 });
    const before = reads.length;
    for (const cursor of ['garbage', 'p1.%%%%', `p1.${Buffer.from(JSON.stringify({ scope: 'bad', key: null, id: '../escape' })).toString('base64url')}`]) {
        await assert.rejects(repo.list({ cursor }), (error) => error.code === 'INVALID_CURSOR');
    }
    await assert.rejects(repo.list({ cursor: first.nextCursor, state: 'required' }), (error) => error.code === 'INVALID_CURSOR');
    await assert.rejects(new FirestoreCallRepository({ firestore }).list({ cursor: first.nextCursor }), (error) => error.code === 'INVALID_CURSOR');
    assert.equal(reads.length, before);
});

test('in-memory and Firestore pages have identical tuple ordering and cursors', async () => {
    const records = ['b', 'a', 'd', 'c'].map((id) => caseRow(id, id === 'd' ? 1 : 0));
    const memory = new InMemoryEscalationRepository();
    for (const record of records) await memory.createIfAbsent(record);
    const { firestore } = firestoreFixture(records, 'caseId');
    const remote = new FirestoreEscalationRepository({ firestore });
    const firstMemory = await memory.list({ limit: 2 });
    const firstRemote = await remote.list({ limit: 2 });
    assert.deepEqual(firstMemory, firstRemote);
    assert.deepEqual(await memory.list({ limit: 2, cursor: firstMemory.nextCursor }), await remote.list({ limit: 2, cursor: firstRemote.nextCursor }));
});

test('the installed Firestore SDK serializes tuple ordering without additional filter indexes', async () => {
    const database = new Firestore({ projectId: 'local-contract-test' });
    const collection = database.collection('paginationTest');
    // Capture the real SDK query without any network/credentials use.
    const intercepted = {
        orderBy(...args) {
            const query = collection.orderBy(...args);
            const originalLimit = query.constructor.prototype.limit;
            query.limit = function (...limitArgs) {
                const limited = originalLimit.apply(this, limitArgs);
                limited.get = async function () {
                    const query = this.toStructuredQuery();
                    assert.deepEqual(query.orderBy.map((order) => [order.field.fieldPath, order.direction]), [['createdAt', 'DESCENDING'], ['__name__', 'DESCENDING']]);
                    assert.equal(query.where, undefined);
                    assert.equal(query.limit.value, 501);
                    return { docs: [] };
                };
                return limited;
            };
            // orderBy returns a new SDK Query, so preserve interception there.
            const secondOrder = query.orderBy.bind(query);
            query.orderBy = (...orderArgs) => {
                const ordered = secondOrder(...orderArgs);
                ordered.limit = query.limit;
                return ordered;
            };
            return query;
        }
    };
    const result = await firestoreRecordPage(intercepted, { scope: 'sdk-test', orderField: 'createdAt', include: () => true });
    assert.equal(result.hasMore, false);
});
