// Knowledge lifecycle tests — draft → review → approval → release, plus
// withdraw/delete/restore. The acceptance contract: approved+public items
// reach a release; drafts/admin_only/deleted never do; approval binds to
// content hash and never carries over after an edit.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { devActor } from '../dist-backend/admin/permissions.js';
import { InMemoryKnowledgeRepository, VersionConflictError } from '../dist-backend/knowledge/repository.js';
import { KnowledgeService, ServiceError } from '../dist-backend/knowledge/knowledge-service.js';
import { KnowledgeReader } from '../dist-backend/knowledge/knowledge-reader.js';
import { executeKnowledgeLookup, buildLookupCompanyKnowledgeTool } from '../dist-backend/knowledge/knowledge-tool.js';

const editor = devActor('editor@example.com', ['knowledge_editor']);
const approver = devActor('approver@example.com', ['knowledge_approver']);
const viewer = devActor('viewer@example.com', ['viewer']);
const sharedApprover = devActor('shared-admin', ['knowledge_approver'], true);

const baseDraft = (overrides = {}) => ({
    key: 'company.hours',
    title: '営業時間',
    category: 'hours',
    locale: 'ja-JP',
    keywords: ['営業時間', 'hours'],
    audience: 'public',
    handling: 'answer_after_approval',
    riskLevel: 'normal',
    value: { weekday: '10:00-18:00' },
    answerJa: '営業時間は平日10時から18時です。',
    answerType: 'fact',
    evidenceState: 'official_site_observed',
    sourceRefs: [{ sourceId: 'PUB-01', locator: null, checkedOn: '2026-09-19' }],
    asOf: '2026-09-19',
    checkedOn: '2026-09-19',
    validity: { effectiveFrom: null, expiresAt: null, nextReviewAt: null },
    operatorNote: null,
    reviewQuestion: null,
    ...overrides
});

const setup = () => {
    const repo = new InMemoryKnowledgeRepository();
    const service = new KnowledgeService(repo);
    return { repo, service };
};

const approveAndPublish = async (service, record) => {
    const revision = await service['repo'].getRevision(record.knowledgeId, record.draftRevision);
    await service.approve(approver, record.knowledgeId, {
        revision: record.draftRevision,
        contentHash: revision.contentHash,
        reason: '確認済み'
    });
    return service.publish(approver, {});
};

describe('knowledge draft lifecycle', () => {
    it('creates a draft with revision 1 — never published on create', async () => {
        const { service } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-T1');
        assert.equal(record.state, 'draft');
        assert.equal(record.draftRevision, 1);
        assert.equal(record.publishedRevision, null);
    });

    it('rejects invalid drafts with field errors, never silently normalizes', async () => {
        const { service } = setup();
        await assert.rejects(
            () => service.createDraft(editor, baseDraft({ category: 'nonsense' }), 'COR-K-T2'),
            (error) => {
                assert.ok(error instanceof ServiceError);
                assert.equal(error.statusCode, 422);
                assert.ok(error.fieldErrors.category);
                return true;
            }
        );
    });

    it('edit after approval creates a new revision and the approval does NOT carry over', async () => {
        const { service } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-T3');
        await approveAndPublish(service, record);

        // approve+publish advanced recordVersion — lock against the fresh one.
        const fresh = await service.get(editor, 'COR-K-T3');
        const updated = await service.updateDraft(
            editor,
            'COR-K-T3',
            baseDraft({ value: { weekday: '09:00-17:00' } }),
            fresh.recordVersion
        );
        assert.equal(updated.draftRevision, 2);

        // The new revision is unapproved — publishing again must skip it.
        const rev2 = await service['repo'].getRevision('COR-K-T3', 2);
        assert.equal(rev2.approval.approvedBy, null);
        await assert.rejects(
            () => service.publish(approver, { knowledgeIds: ['COR-K-T3'] }),
            /no approved publishable/
        );
    });

    it('approval binds to the content hash — a mismatched hash is rejected', async () => {
        const { service } = setup();
        await service.createDraft(editor, baseDraft(), 'COR-K-T4');
        await assert.rejects(
            () => service.approve(approver, 'COR-K-T4', { revision: 1, contentHash: 'deadbeef', reason: 'x' }),
            /hash does not match/
        );
    });

    it('stale recordVersion produces a conflict (optimistic lock)', async () => {
        const { service } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-T5');
        await service.updateDraft(editor, 'COR-K-T5', baseDraft(), record.recordVersion);
        await assert.rejects(
            () => service.updateDraft(editor, 'COR-K-T5', baseDraft(), record.recordVersion),
            (error) => error instanceof VersionConflictError || error.code === 'VERSION_CONFLICT'
        );
    });
});

