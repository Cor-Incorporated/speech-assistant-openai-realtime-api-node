// Call record service tests — manual create, corrections, versioning,
// soft-delete/restore, idempotency. Acceptance contract: raw observations
// are never overwritten; every human change is a versioned correction.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { devActor } from '../dist-backend/admin/permissions.js';
import { InMemoryCallRepository } from '../dist-backend/calls/call-repository.js';
import { CallService, ServiceError } from '../dist-backend/calls/call-service.js';

const operator = devActor('op@example.com', ['operator']);
const supervisor = devActor('sup@example.com', ['supervisor']);
const viewer = devActor('view@example.com', ['viewer']);

const setup = () => {
    const repo = new InMemoryCallRepository();
    return { repo, service: new CallService(repo) };
};

const manualInput = (overrides = {}) => ({
    declaredAt: '2026-09-19T10:00:00+09:00',
    summary: '見積相談の受付',
    callerName: '山田太郎',
    contact: '090-1234-5678',
    severity: 'normal',
    ...overrides
});

describe('manual call create', () => {
    it('creates origin=manual, providerCallSid=null — no external side effects', async () => {
        const { service } = setup();
        const { record } = await service.createManual(operator, manualInput());
        assert.equal(record.origin, 'manual');
        assert.equal(record.providerCallSid, null);
        assert.equal(record.ops.status, 'new');
        assert.equal(record.ops.callbackStatus, 'pending');
    });

    it('rejects provider identifiers — a manual record cannot fake a real call', async () => {
        const { service } = setup();
        await assert.rejects(
            () => service.createManual(operator, { ...manualInput(), providerCallSid: 'CA123' }),
            (error) => error.statusCode === 422 && Boolean(error.fieldErrors.providerCallSid)
        );
    });

    it('Idempotency-Key: same body replays the record, different body is 409', async () => {
        const { service } = setup();
        const first = await service.createManual(operator, manualInput(), { idempotencyKey: 'key-1' });
        const replay = await service.createManual(operator, manualInput(), { idempotencyKey: 'key-1' });
        assert.equal(replay.replayed, true);
        assert.equal(replay.record.callId, first.record.callId);
        await assert.rejects(
            () => service.createManual(operator, manualInput({ summary: 'different' }), { idempotencyKey: 'key-1' }),
            (error) => error.statusCode === 409 && error.code === 'IDEMPOTENCY_CONFLICT'
        );
    });

    it('viewer cannot create manual records', async () => {
        const { service } = setup();
        await assert.rejects(
            () => service.createManual(viewer, manualInput()),
            (error) => error.statusCode === 403
        );
    });
});

describe('call patch + corrections', () => {
    it('updates effective fields with reason + records correction history', async () => {
        const { service, repo } = setup();
        const { record } = await service.createManual(operator, manualInput());
        const updated = await service.patch(operator, record.callId, {
            effective: { summary: '見積相談。担当者からの確認を希望。', callbackRequestedWindow: '平日午後' },
            ops: { status: 'needs_callback' },
            changeReason: '担当者が受付内容を補記'
        });
        assert.equal(updated.effective.summary, '見積相談。担当者からの確認を希望。');
        assert.equal(updated.ops.status, 'needs_callback');
        const corrections = await service.listCorrections(operator, record.callId);
        assert.equal(corrections.length, 3);
        assert.ok(corrections.every((c) => c.reason === '担当者が受付内容を補記'));
    });

    it('rejects patches without changeReason and unknown fields', async () => {
        const { service } = setup();
        const { record } = await service.createManual(operator, manualInput());
        await assert.rejects(
            () => service.patch(operator, record.callId, { effective: { summary: 'x' } }),
            (error) => error.statusCode === 422 && Boolean(error.fieldErrors.changeReason)
        );
        await assert.rejects(
            () => service.patch(operator, record.callId, { effective: { transcript: 'raw!' }, changeReason: 'r' }),
            (error) => error.statusCode === 422
        );
        await assert.rejects(
            () => service.patch(operator, record.callId, { providerCallSid: 'CA_fake', changeReason: 'r' }),
            (error) => error.statusCode === 422
        );
    });

    it('stale version → 412 conflict', async () => {
        const { service } = setup();
        const { record } = await service.createManual(operator, manualInput());
        await service.patch(operator, record.callId, {
            ops: { status: 'in_progress' },
            changeReason: 'first'
        }, record.recordVersion);
        await assert.rejects(
            () => service.patch(operator, record.callId, {
                ops: { status: 'done' },
                changeReason: 'second'
            }, record.recordVersion),
            (error) => error.code === 'VERSION_CONFLICT'
        );
    });

    it('revert restores prior value and records a reversal correction', async () => {
        const { service } = setup();
        const { record } = await service.createManual(operator, manualInput());
        const updated = await service.patch(operator, record.callId, {
            effective: { summary: 'new summary' },
            changeReason: 'edit'
        });
        const corrections = await service.listCorrections(operator, record.callId);
        const target = corrections.find((c) => c.target === 'summary');
        const reverted = await service.revertCorrection(operator, record.callId, target.correctionId, { reason: '誤入力のため取消' });
        assert.equal(reverted.effective.summary, '見積相談の受付');
        const after = await service.listCorrections(operator, record.callId);
        const original = after.find((c) => c.correctionId === target.correctionId);
        assert.equal(original.active, false);
        assert.ok(after.some((c) => c.reason.startsWith('revert:')));
    });
});

describe('delete / restore', () => {
    it('soft-delete hides from default list; restore brings it back without side effects', async () => {
        const { service } = setup();
        const { record } = await service.createManual(operator, manualInput());
        await service.softDelete(supervisor, record.callId, { reason: '重複登録のため' });
        const list = await service.list(operator, {});
        assert.equal(list.items.length, 0);
        const withDeleted = await service.list(operator, { includeDeleted: true });
        assert.equal(withDeleted.items.length, 1);

        const restored = await service.restore(supervisor, record.callId);
        assert.equal(restored.deletedAt, null);
        assert.equal((await service.list(operator, {})).items.length, 1);
    });

    it('guards: hold, active call, and open escalation refuse delete with reasons', async () => {
        const { service, repo } = setup();
        const { record } = await service.createManual(operator, manualInput());
        await repo.put({ ...record, hold: true }, record.recordVersion);
        await assert.rejects(
            () => service.softDelete(supervisor, record.callId, { reason: 'x' }),
            (error) => error.code === 'ON_HOLD'
        );

        const { record: active } = await service.createManual(operator, manualInput());
        await repo.put({ ...active, transportState: 'connected' }, active.recordVersion);
        await assert.rejects(
            () => service.softDelete(supervisor, active.callId, { reason: 'x' }),
            (error) => error.code === 'CALL_ACTIVE'
        );

        const { record: esc } = await service.createManual(operator, manualInput());
        await repo.put({ ...esc, humanCase: { ...esc.humanCase, state: 'notified' } }, esc.recordVersion);
        await assert.rejects(
            () => service.softDelete(supervisor, esc.callId, { reason: 'x' }),
            (error) => error.code === 'OPEN_ESCALATION'
        );
    });

    it('operator cannot delete — supervisor permission required', async () => {
        const { service } = setup();
        const { record } = await service.createManual(operator, manualInput());
        await assert.rejects(
            () => service.softDelete(operator, record.callId, { reason: 'x' }),
            (error) => error.statusCode === 403
        );
    });
});
