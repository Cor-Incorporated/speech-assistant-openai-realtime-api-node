import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiWrite, ApiError, idempotencyKey } from './api';
import type { CallCorrection, CallRecord, ListResult } from './types';
import { Button, Empty, ErrorBanner, Field, inputClass, Section, StateBadge, formatDate } from './ui';

interface Detail {
    call: CallRecord;
    corrections: CallCorrection[];
}

interface VoiceDetail {
    handoff: { status: string; summary: string | null; updatedAt: string | null } | null;
    voicemail: { status: 'completed' | 'absent'; durationSeconds: number | null; transcribed: boolean; notificationAccepted: boolean; playbackUrl: string | null } | null;
}

const STATUS_OPTIONS = [
    ['new', '新規'],
    ['in_progress', '対応中'],
    ['needs_callback', '折り返し要'],
    ['done', '対応完了']
] as const;

const CALLBACK_OPTIONS = [['', '未設定'], ['pending', '折り返し待ち'], ['completed', '折り返し完了'], ['not_required', '不要']] as const;
const EFFECTIVE_FIELDS = [
    ['summary', '要約'], ['callerName', '発信者名'], ['callerNameKana', '氏名の読み'],
    ['callbackNumber', '折返し先'], ['callbackRequestedWindow', '折返し希望日時'], ['intent', '用件'], ['memo', 'メモ']
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
    const [creating, setCreating] = useState(false);
    const loadVersion = useRef(0);

    const load = useCallback(async (cursor?: string) => {
        const version = ++loadVersion.current;
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: '50' });
            if (statusFilter) params.set('businessState', statusFilter);
            if (includeDeleted) params.set('includeDeleted', 'true');
            if (cursor) params.set('cursor', cursor);
            const { body } = await apiGet<ListResult<CallRecord> & { partial?: boolean }>(`/api/admin/v2/calls?${params}`);
            if (version !== loadVersion.current) return;
            if (cursor) {
                setItems((prev) => [...prev, ...body.items]);
            } else {
                setItems(body.items);
            }
            setNextCursor(body.nextCursor);
            setPartial(body.partial === true);
        } catch (err) {
            if (version === loadVersion.current) setError(err);
        } finally {
            if (version === loadVersion.current) setLoading(false);
        }
    }, [statusFilter, includeDeleted]);

    useEffect(() => {
        void load();
        return () => { loadVersion.current += 1; };
    }, [load]);

    return (
        <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-pretty text-sm text-slate-600">受付内容を確認し、担当者と折り返しの進捗を記録します。</p>
                <Button variant="primary" onClick={() => setCreating(!creating)}>{creating ? '登録フォームを閉じる' : '受付を手動登録'}</Button>
            </div>
            {creating && <ManualCallForm onCreated={(callId) => { setCreating(false); setSelected(callId); void load(); }} />}
        <div className="grid items-start gap-4 xl:grid-cols-2">
            <Section
                title="通話一覧（v2）"
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass} aria-label="対応状態フィルタ">
                            <option value="">すべて</option>
                            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                        <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs">
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
                <CallDetail key={selected} callId={selected} onChanged={() => void load()} />
            ) : (
                <Section title="詳細"><Empty>左の一覧から通話を選択してください</Empty></Section>
            )}
        </div>
        </div>
    );
}