describe('knowledge permissions', () => {
    it('editor cannot approve or publish', async () => {
        const { service } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-P1');
        const rev = await service['repo'].getRevision(record.knowledgeId, 1);
        await assert.rejects(
            () => service.approve(editor, 'COR-K-P1', { revision: 1, contentHash: rev.contentHash, reason: 'x' }),
            (error) => error.statusCode === 403
        );
        await assert.rejects(() => service.publish(editor, {}), (error) => error.statusCode === 403);
    });

    it('a shared account can never approve or publish (individual accountability)', async () => {
        const { service } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-P2');
        const rev = await service['repo'].getRevision(record.knowledgeId, 1);
        await assert.rejects(
            () => service.approve(sharedApprover, 'COR-K-P2', { revision: 1, contentHash: rev.contentHash, reason: 'x' }),
            (error) => error.statusCode === 403
        );
        await assert.rejects(() => service.publish(sharedApprover, {}), (error) => error.statusCode === 403);
    });

    it('viewer cannot create drafts', async () => {
        const { service } = setup();
        await assert.rejects(
            () => service.createDraft(viewer, baseDraft(), 'COR-K-P3'),
            (error) => error.statusCode === 403
        );
    });
});

describe('publish / release', () => {
    it('release contains only approved public items — drafts, admin_only, deleted excluded', async () => {
        const { service, repo } = setup();
        const pub = await service.createDraft(editor, baseDraft(), 'COR-K-R1');
        await service.createDraft(editor, baseDraft({ key: 'internal.memo', audience: 'admin_only' }), 'COR-K-R2');
        await service.createDraft(editor, baseDraft({ key: 'unapproved.item' }), 'COR-K-R3');

        const rev = await repo.getRevision(pub.knowledgeId, 1);
        await service.approve(approver, 'COR-K-R1', { revision: 1, contentHash: rev.contentHash, reason: 'ok' });
        // Approve the admin_only item too — approval alone must not leak it.
        const rev2 = await repo.getRevision('COR-K-R2', 1);
        await service.approve(approver, 'COR-K-R2', { revision: 1, contentHash: rev2.contentHash, reason: 'ok' });

        const release = await service.publish(approver, {});
        assert.equal(release.entries.length, 1);
        assert.equal(release.entries[0].knowledgeId, 'COR-K-R1');

        const items = await repo.getReleaseItems(release.releaseId);
        assert.equal(items.length, 1);
        // Whitelist: no operatorNote-like internals can appear.
        assert.deepEqual(Object.keys(items[0]).sort(), [
            'answerJa', 'answerType', 'asOf', 'category', 'contentHash', 'evidenceState',
            'expiresAt', 'key', 'keywords', 'knowledgeId', 'locale', 'requiresHumanReview',
            'revision', 'sourceIds', 'title', 'value'
        ].sort());
    });

    it('release id becomes currentReleaseId only after the manifest exists', async () => {
        const { service, repo } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-R4');
        await approveAndPublish(service, record);
        const settings = await repo.getRuntimeSettings();
        assert.ok(settings.currentReleaseId);
        const release = await repo.getRelease(settings.currentReleaseId);
        assert.ok(release);
        assert.equal((await repo.getReleaseItems(release.releaseId)).length, 1);
    });
});

