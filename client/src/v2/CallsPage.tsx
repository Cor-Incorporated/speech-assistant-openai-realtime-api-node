import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiWrite, idempotencyKey } from './api';
import type { CallCorrection, CallRecord, ListResult } from './types';
import { Button, Empty, ErrorBanner, Field, inputClass, Section, StateBadge, formatDate } from './ui';

interface Detail {
    call: CallRecord;
    corrections: CallCorrection[];
}

const STATUS_OPTIONS = [
    ['new', '新規'],
    ['in_progress', '対応中'],
    ['needs_callback', '折り返し要'],
    ['done', '対応完了']
] as const;

export default function CallsPage() {
    const [items, setItems] = useState<CallRecord[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [partial, setPartial] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState('');
    const [includeDeleted, setIncludeDeleted] = useState(false);

    const load = useCallback(async (cursor?: string) => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: '50' });
            if (statusFilter) params.set('businessState', statusFilter);
            if (includeDeleted) params.set('includeDeleted', 'true');
            if (cursor) params.set('cursor', cursor);
            const { body } = await apiGet<ListResult<CallRecord> & { partial?: boolean }>(`/api/admin/v2/calls?${params}`);
            if (cursor) {
                setItems((prev) => [...prev, ...body.items]);
            } else {
                setItems(body.items);
            }
            setNextCursor(body.nextCursor);
            setPartial(body.partial === true);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, [statusFilter, includeDeleted]);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Section
                title="通話一覧（v2）"
                actions={
                    <div className="flex items-center gap-2">
                        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass} aria-label="対応状態フィルタ">
                            <option value="">すべて</option>
                            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                        <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
                            削除済み含む
                        </label>
                        <Button onClick={() => void load()} disabled={loading}>再読込</Button>
                    </div>
                }
            >
                <ErrorBanner error={error} />
                {partial && <p className="text-xs text-amber-700">結果は一部のみ表示されています（継続読み込みまたはフィルタを使用してください）</p>}
                {!loading && items.length === 0 && <Empty>該当する通話がありません</Empty>}
                <ul className="grid gap-2">
                    {items.map((call) => (
                        <li key={call.callId}>
                            <button
                                type="button"
                                onClick={() => setSelected(call.callId)}
                                className={`w-full rounded border p-3 text-left text-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 ${selected === call.callId ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}
                                aria-pressed={selected === call.callId}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium">{call.effective?.summary ?? call.effective?.callerName ?? call.callId}</span>
                                    <StateBadge state={call.ops.status} />
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                                    <span>{formatDate(call.startedAt)}</span>
                                    {call.origin === 'manual' && <span className="rounded bg-sky-100 px-1.5 text-sky-800">手動登録</span>}
                                    {call.fromNumberMasked && <span>{call.fromNumberMasked}</span>}
                                    {call.deletedAt && <span className="text-red-700">削除済み</span>}
                                </div>
                            </button>
                        </li>
                    ))}
                </ul>
                {nextCursor && (
                    <Button onClick={() => void load(nextCursor)} disabled={loading}>
                        {loading ? '読込中' : 'さらに読み込む'}
                    </Button>
                )}
            </Section>
            {selected ? (
                <CallDetail callId={selected} onChanged={() => void load()} />
            ) : (
                <Section title="詳細"><Empty>左の一覧から通話を選択してください</Empty></Section>
            )}
        </div>
    );
}

function CallDetail({ callId, onChanged }: { callId: string; onChanged: () => void }) {
    const [detail, setDetail] = useState<Detail | null>(null);
    const [etag, setEtag] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [editStatus, setEditStatus] = useState('new');
    const [editNote, setEditNote] = useState('');
    const [changeReason, setChangeReason] = useState('');

    const load = useCallback(async () => {
        setError(null);
        try {
            const { body, etag: tag } = await apiGet<Detail>(`/api/admin/v2/calls/${encodeURIComponent(callId)}?includeDeleted=true`);
            setDetail(body);
            setEtag(tag);
            setEditStatus(body.call.ops.status);
            setEditNote(body.call.effective?.memo ?? '');
        } catch (err) {
            setError(err);
        }
    }, [callId]);

    useEffect(() => {
        void load();
    }, [load]);

    const run = async (fn: () => Promise<unknown>, done: string) => {
        setBusy(true);
        setActionError(null);
        setNotice('');
        try {
            await fn();
            setNotice(done);
            setChangeReason('');
            await load();
            onChanged();
        } catch (err) {
            setActionError(err);
        } finally {
            setBusy(false);
        }
    };

    if (error) return <Section title="詳細"><ErrorBanner error={error} /></Section>;
    if (!detail) return <Section title="詳細"><p className="text-sm text-slate-500">読み込み中…</p></Section>;

    const { call, corrections } = detail;
    const activeCorrections = corrections.filter((c) => c.active);

    return (
        <Section title={`通話 ${call.callId}`} actions={call.deletedAt ? <span className="text-xs text-red-700">削除済み {formatDate(call.deletedAt)}</span> : null}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-slate-500">開始</dt><dd>{formatDate(call.startedAt)}</dd>
                <dt className="text-slate-500">終了</dt><dd>{formatDate(call.endedAt)}</dd>
                <dt className="text-slate-500">発信元</dt><dd>{call.fromNumberMasked ?? '-'}</dd>
                <dt className="text-slate-500">発信者名</dt><dd>{call.effective?.callerName ?? '-'}</dd>
                <dt className="text-slate-500">折返し先</dt><dd>{call.effective?.callbackNumber ?? '-'}</dd>
                <dt className="text-slate-500">重要度</dt><dd>{call.severity?.importance ?? '-'}</dd>
                <dt className="text-slate-500">要約</dt><dd className="col-span-1">{call.effective?.summary ?? '-'}</dd>
            </dl>

            {call.extraction && Object.keys(call.extraction).length > 0 && (
                <details className="rounded border border-slate-200 p-2 text-xs">
                    <summary className="cursor-pointer text-slate-600">AI抽出値（訂正前の元データ）</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(call.extraction, null, 2)}</pre>
                </details>
            )}

            <ErrorBanner error={actionError} />
            {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" role="status">{notice}</p>}

            {!call.deletedAt && (
                <div className="grid gap-2 rounded border border-slate-300 p-3">
                    <p className="text-sm font-medium">対応状態の更新（If-Matchによる競合検出あり）</p>
                    <div className="flex flex-wrap items-end gap-2">
                        <Field label="状態">
                            <select className={inputClass} value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                                {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </Field>
                        <Field label="メモ">
                            <input className={inputClass} value={editNote} onChange={(e) => setEditNote(e.target.value)} />
                        </Field>
                        <Field label="変更理由（必須）" >
                            <input className={inputClass} value={changeReason} onChange={(e) => setChangeReason(e.target.value)} placeholder="例: 折り返し完了を確認" />
                        </Field>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="primary"
                            disabled={busy || !changeReason.trim()}
                            onClick={() => void run(() =>
                                apiWrite('PATCH', `/api/admin/v2/calls/${callId}`, {
                                    ops: { status: editStatus },
                                    effective: { memo: editNote || null },
                                    changeReason
                                }, { 'if-match': etag ?? '' }),
                                '保存しました')}
                        >
                            {busy ? '保存中' : '保存'}
                        </Button>
                        <Button
                            variant="danger"
                            disabled={busy}
                            onClick={() => {
                                const reason = window.prompt('削除理由（必須）');
                                if (!reason) return;
                                void run(() =>
                                    apiWrite('DELETE', `/api/admin/v2/calls/${callId}`, { reason }, { 'if-match': etag ?? '' }),
                                    '削除しました（監査ログに記録 — 復元可能）');
                            }}
                        >
                            削除
                        </Button>
                    </div>
                </div>
            )}

            {call.deletedAt && (
                <Button
                    disabled={busy}
                    onClick={() => void run(() => apiWrite('POST', `/api/admin/v2/calls/${callId}/restore`), '復元しました（外部副作用は復元されません）')}
                >
                    復元
                </Button>
            )}

            <div>
                <p className="text-sm font-medium text-slate-700">訂正履歴（{activeCorrections.length}/{corrections.length}件有効）</p>
                {corrections.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">訂正はありません</p>
                ) : (
                    <ul className="mt-1 grid gap-1 text-xs">
                        {corrections.map((c) => (
                            <li key={c.correctionId} className={`rounded border p-2 ${c.active ? 'border-slate-200' : 'border-slate-100 text-slate-400 line-through'}`}>
                                <span className="font-medium">{c.field}</span>: {JSON.stringify(c.previousValue)} → {JSON.stringify(c.correctedValue)}
                                <span className="ml-2 text-slate-500">{c.correctedBy} @ {formatDate(c.createdAt)} — {c.reason}</span>
                                {c.active && (
                                    <Button
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={() => {
                                            const reason = window.prompt('取り消し理由');
                                            if (!reason) return;
                                            void run(() =>
                                                apiWrite('DELETE', `/api/admin/v2/calls/${callId}/corrections/${c.correctionId}`, { reason }),
                                                '訂正を取り消しました');
                                        }}
                                    >
                                        取消
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Section>
    );
}
