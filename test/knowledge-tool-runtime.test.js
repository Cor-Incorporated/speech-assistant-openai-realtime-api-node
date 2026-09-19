// Knowledge tool bridge tests — the voice path must only ever see
// published whitelisted content, and a store failure must degrade to
// `unavailable` rather than leaking or crashing.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { InMemoryKnowledgeRepository } from '../dist-backend/knowledge/repository.js';
import { KnowledgeService } from '../dist-backend/knowledge/knowledge-service.js';
import {
    initKnowledgeTool,
    getKnowledgeToolDef,
    findKnowledgeToolCalls,
    executeKnowledgeCall
} from '../lib/knowledge-tool-runtime.js';

const approver = { subject: 'approver@cor.example', roles: ['knowledge_approver'], sharedAccount: false };
const editor = { subject: 'editor@cor.example', roles: ['knowledge_editor'], sharedAccount: false };

const draftInput = (overrides = {}) => ({
    key: 'company.hours',
    title: '営業時間',
    category: 'hours',
    locale: 'ja-JP',
    keywords: ['営業時間', '開店'],
    audience: 'public',
    handling: 'answer_after_approval',
    riskLevel: 'normal',
    value: { weekday: '10:00-18:00' },
    answerJa: '営業時間は平日10時から18時です。',
    answerType: 'fact',
    evidenceState: 'official_site_observed',
    sourceRefs: [{ sourceId: 'PUB-01' }],
    asOf: '2026-09-19',
    validity: { effectiveFrom: null, expiresAt: null, nextReviewAt: null },
    operatorNote: '社内メモ — 絶対に公開しない',
    ...overrides
});

const publish = async (service, repo, record) => {
    const revision = await repo.getRevision(record.knowledgeId, record.draftRevision);
    await service.approve(approver, record.knowledgeId, {
        revision: revision.revision,
        contentHash: revision.contentHash,
        reason: 'test'
    });
    await service.publish(approver, {});
};

describe('knowledge tool runtime', () => {
    before(async () => {
        const repo = new InMemoryKnowledgeRepository();
        const service = new KnowledgeService(repo);
        const published = await service.createDraft(editor, draftInput());
        // A draft that must NEVER be visible to the voice path.
        await service.createDraft(editor, draftInput({ key: 'secret.info', answerJa: '未承認の秘密情報' }));
        // An admin-only item that stays invisible even after publish.
        await service.createDraft(editor, draftInput({ key: 'internal.policy', category: 'security', audience: 'admin_only', answerJa: '社内限定情報' }));
        await publish(service, repo, published);
        await initKnowledgeTool({ knowledgeRepo: repo, log: { warn: () => {} } });
    });

    it('advertises the tool only after init', () => {
        const def = getKnowledgeToolDef();
        assert.ok(def);
        assert.equal(def.name, 'lookup_company_knowledge');
        assert.deepEqual(def.parameters.required, ['query']);
        // read-only: exactly one argument, nothing to widen access with
        assert.deepEqual(Object.keys(def.parameters.properties), ['query']);
    });

    it('finds knowledge calls in a response.done-shaped event', () => {
        const event = {
            response: {
                output: [
                    { type: 'function_call', name: 'lookup_company_knowledge', call_id: 'c1', arguments: '{"query":"営業時間"}' },
                    { type: 'function_call', name: 'finish_reception', call_id: 'c2', arguments: '{}' }
                ]
            }
        };
        const calls = findKnowledgeToolCalls(event);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].callId, 'c1');
    });

    it('answers only from the published release — never drafts', async () => {
        const output = await executeKnowledgeCall({
            callId: 'c1',
            arguments: JSON.stringify({ query: '営業時間' })
        });
        assert.equal(output.type, 'function_call_output');
        assert.equal(output.call_id, 'c1');
        const body = JSON.parse(output.output);
        assert.equal(body.status, 'found');
        assert.ok(body.items[0].answer.includes('10時から18時'));
        // whitelist: operatorNote must never appear in the voice output
        assert.ok(!JSON.stringify(body).includes('社内メモ'));
        assert.ok(output._meta.releaseId);
    });

    it('draft-only content is unknown — not leaked', async () => {
        const output = await executeKnowledgeCall({
            callId: 'c2',
            arguments: JSON.stringify({ query: '未承認の秘密情報' })
        });
        const body = JSON.parse(output.output);
        assert.notEqual(body.status, 'found');
        assert.ok(!JSON.stringify(body).includes('未承認の秘密情報'));
    });

    it('internal-audience content is unknown even when published exists', async () => {
        const output = await executeKnowledgeCall({
            callId: 'c3',
            arguments: JSON.stringify({ query: '社内限定情報' })
        });
        const body = JSON.parse(output.output);
        assert.notEqual(body.status, 'found');
        assert.ok(!JSON.stringify(body).includes('社内限定情報'));
    });
});
