import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiWrite } from './api';
import type { EscalationCase, ListResult } from './types';
import { Button, Empty, ErrorBanner, Section, StateBadge, formatDate } from './ui';

export default function EscalationsPage() {
    const [items, setItems] = useState<EscalationCase[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);
    const [unackOnly, setUnackOnly] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [notice, setNotice] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: '200' });
            if (unackOnly) params.set('unacknowledged', 'true');
            const { body } = await apiGet<ListResult<EscalationCase>>(`/api/admin/v2/escalations?${params}`);
            setItems(body.items);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, [unackOnly]);

    useEffect(() => {
        void load();
    }, [load]);

    const act = async (caseId: string, action: 'acknowledge' | 'resolve' | 'notify-requests', label: string) => {
        setBusyId(caseId);
        setActionError(null);
        setNotice('');
        try {
            let body: Record<string, unknown> | undefined;
            if (action === 'resolve') {
                const note = window.prompt('解決メモ（必須）');
                if (!note) { setBusyId(null); return; }
                body = { note };
            }
            await apiWrite('POST', `/api/admin/v2/escalations/${encodeURIComponent(caseId)}/${action}`, body);
            setNotice(label);
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
                <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1 text-sm">
                        <input type="checkbox" checked={unackOnly} onChange={(e) => setUnackOnly(e.target.checked)} />
                        未受諾のみ
                    </label>
                    <Button onClick={() => void load()} disabled={loading}>{loading ? '読込中' : '再読込'}</Button>
                </div>
            }
        >
            <p className="text-xs text-slate-500">
                通知送信と人間の受諾は別の状態です。受諾は本人の操作（ACK）でだけ記録されます。
            </p>
            <ErrorBanner error={error} />
            <ErrorBanner error={actionError} />
            {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" role="status">{notice}</p>}
            {!loading && items.length === 0 && <Empty>{unackOnly ? '未受諾のエスカレーションはありません' : 'エスカレーションがありません'}</Empty>}
            <ul className="grid gap-2">
                {items.map((esc) => (
                    <li key={esc.caseId} className="rounded border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${esc.importance === 'critical' ? 'bg-red-100 text-red-800' : esc.importance === 'high' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
                                    {esc.importance === 'critical' ? '重大' : esc.importance === 'high' ? '高' : '通常'}
                                </span>
                                <StateBadge state={esc.state} />
                            </div>
                            <span className="text-xs text-slate-500">{formatDate(esc.createdAt)}</span>
                        </div>
                        <p className="mt-1 text-sm">{esc.summary ?? '(要約なし)'}</p>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 md:grid-cols-4">
                            <div><dt className="inline text-slate-400">通知: </dt><dd className="inline">{formatDate(esc.notifiedAt)}</dd></div>
                            <div><dt className="inline text-slate-400">受諾: </dt><dd className="inline">{esc.acknowledgedBy ? `${esc.acknowledgedBy} @ ${formatDate(esc.acknowledgedAt)}` : '未受諾'}</dd></div>
                            <div><dt className="inline text-slate-400">期限: </dt><dd className="inline">{formatDate(esc.ackDeadlineAt)}</dd></div>
                            <div><dt className="inline text-slate-400">解決: </dt><dd className="inline">{esc.resolvedBy ? `${esc.resolvedBy} @ ${formatDate(esc.resolvedAt)}` : '-'}</dd></div>
                        </dl>
                        {esc.state !== 'resolved' && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {(esc.state === 'required' || esc.state === 'assigned') && (
                                    <Button disabled={busyId === esc.caseId} onClick={() => void act(esc.caseId, 'notify-requests', '通知を記録しました（受諾ではありません）')}>
                                        通知を記録
                                    </Button>
                                )}
                                {esc.state !== 'acknowledged' && esc.state !== 'connected' && esc.state !== 'connecting' && (
                                    <Button variant="primary" disabled={busyId === esc.caseId} onClick={() => void act(esc.caseId, 'acknowledge', '受諾を記録しました（あなたのsubjectに紐付きます）')}>
                                        {busyId === esc.caseId ? '記録中' : '受諾する（ACK）'}
                                    </Button>
                                )}
                                <Button disabled={busyId === esc.caseId} onClick={() => void act(esc.caseId, 'resolve', '解決済みにしました')}>
                                    解決
                                </Button>
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        </Section>
    );
}
