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

        // Local email delivery is disabled: a failed send must not become
        // notification evidence or prevent a genuine human acknowledgement.
        await page.getByRole('button', { name: '通知を送信' }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        const beforeAck = (await created.json()).escalation;
        const failed = await api(request, 'GET', `/api/admin/v2/escalations/${beforeAck.caseId}`);
        expect((await failed.json()).escalation.notifiedAt).toBeNull();

        // Human acknowledge — bound to the e2e subject
        await page.getByRole('button', { name: /受諾する（ACK）/ }).click();
        await expect(page.getByText('受諾を記録しました')).toBeVisible();

        const detail = await api(request, 'GET', '/api/admin/v2/escalations?limit=50');
        const list = await detail.json();
        const esc = list.items.find((e: { summary: string }) => e.summary === 'E2E重大案件');
        expect(esc.state).toBe('acknowledged');
        expect(esc.acknowledgedBy).toBe('e2e@cor.example');
    });

    test('calls: create and correct entirely through the UI, then read back persisted values', async ({ page, request }) => {
        const title = `UI受付-${Date.now()}`;
        await page.goto('/app/#v2-calls');
        await page.getByRole('button', { name: '受付を手動登録', exact: true }).click();
        await page.getByLabel('要約（必須）', { exact: true }).fill(title);
        await page.getByLabel('発信者名', { exact: true }).fill('合成テスト顧客');
        await page.getByLabel('担当者', { exact: true }).fill('担当A');
        const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/admin/v2/calls'));
        await page.getByRole('button', { name: '受付を登録', exact: true }).click();
        const response = await created;
        expect(response.status()).toBe(201);
        const { call } = await response.json();
        await page.getByLabel('発信者名', { exact: true }).fill('確認済みの合成顧客');
        await page.getByLabel('担当者', { exact: true }).fill('担当B');
        await page.getByRole('combobox', { name: '折返し状況', exact: true }).selectOption('pending');
        await page.getByLabel('変更理由（必須）', { exact: true }).fill('氏名と担当を確認');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByText('保存しました', { exact: true })).toBeVisible();
        await expect(page.getByText(/合成テスト顧客.*→.*確認済みの合成顧客/)).toBeVisible();
        const detail = await (await api(request, 'GET', `/api/admin/v2/calls/${call.callId}`)).json();
        expect(detail.call.effective.callerName).toBe('確認済みの合成顧客');
        expect(detail.call.ops.assignee).toBe('担当B');
        expect(detail.call.ops.callbackStatus).toBe('pending');
        expect(detail.corrections.some((correction: { createdBy: string }) => correction.createdBy === 'e2e@cor.example')).toBeTruthy();
        await page.reload();
        await page.getByRole('button', { name: new RegExp(title) }).click();
        await expect(page.getByLabel('担当者', { exact: true })).toHaveValue('担当B');
        await page.screenshot({ path: 'test-results/admin-call-workflow-desktop.png', fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/admin-call-workflow-mobile.png', fullPage: true });
    });

    test('calls: changing selection during a delayed read cannot write the previous call into the next', async ({ page, request }) => {
        const create = async (summary: string) => (await (await api(request, 'POST', '/api/admin/v2/calls', { summary }, { 'idempotency-key': summary })).json()).call;
        const a = await create(`race-A-${Date.now()}`);
        const b = await create(`race-B-${Date.now()}`);
        await page.goto('/app/#v2-calls');
        await page.getByRole('button', { name: new RegExp(a.effective.summary) }).click();
        await page.getByLabel('メモ', { exact: true }).fill('Aのみに属するメモ');
        await page.getByLabel('変更理由（必須）', { exact: true }).fill('Aの編集');
        let release!: () => void;
        let seen!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const intercepted = new Promise<void>((resolve) => { seen = resolve; });
        await page.route(`**/api/admin/v2/calls/${b.callId}?includeDeleted=true`, async (route) => { seen(); await gate; await route.continue(); });
        await page.getByRole('button', { name: new RegExp(b.effective.summary) }).click();
        await intercepted;
        try {
            await expect(page.getByRole('heading', { name: `通話 ${a.callId}`, exact: true })).toHaveCount(0);
            await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
        } finally { release(); }
        await expect(page.getByRole('heading', { name: `通話 ${b.callId}`, exact: true })).toBeVisible();
        await expect(page.getByLabel('メモ', { exact: true })).toHaveValue('');
        const readback = await (await api(request, 'GET', `/api/admin/v2/calls/${b.callId}`)).json();
        expect(readback.call.effective.memo).toBeNull();
        expect(readback.call.ops.status).toBe('new');
    });

    test('escalations: assign a deadline and find the overdue case without faking notification', async ({ page, request }) => {
        const summary = `期限テスト-${Date.now()}`;
        const created = await api(request, 'POST', '/api/admin/v2/escalations', { importance: 'high', summary });
        const { escalation } = await created.json();
        await page.goto('/app/#v2-escalations');
        const item = page.getByRole('listitem').filter({ hasText: summary });
        await item.getByLabel('担当者ID', { exact: true }).fill('operator@cor.example');
        await item.getByRole('combobox', { name: '担当ロール', exact: true }).selectOption('operator');
        await item.getByLabel('受諾期限', { exact: true }).fill('2026-01-01T09:00');
        await item.getByRole('button', { name: '担当・期限を保存' }).click();
        await expect(item.getByText('受諾期限超過', { exact: true })).toBeVisible();
        await page.getByLabel('受諾期限超過のみ').check();
        await expect(item).toBeVisible();
        const readback = await (await api(request, 'GET', `/api/admin/v2/escalations/${escalation.caseId}`)).json();
        expect(readback.escalation.ownerSubject).toBe('operator@cor.example');
        expect(readback.escalation.ackOverdue).toBe(true);
        expect(readback.escalation.notifiedAt).toBeNull();
        await page.screenshot({ path: 'test-results/admin-escalation-workflow.png', fullPage: true });
    });
});
