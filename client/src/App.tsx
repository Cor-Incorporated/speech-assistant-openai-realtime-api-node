import { FormEvent, useEffect, useMemo, useState } from 'react';
import { cn } from './lib/cn';

type Summary = {
    total: number;
    callbackRequired: number;
    inProgress: number;
    completed: number;
    needsReview?: number;
};

type CallLog = {
    callSid: string;
    isSmokeTest?: boolean;
    startedAt?: string;
    startedAtJst?: string;
    endedAt?: string;
    endedAtJst?: string;
    durationSeconds?: number;
    status?: string;
    disconnectReason?: string;
    disconnectReasonLabel?: string;
    disconnectReasonCategory?: string;
    openAiError?: string;
    from?: string;
    to?: string;
    customerPhoneNumber?: string;
    fromDisplay?: string;
    toDisplay?: string;
    customerPhoneDisplay?: string;
    summary?: string;
    intent?: string;
    callbackRequired?: boolean;
    customerName?: string;
    preferredDatetime?: string;
    transcript?: string;
    turns?: Array<{ role: string; text: string; at?: string }>;
    ops?: {
        status?: string;
        callbackStatus?: string;
        assignee?: string;
        memo?: string;
        needsReview?: boolean;
    };
};

type RuntimeConfig = {
    models?: {
        realtime?: string;
        realtimeOptions?: Array<{
            value: string;
            label: string;
            description?: string;
            supportsReasoning?: boolean;
        }>;
        realtimeReasoningEffort?: string;
        realtimeReasoningEffortOptions?: string[];
        transcription?: string;
        extraction?: string;
    };
    runtimeSettings?: {
        source?: string;
        updatedAt?: string;
        updatedBy?: string;
        writable?: boolean;
    };
    voice?: string;
    vad?: {
        type?: string;
        threshold?: number;
        prefixPaddingMs?: number;
        silenceDurationMs?: number;
        eagerness?: string;
    };
    logging?: {
        transcripts?: boolean;
        realtimeEvents?: boolean;
        openAiResponses?: boolean;
    };
    storage?: {
        firestoreEnabled?: boolean;
        sheetsEnabled?: boolean;
    };
    prompt?: {
        source?: string;
        hash?: string;
        length?: number;
        available?: boolean;
    };
    firstMessage?: string;
};

type Policy = {
    policy?: Record<string, boolean | string>;
    logging?: RuntimeConfig['logging'];
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type Filter = 'all' | 'unresolved' | 'callback' | 'review' | 'done';

const fetchJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const url = new URL(path, window.location.origin);
    const response = await fetch(url.toString(), {
        headers: {
            'content-type': 'application/json',
            ...(init?.headers || {})
        },
        ...init
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
};

const formatDate = (value?: string) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('ja-JP', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
};

const formatDuration = (seconds = 0) => {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
};

const badgeClass = (tone: 'default' | 'warning' | 'success' | 'muted') => cn(
    'inline-flex items-center rounded px-2 py-1 text-xs font-medium',
    tone === 'default' && 'bg-sky-100 text-sky-800',
    tone === 'warning' && 'bg-amber-100 text-amber-900',
    tone === 'success' && 'bg-emerald-100 text-emerald-800',
    tone === 'muted' && 'bg-slate-100 text-slate-700'
);

const filters: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: 'すべて' },
    { value: 'unresolved', label: '未完了' },
    { value: 'callback', label: '折り返し' },
    { value: 'review', label: '要確認' },
    { value: 'done', label: '完了' }
];

const callbackStatuses = [
    { value: 'pending', label: '未対応' },
    { value: 'scheduled', label: '予定済み' },
    { value: 'completed', label: '完了' },
    { value: 'not_required', label: '不要' }
];

const opsStatuses = [
    { value: 'new', label: '新規' },
    { value: 'needs_callback', label: '折り返し必要' },
    { value: 'in_progress', label: '対応中' },
    { value: 'done', label: '完了' }
];

const optionLabel = (
    options: Array<{ value: string; label: string }>,
    value?: string
) => options.find((option) => option.value === value)?.label || value || '-';

