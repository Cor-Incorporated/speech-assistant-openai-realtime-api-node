// REVIEW-R04/R07: revocation safety during store outages and natural
// Japanese retrieval over the published-release snapshot.

import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeReader } from '../dist-backend/knowledge/knowledge-reader.js';

const item = (overrides = {}) => ({
    knowledgeId: 'k1',
    key: 'company.hours',
    revision: 1,
    title: '営業時間',
    category: 'hours',
    keywords: ['営業時間'],
    answerJa: '平日10時から18時です。',
    value: {},
    sourceIds: ['official'],
    asOf: null,
    requiresHumanReview: false,
    expiresAt: null,
    ...overrides
});

const makeRepo = ({ settings, items }) => ({
    async getRuntimeSettings() { return settings; },
    async getRelease(releaseId) { return { releaseId, manifestHash: 'm' }; },
    async getReleaseItems() { return items; }
});

const baseSettings = {
    currentReleaseId: 'r1',
    revocationEpoch: 0,
    revokedKnowledgeIds: [],
    updatedAt: ''
};

// --- R04 -------------------------------------------------------------------

test('a known revoked item stays revoked while the settings read fails', async () => {
    let settings = { ...baseSettings };
    let down = false;
    const repo = {
        async getRuntimeSettings() {
            if (down) throw new Error('simulated outage');
            return settings;
        },
        async getRelease() { return { releaseId: 'r1', manifestHash: 'm' }; },
        async getReleaseItems() { return [item()]; }
    };
    const reader = new KnowledgeReader(repo);

    assert.equal((await reader.lookup('営業時間')).status, 'found');

    settings = { ...baseSettings, revocationEpoch: 1, revokedKnowledgeIds: ['k1'] };
    assert.equal((await reader.lookup('営業時間')).status, 'unknown');

    down = true;
    const result = await reader.lookup('営業時間');
    assert.notEqual(result.status, 'found', 'revoked item resurrected during outage');
});

test('a cold reader with no proven revocation state returns unavailable', async () => {
    const repo = {
        async getRuntimeSettings() { throw new Error('outage'); },
        async getRelease() { return null; },
        async getReleaseItems() { return []; }
    };
    const reader = new KnowledgeReader(repo);
    assert.equal((await reader.lookup('営業時間')).status, 'unavailable');
});

// --- R07 -------------------------------------------------------------------

const publishedFixture = [
    item({
        knowledgeId: 'rep', key: 'company.representative',
        title: '代表者', category: 'company',
        keywords: ['代表者', '代表取締役', '社長'],
        answerJa: '代表取締役は寺田康佑です。'
    }),
    item({
        knowledgeId: 'addr', key: 'company.address',
        title: '所在地', category: 'company',
        keywords: ['所在地', '住所', '本社'],
        answerJa: '兵庫県神戸市に本社があります。'
    }),
    item({
        knowledgeId: 'hours', key: 'hours.business',
        title: '営業時間', category: 'hours',
        keywords: ['営業時間', '営業日', '定休日'],
        answerJa: '営業時間は担当者に確認いたします。'
    }),
    item({
        knowledgeId: 'name', key: 'company.name',
        title: '会社名', category: 'company',
        keywords: ['会社名', '社名'],
        answerJa: 'Cor.株式会社です。'
    }),
    item({
        knowledgeId: 'grift', key: 'grift.overview',
        title: 'Grift概要', category: 'service',
        keywords: ['grift', '料金'],
        answerJa: 'Griftの料金はプランによります。'
    })
];

const readerWith = (items) => new KnowledgeReader(makeRepo({ settings: { ...baseSettings }, items }));

const RETRIEVAL_CASES = [
    // [query, expected first-hit key] — the review's natural-language misses
    // plus the keyword queries that already worked.
    ['代表者', 'company.representative'],
    ['代表取締役', 'company.representative'],
    ['Cor.株式会社の代表取締役の名前', 'company.representative'],
    ['御社の代表取締役の名前を教えてください', 'company.representative'],
    ['会社名', 'company.name'],
    ['Cor.株式会社の営業時間、営業日、定休日', 'hours.business'],
    ['営業時間', 'hours.business'],
    ['Griftの料金を教えてください', 'grift.overview'],
    ['所在地', 'company.address'],
    ['御社の住所を教えてください', 'company.address']
];

for (const [query, expectedKey] of RETRIEVAL_CASES) {
    test(`retrieval: ${query}`, async () => {
        const result = await readerWith(publishedFixture).lookup(query);
        assert.equal(result.status, 'found', `no hit for "${query}"`);
        assert.equal(result.items[0].key, expectedKey,
            `"${query}" hit ${result.items.map((i) => i.key)} instead of ${expectedKey}`);
    });
}

test('unrelated queries still return unknown rather than a noise match', async () => {
    const result = await readerWith(publishedFixture).lookup('今日の天気を教えてください');
    assert.equal(result.status, 'unknown');
});

test('empty and whitespace queries return unknown', async () => {
    const reader = readerWith(publishedFixture);
    assert.equal((await reader.lookup('')).status, 'unknown');
    assert.equal((await reader.lookup('　')).status, 'unknown');
});

test('expired items are excluded from retrieval', async () => {
    const expired = item({ knowledgeId: 'old', expiresAt: '2000-01-01T00:00:00.000Z' });
    const result = await readerWith([expired]).lookup('営業時間');
    assert.equal(result.status, 'unknown');
});