function ManualCallForm({ onCreated }: { onCreated: (id: string) => void }) {
    const [values, setValues] = useState<Record<string, string>>({});
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    const submission = useRef<{ body: string; key: string } | null>(null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        const payload = { ...values, summary: values.summary?.trim(), contact: values.contact?.trim() || null };
        const body = JSON.stringify(payload);
        if (submission.current?.body !== body) submission.current = { body, key: idempotencyKey() };
        try {
            const { body: result } = await apiWrite<{ call: CallRecord }>('POST', '/api/admin/v2/calls', payload, { 'idempotency-key': submission.current.key });
            onCreated(result.call.callId);
        } catch (err) {
            setError(err);
        } finally {
            setBusy(false);
        }
    };
    return <Section title="受付を手動登録">
        <p className="text-pretty text-xs text-slate-500">来訪・メール・別の電話で受けた用件を登録します。</p>
        <form className="grid gap-3" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {([['summary', '要約（必須）'], ['callerName', '発信者名'], ['contact', '折返し先'], ['callbackRequestedWindow', '折返し希望日時'], ['assignee', '担当者'], ['memo', 'メモ']] as const).map(([key, label]) => <Field key={key} label={label}>
                    <input className={inputClass} value={values[key] ?? ''} required={key === 'summary'} type={key === 'contact' ? 'tel' : 'text'} onChange={(event) => setValues((previous) => ({ ...previous, [key]: event.target.value }))} />
                </Field>)}
            </div>
            <ErrorBanner error={error} />
            <div><Button type="submit" variant="primary" disabled={busy || !values.summary?.trim()}>{busy ? '登録中' : '受付を登録'}</Button></div>
        </form>
    </Section>;
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
    const [editEffective, setEditEffective] = useState<CallRecord['effective']>({});
    const [editAssignee, setEditAssignee] = useState('');
    const [editCallbackStatus, setEditCallbackStatus] = useState('');
    const [changeReason, setChangeReason] = useState('');
    const loadVersion = useRef(0);

    const load = useCallback(async () => {
        const version = ++loadVersion.current;
        setError(null);
        try {
            const { body, etag: tag } = await apiGet<Detail>(`/api/admin/v2/calls/${encodeURIComponent(callId)}?includeDeleted=true`);
            if (version !== loadVersion.current) return;
            setDetail(body);
            setEtag(tag);
            setEditStatus(body.call.ops.status);
            setEditNote(body.call.effective?.memo ?? '');
            setEditEffective(body.call.effective ?? {});
            setEditAssignee(body.call.ops.assignee ?? '');
            setEditCallbackStatus(body.call.ops.callbackStatus ?? '');
        } catch (err) {
            if (version === loadVersion.current) setError(err);
        }
    }, [callId]);

    useEffect(() => {
        void load();
        return () => { loadVersion.current += 1; };
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

    if (error) return <Section title="詳細"><ErrorBanner error={error} /><Button onClick={() => void load()}>再読み込み</Button></Section>;
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
                <dt className="text-slate-500">折返し希望日時</dt><dd>{call.effective?.callbackRequestedWindow ?? '-'}</dd>
                <dt className="text-slate-500">担当者</dt><dd>{call.ops.assignee ?? '未割当'}</dd>
                <dt className="text-slate-500">折返し状況</dt><dd>{CALLBACK_OPTIONS.find(([value]) => value === (call.ops.callbackStatus ?? ''))?.[1] ?? '-'}</dd>
                <dt className="text-slate-500">重要度</dt><dd>{call.severity?.importance ?? '-'}</dd>
                <dt className="text-slate-500">要約</dt><dd className="col-span-1">{call.effective?.summary ?? '-'}</dd>
            </dl>

            {!call.deletedAt && <VoicePanel callId={callId} />}

            {call.extraction && Object.keys(call.extraction).length > 0 && (
                <details className="rounded border border-slate-200 p-2 text-xs">
                    <summary className="cursor-pointer text-slate-600">AI抽出値（訂正前の元データ）</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(call.extraction, null, 2)}</pre>
                </details>
            )}

            <ErrorBanner error={actionError} />
            {actionError instanceof ApiError && actionError.isConflict && <Button onClick={() => void load()}>最新の内容を読み込む</Button>}
            {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" role="status">{notice}</p>}

            {!call.deletedAt && (
                <div className="grid gap-2 rounded border border-slate-300 p-3">
                    <p className="text-sm font-medium">受付内容・対応状態の更新</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="状態">
                            <select className={inputClass} value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                                {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </Field>
                        <Field label="折返し状況">
                            <select className={inputClass} value={editCallbackStatus} onChange={(e) => setEditCallbackStatus(e.target.value)}>
                                {CALLBACK_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </Field>
                        <Field label="担当者"><input className={inputClass} value={editAssignee} onChange={(e) => setEditAssignee(e.target.value)} /></Field>
                        {EFFECTIVE_FIELDS.map(([field, label]) => <Field key={field} label={label}>
                            <input className={inputClass} type={field === 'callbackNumber' ? 'tel' : 'text'} value={field === 'memo' ? editNote : editEffective[field] ?? ''} onChange={(e) => field === 'memo' ? setEditNote(e.target.value) : setEditEffective((previous) => ({ ...previous, [field]: e.target.value }))} />
                        </Field>)}
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
                                    ops: { status: editStatus, assignee: editAssignee.trim() || null, callbackStatus: editCallbackStatus || null },
                                    effective: { ...Object.fromEntries(EFFECTIVE_FIELDS.map(([field]) => [field, editEffective[field]?.trim() || null])), memo: editNote.trim() || null },
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
                                <span className="font-medium">{EFFECTIVE_FIELDS.find(([field]) => field === c.target)?.[1] ?? c.target}{c.targetRef ? `.${c.targetRef}` : ''}</span>: {JSON.stringify(c.previousValue)} → {JSON.stringify(c.newValue)}
                                <span className="ml-2 text-slate-500">{c.createdBy} @ {formatDate(c.createdAt)} — {c.reason}</span>
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

function VoicePanel({ callId }: { callId: string }) {
    const [voice, setVoice] = useState<VoiceDetail | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        let active = true;
        setError(null);
        void apiGet<VoiceDetail>(`/api/admin/v2/calls/${encodeURIComponent(callId)}/voice`).then(({ body }) => {
            if (active) setVoice(body);
        }).catch((err: unknown) => {
            if (active && !(err instanceof ApiError && err.status === 403)) setError(err);
        });
        return () => { active = false; };
    }, [callId, retry]);
    if (error) return <div className="grid gap-2"><ErrorBanner error={error} /><Button onClick={() => setRetry(retry + 1)}>音声情報を再読み込み</Button></div>;
    if (!voice?.handoff && !voice?.voicemail) return null;
    return <div className="grid gap-2 rounded border border-slate-200 p-3">
        <h3 className="text-balance text-sm font-medium">引き継ぎ・留守番電話</h3>
        {voice.handoff && <p className="whitespace-pre-wrap text-pretty text-sm">{voice.handoff.summary || '引き継ぎ要約はありません'}<span className="block text-xs text-slate-500">状態: {voice.handoff.status} · {formatDate(voice.handoff.updatedAt)}</span></p>}
        {voice.voicemail && <>
            <p className="text-pretty text-sm">{voice.voicemail.status === 'completed' ? '留守番電話あり' : '留守番電話なし'}{voice.voicemail.durationSeconds !== null && <span className="tabular-nums">（{voice.voicemail.durationSeconds}秒）</span>}</p>
            {voice.voicemail.playbackUrl && <audio className="w-full" controls preload="none" src={voice.voicemail.playbackUrl} aria-label="留守番電話を再生" />}
            <p className="text-pretty text-xs text-slate-500">文字起こし: {voice.voicemail.transcribed ? '済み' : '未記録'} · 通知: {voice.voicemail.notificationAccepted ? '送信受付済み' : '送信受付の記録なし'}</p>
        </>}
    </div>;
}