const isPendingCallback = (log: CallLog) => Boolean(log.callbackRequired)
    && !['completed', 'not_required'].includes(log.ops?.callbackStatus || '');

const isUnresolved = (log: CallLog) => log.ops?.status !== 'done';

const fieldClass = 'rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';
const settingRowClass = 'grid gap-1 sm:flex sm:items-start sm:justify-between sm:gap-4';
const settingValueClass = 'break-words font-medium sm:text-right';

const EmptyState = ({
    title,
    body,
    actionLabel,
    onAction
}: {
    title: string;
    body: string;
    actionLabel: string;
    onAction: () => void;
}) => (
    <div className="flex min-h-56 min-w-0 flex-col items-center justify-center rounded border border-dashed border-slate-300 bg-white p-8 text-center">
        <h2 className="text-balance text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-2 max-w-md break-all text-pretty text-sm text-slate-600">
            {body}
        </p>
        <button
            type="button"
            onClick={onAction}
            className="mt-5 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
        >
            {actionLabel}
        </button>
    </div>
);

const SkeletonRows = () => (
    <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-20 rounded border border-slate-200 bg-white p-4">
                <div className="h-4 w-2/3 rounded bg-slate-200" />
                <div className="mt-3 h-3 w-1/2 rounded bg-slate-100" />
            </div>
        ))}
    </div>
);

const DetailSkeleton = () => (
    <div className="mt-4 grid gap-3" aria-label="詳細を読み込み中">
        <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="rounded border border-slate-200 p-3">
                    <div className="h-3 w-20 rounded bg-slate-100" />
                    <div className="mt-2 h-4 w-28 rounded bg-slate-200" />
                </div>
            ))}
        </div>
        <div className="h-32 rounded bg-slate-100" />
        <div className="h-36 rounded border border-slate-200 bg-white" />
    </div>
);