describe('withdraw / delete / restore', () => {
    it('withdraw records the item in the revocation registry', async () => {
        const { service, repo } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-W1');
        await approveAndPublish(service, record);
        await service.withdraw(approver, 'COR-K-W1', { reason: '誤情報を含むため撤回' });
        const settings = await repo.getRuntimeSettings();
        assert.ok(settings.revokedKnowledgeIds.includes('COR-K-W1'));
        assert.ok(settings.revocationEpoch >= 1);
    });

    it('a withdrawn item disappears from lookups immediately (same release)', async () => {
        const { service, repo } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-W2');
        await approveAndPublish(service, record);
        const reader = new KnowledgeReader(repo);
        const before = await reader.lookup('営業時間');
        assert.equal(before.status, 'found');

        await service.withdraw(approver, 'COR-K-W2', { reason: 'emergency' });
        const after = await reader.lookup('営業時間');
        assert.equal(after.status, 'unknown');
    });

    it('soft-delete removes from search and future releases; restore returns to draft', async () => {
        const { service, repo } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-W3');
        await approveAndPublish(service, record);
        await service.softDelete(editor, 'COR-K-W3', { reason: '不要になった' });

        const reader = new KnowledgeReader(repo);
        assert.equal((await reader.lookup('営業時間')).status, 'unknown');

        const restored = await service.restore(editor, 'COR-K-W3');
        assert.equal(restored.state, 'draft');
        assert.equal(restored.deletedAt, null);
        // Restore never republishes — still unknown until a new release.
        assert.equal((await reader.lookup('営業時間')).status, 'unknown');
    });
});

describe('knowledge tool (voice path)', () => {
    it('returns found with bounded whitelisted fields only', async () => {
        const { service, repo } = setup();
        const record = await service.createDraft(
            editor,
            baseDraft({ operatorNote: '社内メモ — 絶対に返さない' }),
            'COR-K-T10'
        );
        await approveAndPublish(service, record);
        const reader = new KnowledgeReader(repo);
        const result = await executeKnowledgeLookup(reader, JSON.stringify({ query: '営業時間を教えてください' }));
        assert.equal(result.status, 'found');
        assert.equal(result.items.length, 1);
        const item = result.items[0];
        assert.equal(item.answer, '営業時間は平日10時から18時です。');
        assert.ok(!('operatorNote' in item));
        assert.ok(!('value' in item) || typeof item.value === 'object');
        assert.equal(result.releaseId !== null, true);
    });

    it('drafts and admin_only never reach the tool — even when asked directly', async () => {
        const { service, repo } = setup();
        await service.createDraft(editor, baseDraft(), 'COR-K-T11');           // draft only
        await service.createDraft(editor, baseDraft({ key: 'internal', audience: 'admin_only' }), 'COR-K-T12');
        const reader = new KnowledgeReader(repo);
        const result = await executeKnowledgeLookup(reader, { query: '営業時間' });
        assert.equal(result.status, 'unavailable'); // no release exists at all
    });

    it('rejects malformed arguments and cannot widen access via extra fields', async () => {
        const { service, repo } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-T13');
        await approveAndPublish(service, record);
        const reader = new KnowledgeReader(repo);
        // includePrivate / collection / sql-style junk in args must be ignored
        const result = await executeKnowledgeLookup(reader, {
            query: '営業時間',
            includePrivate: true,
            collection: 'callLogs',
            filter: "'; DROP TABLE--"
        });
        assert.equal(result.status, 'found');
        assert.equal(result.items.length, 1);
    });

    it('tool definition exposes only query — no private/collection knobs', () => {
        const tool = buildLookupCompanyKnowledgeTool();
        assert.equal(tool.name, 'lookup_company_knowledge');
        assert.deepEqual(Object.keys(tool.parameters.properties), ['query']);
        assert.equal(tool.parameters.additionalProperties, false);
    });

    it('empty result set is unknown — not confused with a store failure', async () => {
        const { service, repo } = setup();
        const record = await service.createDraft(editor, baseDraft(), 'COR-K-T14');
        await approveAndPublish(service, record);
        const reader = new KnowledgeReader(repo);
        const result = await executeKnowledgeLookup(reader, { query: '存在しないトピックxyz' });
        assert.equal(result.status, 'unknown');
    });
});
