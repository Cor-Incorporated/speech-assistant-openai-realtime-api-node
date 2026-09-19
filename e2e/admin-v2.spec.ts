import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Admin v2 UI E2E — real Fastify server + in-memory repos, real browser.
 * Covers the acceptance flows: save → reload → conflict → delete →
 * restore → knowledge approve/publish → escalation acknowledge, plus the
 * negative check that a draft never appears as published content.
 */

const AUTH = { username: 'admin', password: 'e2e-secret' };

const api = async (
    request: APIRequestContext,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
) => {
    const response = await request.fetch(path, {
        method,
        data: body,
        headers: { 'content-type': 'application/json', ...headers }
    });
    return response;
};

const createKnowledge = (request: APIRequestContext, overrides: Record<string, unknown> = {}) => {
    const unique = Math.random().toString(36).slice(2, 8);
    return api(request, 'POST', '/api/admin/v2/knowledge', {
        key: `e2e.${unique}`,
        title: `E2E営業時間-${unique}`,
        category: 'hours',
        locale: 'ja-JP',
        keywords: ['営業時間'],
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
        ...overrides
    });
};

test.describe('admin v2 console', () => {
    test('knowledge: list → detail → approve → publish → status reflects release', async ({ page, request }) => {
        // Seed via API (UI has no create form by design — drafts come from import/manual entry)
        const created = await createKnowledge(request);
        expect(created.status()).toBe(201);
        const { knowledge } = await created.json();

        await page.goto('/app/#v2-knowledge');
        await page.getByRole('button', { name: '再読込' }).first().click();
        await page.getByRole('button', { name: new RegExp(knowledge.title) }).click();

        // Detail shows draft state and the approve action
        await expect(page.getByText('draft回答（rev 1）')).toBeVisible();

        // Approve this revision (content-hash bound)
        await page.getByRole('button', { name: 'この内容を承認' }).click();
        await expect(page.getByText('承認しました')).toBeVisible();

        // Publish a release — voice path may now serve it
        await page.getByRole('button', { name: '公開releaseを作成' }).click();
        await expect(page.getByText('公開releaseを作成しました')).toBeVisible();

        // Status page reflects the new release
        await page.getByRole('button', { name: 'ステータス', exact: true }).click();
        await expect(page.getByText('現在のrelease')).toBeVisible();
        const statusRes = await api(request, 'GET', '/api/admin/v2/status');
        const status = await statusRes.json();
        expect(status.knowledge.currentReleaseId).toBeTruthy();
        expect(status.knowledge.byState.published).toBeGreaterThanOrEqual(1);
        void knowledge;
    });

    test('knowledge: draft preview never claims voice use', async ({ page, request }) => {
        const created = await createKnowledge(request);
        expect(created.status()).toBe(201);
        const { knowledge } = await created.json();

        await page.goto('/app/#v2-knowledge');
        await page.getByRole('button', { name: new RegExp(knowledge.title) }).click();
        await page.getByRole('button', { name: '公開プレビュー' }).click();
        await expect(page.getByText(/公開releaseに含まれるまで電話応答には使われません/)).toBeVisible();
        void knowledge;
    });

    test('knowledge: edit conflict shows reload guidance (If-Match)', async ({ page, request }) => {
        const created = await createKnowledge(request);
        const { knowledge } = await created.json();

        await page.goto('/app/#v2-knowledge');
        await page.getByRole('button', { name: new RegExp(knowledge.title) }).click();
        await page.getByRole('button', { name: '編集', exact: true }).click();

        // Concurrent write: someone else bumps the record while our tab holds the old ETag
        const detail = await api(request, 'GET', `/api/admin/v2/knowledge/${knowledge.knowledgeId}`);
        const etag = detail.headers()['etag'];
        const concurrent = await api(request, 'PATCH', `/api/admin/v2/knowledge/${knowledge.knowledgeId}`, {
            key: knowledge.key,
            title: '別の人が更新したタイトル',
            category: 'hours',
            locale: 'ja-JP',
            keywords: [],
            audience: 'public',
            handling: 'answer_after_approval',
            riskLevel: 'normal',
            value: { weekday: '10:00-18:00' },
            answerJa: '競合する更新',
            answerType: 'fact',
            evidenceState: 'official_site_observed',
            sourceRefs: [{ sourceId: 'PUB-01' }],
            asOf: '2026-09-19',
            validity: { effectiveFrom: null, expiresAt: null, nextReviewAt: null }
        }, { 'if-match': etag });
        expect(concurrent.status()).toBe(200);

        // Our stale save must fail with conflict guidance — never a fake success
        await page.getByRole('button', { name: '保存（新rev作成）' }).click();
        await expect(page.getByText(/他の人が先に更新しました/)).toBeVisible();
        await expect(page.getByText('保存しました')).not.toBeVisible();
    });

    test('calls: manual call → status update persists after reload → delete → restore', async ({ page, request }) => {
        const created = await api(request, 'POST', '/api/admin/v2/calls', {
            summary: 'E2Eテスト受付',
            callerName: 'E2E顧客',
            contact: '09011112222'
        }, { 'idempotency-key': `e2e-${Date.now()}` });
        expect(created.status()).toBe(201);
        const { call } = await created.json();

        await page.goto('/app/#v2-calls');
        await page.getByRole('button', { name: /E2Eテスト受付/ }).click();

        // Update status with required change reason
        await page.getByRole('combobox', { name: '状態', exact: true }).selectOption('done');
        await page.getByLabel(/変更理由/).fill('E2E対応完了');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByText('保存しました')).toBeVisible();

        // Reload — the persisted value must come back from the server
        await page.reload();
        await page.getByRole('button', { name: /E2Eテスト受付/ }).click();
        await expect(page.getByRole('combobox', { name: '状態', exact: true })).toHaveValue('done');

        // Delete (window.confirm/prompt handling)
        page.once('dialog', (dialog) => dialog.accept('E2E削除テスト'));
        await page.getByRole('button', { name: '削除', exact: true }).click();
        await expect(page.getByText('削除しました')).toBeVisible();

        // Restore — no external side effects by contract
        await page.getByRole('button', { name: '復元' }).click();
        await expect(page.getByText('復元しました')).toBeVisible();
        void call;
    });

    test('escalations: notify ≠ acknowledge; ACK binds the acting subject', async ({ page, request }) => {
        const created = await api(request, 'POST', '/api/admin/v2/escalations', {
            importance: 'critical',
            summary: 'E2E重大案件'
        });
        expect(created.status()).toBe(201);

        await page.goto('/app/#v2-escalations');
        await page.getByLabel('未受諾のみ').uncheck();
        await expect(page.getByText('E2E重大案件')).toBeVisible();

        // Record a notification — state becomes notified, still NOT acknowledged
        await page.getByRole('button', { name: '通知を記録' }).click();
        await expect(page.getByText('通知を記録しました（受諾ではありません）')).toBeVisible();

        // Human acknowledge — bound to the e2e subject
        await page.getByRole('button', { name: /受諾する（ACK）/ }).click();
        await expect(page.getByText('受諾を記録しました')).toBeVisible();

        const detail = await api(request, 'GET', '/api/admin/v2/escalations?limit=50');
        const list = await detail.json();
        const esc = list.items.find((e: { summary: string }) => e.summary === 'E2E重大案件');
        expect(esc.state).toBe('acknowledged');
        expect(esc.acknowledgedBy).toBe('e2e@cor.example');
    });
});