function App() {
    const [logs, setLogs] = useState<CallLog[]>([]);
    const [summary, setSummary] = useState<Summary | null>(null);
    const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
    const [policy, setPolicy] = useState<Policy | null>(null);
    const [selectedCallSid, setSelectedCallSid] = useState('');
    const [selectedLog, setSelectedLog] = useState<CallLog | null>(null);
    const [status, setStatus] = useState<LoadState>('idle');
    const [detailStatus, setDetailStatus] = useState<LoadState>('idle');
    const [saveStatus, setSaveStatus] = useState<LoadState>('idle');
    const [settingsSaveStatus, setSettingsSaveStatus] = useState<LoadState>('idle');
    const [cleanupStatus, setCleanupStatus] = useState<LoadState>('idle');
    const [error, setError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [settingsError, setSettingsError] = useState('');
    const [cleanupMessage, setCleanupMessage] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [runtimeDraft, setRuntimeDraft] = useState({
        realtimeModel: 'gpt-realtime-2',
        realtimeReasoningEffort: 'low'
    });
    const [opsDraft, setOpsDraft] = useState({
        status: 'new',
        callbackStatus: 'pending',
        assignee: '',
        memo: '',
        needsReview: false
    });
    const isDashboardLoading = status === 'loading';
    const modelOptions = runtimeConfig?.models?.realtimeOptions?.length
        ? runtimeConfig.models.realtimeOptions
        : [
            { value: 'gpt-realtime-2', label: 'GPT Realtime 2', description: '受付MVP推奨' },
            { value: 'gpt-realtime-1.5', label: 'GPT Realtime 1.5', description: '比較検証用' }
        ];
    const reasoningOptions = runtimeConfig?.models?.realtimeReasoningEffortOptions?.length
        ? runtimeConfig.models.realtimeReasoningEffortOptions
        : ['low', 'medium', 'high'];

    const loadDashboard = async () => {
        setStatus('loading');
        setError('');
        try {
            const [summaryBody, logsBody, configBody, policyBody] = await Promise.all([
                fetchJson<Summary>('/api/admin/summary'),
                fetchJson<{ items: CallLog[] }>('/api/admin/call-logs?limit=50'),
                fetchJson<RuntimeConfig>('/api/admin/runtime-config'),
                fetchJson<Policy>('/api/admin/privacy/logging-policy')
            ]);
            setSummary(summaryBody);
            setLogs(logsBody.items || []);
            setRuntimeConfig(configBody);
            setPolicy(policyBody);
            setStatus('ready');
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : '読み込みに失敗しました');
            setStatus('error');
        }
    };

    useEffect(() => {
        let ignore = false;
        const load = async () => {
            setStatus('loading');
            setError('');
            try {
                const [summaryBody, logsBody, configBody, policyBody] = await Promise.all([
                    fetchJson<Summary>('/api/admin/summary'),
                    fetchJson<{ items: CallLog[] }>('/api/admin/call-logs?limit=50'),
                    fetchJson<RuntimeConfig>('/api/admin/runtime-config'),
                    fetchJson<Policy>('/api/admin/privacy/logging-policy')
                ]);
                if (!ignore) {
                    setSummary(summaryBody);
                    setLogs(logsBody.items || []);
                    setRuntimeConfig(configBody);
                    setPolicy(policyBody);
                    setStatus('ready');
                }
            } catch (loadError) {
                if (!ignore) {
                    setError(loadError instanceof Error ? loadError.message : '読み込みに失敗しました');
                    setStatus('error');
                }
            }
        };
        load();
        return () => {
            ignore = true;
        };
    }, []);

    useEffect(() => {
        if (!runtimeConfig?.models) return;
        setRuntimeDraft({
            realtimeModel: runtimeConfig.models.realtime || 'gpt-realtime-2',
            realtimeReasoningEffort: runtimeConfig.models.realtimeReasoningEffort || 'low'
        });
        setSettingsSaveStatus('idle');
        setSettingsError('');
    }, [runtimeConfig]);

    useEffect(() => {
        if (!selectedCallSid) {
            setSelectedLog(null);
            setDetailStatus('idle');
            setSaveStatus('idle');
            setSaveError('');
            return;
        }

        let ignore = false;
        const loadDetail = async () => {
            setDetailStatus('loading');
            setSelectedLog(null);
            setSaveStatus('idle');
            setSaveError('');
            try {
                const detail = await fetchJson<CallLog>(`/api/admin/call-logs/${encodeURIComponent(selectedCallSid)}`);
                if (!ignore) {
                    setSelectedLog(detail);
                    setOpsDraft({
                        status: detail.ops?.status || 'new',
                        callbackStatus: detail.ops?.callbackStatus || 'pending',
                        assignee: detail.ops?.assignee || '',
                        memo: detail.ops?.memo || '',
                        needsReview: Boolean(detail.ops?.needsReview)
                    });
                    setDetailStatus('ready');
                }
            } catch (detailError) {
                if (!ignore) {
                    setDetailStatus('error');
                    setSaveError(detailError instanceof Error ? detailError.message : '詳細の読み込みに失敗しました');
                }
            }
        };
        loadDetail();
        return () => {
            ignore = true;
        };
    }, [selectedCallSid]);

    const updateOpsDraft = (patch: Partial<typeof opsDraft>) => {
        setOpsDraft((current) => ({ ...current, ...patch }));
        setSaveStatus('idle');
        setSaveError('');
    };

    const filteredLogs = useMemo(() => logs.filter((log) => {
        if (filter === 'callback') return isPendingCallback(log);
        if (filter === 'unresolved') return isUnresolved(log);
        if (filter === 'review') return Boolean(log.ops?.needsReview);
        if (filter === 'done') return log.ops?.status === 'done';
        return true;
    }), [logs, filter]);

    const saveOps = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!selectedLog) return;

        setSaveStatus('loading');
        setSaveError('');
        try {
            const updated = await fetchJson<CallLog>(`/api/admin/call-logs/${encodeURIComponent(selectedLog.callSid)}/ops`, {
                method: 'PATCH',
                body: JSON.stringify({ ops: opsDraft })
            });
            setSelectedLog(updated);
            setLogs((current) => current.map((log) => (
                log.callSid === updated.callSid ? { ...log, ops: updated.ops } : log
            )));
            setOpsDraft({
                status: updated.ops?.status || 'new',
                callbackStatus: updated.ops?.callbackStatus || 'pending',
                assignee: updated.ops?.assignee || '',
                memo: updated.ops?.memo || '',
                needsReview: Boolean(updated.ops?.needsReview)
            });
            setSaveStatus('ready');
            loadDashboard();
        } catch (saveErrorValue) {
            setSaveError(saveErrorValue instanceof Error ? saveErrorValue.message : '保存に失敗しました');
            setSaveStatus('error');
        }
    };

    const saveRuntimeSettings = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSettingsSaveStatus('loading');
        setSettingsError('');
        try {
            const updated = await fetchJson<RuntimeConfig>('/api/admin/runtime-config', {
                method: 'PATCH',
                body: JSON.stringify(runtimeDraft)
            });
            setRuntimeConfig(updated);
            setSettingsSaveStatus('ready');
        } catch (settingsErrorValue) {
            setSettingsError(settingsErrorValue instanceof Error ? settingsErrorValue.message : 'モデル設定の保存に失敗しました');
            setSettingsSaveStatus('error');
        }
    };

    const cleanupTestLogs = async () => {
        if (!window.confirm('CA_SMOKEで始まる検証ログと、会話内容が空のログを削除します。よろしいですか。')) {
            return;
        }

        setCleanupStatus('loading');
        setCleanupMessage('');
        try {
            const result = await fetchJson<{ deleted: number }>('/api/admin/call-logs/test-or-empty?limit=500', {
                method: 'DELETE'
            });
            setCleanupMessage(`${result.deleted}件の検証/空ログを削除しました`);
            setCleanupStatus('ready');
            await loadDashboard();
        } catch (cleanupErrorValue) {
            setCleanupMessage(cleanupErrorValue instanceof Error ? cleanupErrorValue.message : '検証ログ削除に失敗しました');
            setCleanupStatus('error');
        }
    };

    return (
        <main className="min-h-dvh bg-slate-50 px-4 py-6 text-slate-900 sm:px-6 lg:px-8" aria-busy={isDashboardLoading}>
            <div className="mx-auto grid w-full min-w-0 max-w-7xl gap-6">
                <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-sm font-medium text-slate-500">Cor Voice Admin</p>
                        <h1 className="text-balance text-2xl font-semibold text-slate-950">通話ログ管理</h1>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={cleanupTestLogs}
                            className="w-fit rounded border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-200 disabled:opacity-60"
                            disabled={cleanupStatus === 'loading'}
                        >
                            {cleanupStatus === 'loading' ? '削除中' : '検証ログ削除'}
                        </button>
                        <button
                            type="button"
                            onClick={loadDashboard}
                            className="w-fit rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60"
                            disabled={isDashboardLoading}
                        >
                            {isDashboardLoading ? '読み込み中' : '再読み込み'}
                        </button>
                    </div>
                </header>

                {error && (
                    <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
                        {error}
                    </div>
                )}
                {cleanupMessage && (
                    <div
                        className={cn(
                            'rounded border p-4 text-sm',
                            cleanupStatus === 'error'
                                ? 'border-red-200 bg-red-50 text-red-800'
                                : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        )}
                        role={cleanupStatus === 'error' ? 'alert' : 'status'}
                    >
                        {cleanupMessage}
                    </div>
                )}

                <section className="grid gap-3 md:grid-cols-4" aria-label="通話サマリー">
                    {[
                        ['総通話数', summary?.total ?? 0],
                        ['未対応の折り返し', summary?.callbackRequired ?? 0],
                        ['対応中', summary?.inProgress ?? 0],
                        ['対応完了', summary?.completed ?? 0]
                    ].map(([label, value]) => (
                        <div key={label} className="rounded border border-slate-200 bg-white p-4">
                            <div className="text-sm text-slate-500">{label}</div>
                            <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
                        </div>
                    ))}
                </section>

                <div className="grid min-w-0 gap-6 xl:grid-cols-5">
                    <section className="grid min-w-0 gap-4 xl:col-span-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {filters.map(({ value, label }) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setFilter(value)}
                                    aria-pressed={filter === value}
                                    className={cn(
                                        'rounded border px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-slate-400',
                                        filter === value
                                            ? 'border-slate-900 bg-slate-900 text-white'
                                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                                    )}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {status === 'loading' && <SkeletonRows />}
                        {status !== 'loading' && filteredLogs.length === 0 && (
                            <EmptyState
                                title={filter === 'all' ? '表示できる通話ログがありません' : '条件に合う通話ログがありません'}
                                body={filter === 'all'
                                    ? 'Firestore保存が有効になり、通話完了後にログが作成されるとここへ表示されます。'
                                    : '選択中の絞り込みを外すと、ほかの通話ログを確認できます。'}
                                actionLabel={filter === 'all' ? '再読み込み' : '絞り込みを解除'}
                                onAction={filter === 'all' ? loadDashboard : () => setFilter('all')}
                            />
                        )}
                        {status !== 'loading' && filteredLogs.length > 0 && (
                            <div className="overflow-hidden rounded border border-slate-200 bg-white">
                                <div className="divide-y divide-slate-100">
                                    {filteredLogs.map((log) => {
                                        const fromPhone = log.from || log.fromDisplay || '-';
                                        const toPhone = log.to || log.toDisplay || '-';

                                        return (
                                            <button
                                                key={log.callSid}
                                                type="button"
                                                onClick={() => setSelectedCallSid(log.callSid)}
                                                aria-pressed={selectedCallSid === log.callSid}
                                                aria-label={`${log.intent || '用件未分類'} ${formatDate(log.startedAt)} の詳細を開く`}
                                                className={cn(
                                                    'grid w-full gap-3 p-4 text-left hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-slate-400',
                                                    selectedCallSid === log.callSid && 'bg-slate-100'
                                                )}
                                            >
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="font-medium text-slate-950">{log.intent || '用件未分類'}</span>
                                                    {log.isSmokeTest && <span className={badgeClass('muted')}>検証ログ</span>}
                                                    {log.callbackRequired && <span className={badgeClass('warning')}>折り返し</span>}
                                                    {log.ops?.needsReview && <span className={badgeClass('default')}>要確認</span>}
                                                    <span className={badgeClass(log.ops?.status === 'done' ? 'success' : 'muted')}>
                                                        {optionLabel(opsStatuses, log.ops?.status || 'new')}
                                                    </span>
                                                </div>
                                                <p className="line-clamp-2 text-pretty text-sm text-slate-600">{log.summary || '要約はまだありません'}</p>
                                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                                                    <span className="tabular-nums">{formatDate(log.startedAt)}</span>
                                                    <span className="tabular-nums">{formatDuration(log.durationSeconds || 0)}</span>
                                                    <span className="tabular-nums">発信 {fromPhone}</span>
                                                    <span className="tabular-nums">着信 {toPhone}</span>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </section>

                    <aside className="grid min-w-0 content-start gap-4 xl:col-span-2">
                        <section className="min-w-0 rounded border border-slate-200 bg-white p-5">
                            <h2 className="text-balance text-lg font-semibold">詳細</h2>
                            {!selectedCallSid && (
                                <p className="mt-3 text-pretty text-sm text-slate-600">一覧から通話を選択してください。</p>
                            )}
                            {detailStatus === 'loading' && <DetailSkeleton />}
                            {detailStatus === 'error' && (
                                <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
                                    {saveError || '詳細の読み込みに失敗しました'}
                                </div>
                            )}
                            {selectedLog && detailStatus === 'ready' && (
                                <div className="mt-4 grid gap-4">
                                    <dl className="grid grid-cols-2 gap-3 text-sm">
                                        <div className="min-w-0">
                                            <dt className="text-slate-500">発信者</dt>
                                            <dd className="break-words font-medium">{selectedLog.from || selectedLog.fromDisplay || '-'}</dd>
                                        </div>
                                        <div className="min-w-0">
                                            <dt className="text-slate-500">着信番号</dt>
                                            <dd className="break-words font-medium">{selectedLog.to || selectedLog.toDisplay || '-'}</dd>
                                        </div>
                                        <div className="min-w-0">
                                            <dt className="text-slate-500">顧客電話</dt>
                                            <dd className="break-words font-medium">{selectedLog.customerPhoneNumber || selectedLog.customerPhoneDisplay || '-'}</dd>
                                        </div>
                                        <div className="min-w-0">
                                            <dt className="text-slate-500">希望日時</dt>
                                            <dd className="break-words font-medium">{selectedLog.preferredDatetime || '-'}</dd>
                                        </div>
                                        <div className="min-w-0">
                                            <dt className="text-slate-500">切断理由</dt>
                                            <dd className="break-words font-medium">{selectedLog.disconnectReasonLabel || selectedLog.openAiError || '-'}</dd>
                                            {selectedLog.disconnectReason && (
                                                <dd className="mt-1 break-all text-xs text-slate-500">raw: {selectedLog.disconnectReason}</dd>
                                            )}
                                        </div>
                                    </dl>

                                    <div>
                                        <h3 className="text-sm font-semibold text-slate-700">文字起こし</h3>
                                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs leading-6 text-slate-100">{selectedLog.transcript || '文字起こしはありません'}</pre>
                                    </div>

                                    <form className="grid gap-3 border-t border-slate-200 pt-4" onSubmit={saveOps}>
                                        <label className="grid gap-1 text-sm">
                                            <span className="font-medium text-slate-700">対応ステータス</span>
                                            <select
                                                value={opsDraft.status}
                                                onChange={(event) => updateOpsDraft({ status: event.target.value })}
                                                className={fieldClass}
                                            >
                                                {opsStatuses.map((option) => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="grid gap-1 text-sm">
                                            <span className="font-medium text-slate-700">折り返し状況</span>
                                            <select
                                                value={opsDraft.callbackStatus}
                                                onChange={(event) => updateOpsDraft({ callbackStatus: event.target.value })}
                                                className={fieldClass}
                                            >
                                                {callbackStatuses.map((option) => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="grid gap-1 text-sm">
                                            <span className="font-medium text-slate-700">担当者</span>
                                            <input
                                                value={opsDraft.assignee}
                                                onChange={(event) => updateOpsDraft({ assignee: event.target.value })}
                                                className={fieldClass}
                                                placeholder="例: 受付チーム"
                                            />
                                        </label>
                                        <label className="grid gap-1 text-sm">
                                            <span className="font-medium text-slate-700">メモ</span>
                                            <textarea
                                                value={opsDraft.memo}
                                                onChange={(event) => updateOpsDraft({ memo: event.target.value })}
                                                rows={4}
                                                className={cn(fieldClass, 'resize-y')}
                                                placeholder="対応履歴や次の確認事項"
                                            />
                                        </label>
                                        <label className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={opsDraft.needsReview}
                                                onChange={(event) => updateOpsDraft({ needsReview: event.target.checked })}
                                                className="size-4 rounded border-slate-300 focus:ring-2 focus:ring-slate-400"
                                            />
                                            要確認として残す
                                        </label>
                                        {saveError && <p className="text-sm text-red-700" role="alert">{saveError}</p>}
                                        {saveStatus === 'ready' && <p className="text-sm text-emerald-700" role="status">保存しました</p>}
                                        <p className="text-xs text-slate-500">対応ステータス、折り返し状況、担当者、メモはFirestoreに保存され、再読み込み後も残ります。</p>
                                        <button
                                            type="submit"
                                            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60"
                                            disabled={saveStatus === 'loading'}
                                        >
                                            {saveStatus === 'loading' ? '保存中' : '対応内容を保存'}
                                        </button>
                                    </form>
                                </div>
                            )}
                        </section>

                        <section className="min-w-0 rounded border border-slate-200 bg-white p-5">
                            <h2 className="text-balance text-lg font-semibold">運用設定</h2>
                            <form className="mt-4 grid gap-3 border-b border-slate-200 pb-4 text-sm" onSubmit={saveRuntimeSettings}>
                                <label className="grid gap-1">
                                    <span className="font-medium text-slate-700">Realtimeモデル</span>
                                    <select
                                        value={runtimeDraft.realtimeModel}
                                        onChange={(event) => setRuntimeDraft((current) => ({
                                            ...current,
                                            realtimeModel: event.target.value
                                        }))}
                                        className={fieldClass}
                                    >
                                        {modelOptions.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="grid gap-1">
                                    <span className="font-medium text-slate-700">Realtime 2 推論設定</span>
                                    <select
                                        value={runtimeDraft.realtimeReasoningEffort}
                                        onChange={(event) => setRuntimeDraft((current) => ({
                                            ...current,
                                            realtimeReasoningEffort: event.target.value
                                        }))}
                                        className={fieldClass}
                                        disabled={runtimeDraft.realtimeModel !== 'gpt-realtime-2'}
                                    >
                                        {reasoningOptions.map((option) => (
                                            <option key={option} value={option}>{option}</option>
                                        ))}
                                    </select>
                                </label>
                                <div className="grid gap-1 text-xs text-slate-500">
                                    <span>保存後、次回以降の新しい通話から反映されます。進行中の通話は起動時のモデルを維持します。</span>
                                    {runtimeConfig?.runtimeSettings?.updatedAt && (
                                        <span>最終更新: {formatDate(runtimeConfig.runtimeSettings.updatedAt)} / {runtimeConfig.runtimeSettings.updatedBy || '-'}</span>
                                    )}
                                </div>
                                {settingsError && <p className="text-sm text-red-700" role="alert">{settingsError}</p>}
                                {settingsSaveStatus === 'ready' && <p className="text-sm text-emerald-700" role="status">モデル設定を保存しました</p>}
                                <button
                                    type="submit"
                                    className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60"
                                    disabled={settingsSaveStatus === 'loading'}
                                >
                                    {settingsSaveStatus === 'loading' ? '保存中' : 'モデル設定を保存'}
                                </button>
                            </form>
                            <div className="mt-4 grid gap-3 text-sm">
                                <div className={settingRowClass}><span className="text-slate-500">現在のRealtime</span><span className={settingValueClass}>{runtimeConfig?.models?.realtime || '-'}</span></div>
                                <div className={settingRowClass}><span className="text-slate-500">音声</span><span className={settingValueClass}>{runtimeConfig?.voice || '-'}</span></div>
                                <div className={settingRowClass}><span className="text-slate-500">VAD</span><span className={settingValueClass}>{runtimeConfig?.vad?.type || '-'}</span></div>
                                <div className={settingRowClass}><span className="text-slate-500">Firestore</span><span className={settingValueClass}>{runtimeConfig ? (runtimeConfig.storage?.firestoreEnabled ? 'enabled' : 'disabled') : '-'}</span></div>
                                <div className={settingRowClass}><span className="text-slate-500">Sheets</span><span className={settingValueClass}>{runtimeConfig ? (runtimeConfig.storage?.sheetsEnabled ? 'enabled' : 'disabled') : '-'}</span></div>
                                <div className={settingRowClass}><span className="text-slate-500">Prompt</span><span className={settingValueClass}>{runtimeConfig?.prompt?.source || '-'}</span></div>
                            </div>
                            <div className="mt-4 break-all rounded bg-slate-50 p-3 text-pretty text-xs text-slate-600">
                                一覧では個人情報と文字起こしを表示しません。詳細と対応更新はBasic認証済み管理者だけが利用できます。
                            </div>
                            {policy?.policy && (
                                <dl className="mt-3 grid gap-2 text-xs text-slate-600">
                                    {Object.entries(policy.policy).map(([key, value]) => (
                                        <div key={key} className={settingRowClass}>
                                            <dt className="min-w-0 break-words">{key}</dt>
                                            <dd className="font-medium sm:text-right">{String(value)}</dd>
                                        </div>
                                    ))}
                                </dl>
                            )}
                        </section>
                    </aside>
                </div>
            </div>
        </main>
    );
}

export default App;
