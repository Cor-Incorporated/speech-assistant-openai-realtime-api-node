import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiWrite } from './api';
import type { EscalationCase, ListResult } from './types';
import { Button, Empty, ErrorBanner, Field, inputClass, Section, StateBadge, formatDate } from './ui';

interface NotificationResult {
    notification: { ok: boolean; status: string; reason?: string };
    note?: string;
}

export default function EscalationsPage() {
    const [items, setItems] = useState<EscalationCase[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);
    const [unackOnly, setUnackOnly] = useState(true);
    const [overdueOnly, setOverdueOnly] = useState(false);
    const [partial, setPartial] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const loadVersion = useRef(0);

    const load = useCallback(async (cursor?: string) => {
        const version = ++loadVersion.current;
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: '200' });
            if (unackOnly) params.set('unacknowledged', 'true');
            if (overdueOnly) params.set('overdue', 'true');
            if (cursor) params.set('cursor', cursor);
            const { body } = await apiGet<ListResult<EscalationCase>>(`/api/admin/v2/escalations?${params}`);
            if (version !== loadVersion.current) return;
            setItems((previous) => cursor ? [...previous, ...body.items] : body.items);
            setPartial(body.partial === true);
            setNextCursor(body.nextCursor);
        } catch (err) {
            if (version === loadVersion.current) setError(err);
        } finally {
            if (version === loadVersion.current) setLoading(false);
        }
    }, [unackOnly, overdueOnly]);

    useEffect(() => {
        void load();
        return () => { loadVersion.current += 1; };
    }, [load]);

    const act = async (caseId: string, action: 'acknowledge' | 'resolve' | 'notify-requests', label: string) => {
        setBusyId(caseId);
        setActionError(null);
        setNotice('');
        try {
            let payload: Record<string, unknown> | undefined;
            if (action === 'resolve') {
                const note = window.prompt('解決メモ（必須）');
                if (!note?.trim()) return;
                payload = { note: note.trim() };
            }
            const { body } = await apiWrite<NotificationResult>('POST', `/api/admin/v2/escalations/${encodeURIComponent(caseId)}/${action}`, payload);
            setNotice(action === 'notify-requests'
                ? body.note ?? (body.notification.ok ? '通知の送信を受け付けました。担当者の受諾は別途確認してください。' : '通知は処理中です。送信受付はまだ確認できていません。')
                : label);
            await load();
        } catch (err) {
            setActionError(err);
        } finally {
            setBusyId(null);
        }
    };

    return (
        <Section
            title="エスカレーション"
            actions={
                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1 text-sm">
                        <input type="checkbox" checked={unackOnly} onChange={(e) => setUnackOnly(e.target.checked)} />未受諾のみ
                    </label>
                    <label className="flex items-center gap-1 text-sm">
                        <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />受諾期限超過のみ
                    </label>
                    <Button onClick={() => void load()} disabled={loading}>{loading ? '読込中' : '再読込'}</Button>
                </div>
            }
        >
            <p className="text-pretty text-xs text-slate-500">通知の送信受付と担当者の受諾は別の状態です。担当者が「受諾する」を押すと受諾を記録します。</p>
            <ErrorBanner error={error} />
            <ErrorBanner error={actionError} />
            {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-pretty text-sm text-emerald-800" role="status">{notice}</p>}
            {partial && <p className="text-pretty text-xs text-amber-800">一覧の取得範囲が制限されています。表示外に対象の案件が残っている可能性があります。</p>}
            {!loading && items.length === 0 && <Empty>{partial ? '取得できた範囲に該当案件はありません。全件は確認できていません。' : overdueOnly ? '受諾期限を超過した案件はありません' : unackOnly ? '未受諾のエスカレーションはありません' : 'エスカレーションがありません'}</Empty>}
            <ul className="grid gap-3">
                {items.map((esc) => (
                    <li key={esc.caseId} className="rounded border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">重要度: {esc.importance === 'critical' ? '重大' : esc.importance === 'high' ? '高' : '通常'}</span>
                                <StateBadge state={esc.state} />
                                {esc.ackOverdue && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">受諾期限超過</span>}
                            </div>
                            <span className="text-xs tabular-nums text-slate-500">{formatDate(esc.createdAt)}</span>
                        </div>
                        <p className="mt-2 text-pretty text-sm">{esc.summary ?? '(要約なし)'}</p>
                        <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                            <div><dt className="text-slate-500">通知の送信受付</dt><dd>{formatDate(esc.notifiedAt)}</dd></div>
                            <div><dt className="text-slate-500">担当者の受諾</dt><dd>{esc.acknowledgedBy ? `${esc.acknowledgedBy} @ ${formatDate(esc.acknowledgedAt)}` : '未受諾'}</dd></div>
                            <div><dt className="text-slate-500">受諾期限</dt><dd>{formatDate(esc.ackDeadlineAt)}</dd></div>
                            <div><dt className="text-slate-500">解決</dt><dd>{esc.resolvedBy ? `${esc.resolvedBy} @ ${formatDate(esc.resolvedAt)}` : '-'}</dd></div>
                        </dl>
                        {esc.state !== 'resolved' && <>
                            <AssignmentForm key={`${esc.caseId}-${esc.recordVersion}`} escalation={esc} disabled={busyId !== null} onChanged={load} />
                            <div className="mt-3 flex flex-wrap gap-2">
                                {(esc.state === 'required' || esc.state === 'assigned') && <Button disabled={busyId !== null} onClick={() => void act(esc.caseId, 'notify-requests', '')}>通知を送信</Button>}
                                {esc.state !== 'acknowledged' && esc.state !== 'connected' && esc.state !== 'connecting' && <Button variant="primary" disabled={busyId !== null} onClick={() => void act(esc.caseId, 'acknowledge', '受諾を記録しました（操作した担当者に紐付きます）')}>{busyId === esc.caseId ? '記録中' : '受諾する（ACK）'}</Button>}
                                <Button disabled={busyId !== null} onClick={() => void act(esc.caseId, 'resolve', '解決済みにしました')}>解決</Button>
                            </div>
                        </>}
                    </li>
                ))}
            </ul>
            {nextCursor && <Button disabled={loading} onClick={() => void load(nextCursor)}>{loading ? '読込中' : 'さらに読み込む'}</Button>}
        </Section>
    );
}

const localDateTime = (value: string | null) => {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function AssignmentForm({ escalation, disabled, onChanged }: { escalation: EscalationCase; disabled: boolean; onChanged: () => Promise<void> }) {
    const [subject, setSubject] = useState(escalation.ownerSubject ?? '');
    const [role, setRole] = useState(escalation.ownerRole ?? '');
    const [deadline, setDeadline] = useState(localDateTime(escalation.ackDeadlineAt));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const save = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await apiWrite('PATCH', `/api/admin/v2/escalations/${encodeURIComponent(escalation.caseId)}`, {
                ownerSubject: subject.trim() || null,
                ownerRole: role || null,
                ackDeadlineAt: deadline ? new Date(deadline).toISOString() : null
            }, { 'if-match': `"esc-v${escalation.recordVersion}"` });
            await onChanged();
        } catch (err) {
            setError(err);
        } finally {
            setBusy(false);
        }
    };
    return <form className="mt-3 grid gap-2 rounded bg-slate-50 p-3" onSubmit={save}>
        <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="担当者ID"><input className={inputClass} maxLength={200} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="例: operator@example.jp" /></Field>
            <Field label="担当ロール"><select className={inputClass} value={role} onChange={(event) => setRole(event.target.value)}><option value="">指定なし</option><option value="operator">オペレーター</option><option value="supervisor">管理者</option></select></Field>
            <Field label="受諾期限"><input className={inputClass} type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></Field>
            <Button type="submit" disabled={disabled || busy}>{busy ? '保存中' : '担当・期限を保存'}</Button>
        </div>
        <ErrorBanner error={error} />
    </form>;
}
