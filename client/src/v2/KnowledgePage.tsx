import { FormEvent, useCallback, useEffect, useState } from 'react';
import { apiGet, apiWrite, ApiError } from './api';
import type { KnowledgeRecord, KnowledgeRevision, ListResult, Release } from './types';
import { Button, Empty, ErrorBanner, Field, inputClass, Section, StateBadge, formatDate } from './ui';

interface Detail {
    knowledge: KnowledgeRecord;
    draftRevision: KnowledgeRevision | null;
    publishedRevision: KnowledgeRevision | null;
}

const CATEGORIES = ['company', 'service', 'price', 'product', 'contact', 'hours', 'security', 'privacy', 'contract', 'portfolio', 'research', 'routing'];

export default function KnowledgePage() {
    const [items, setItems] = useState<KnowledgeRecord[]>([]);
    const [listError, setListError] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);
    const [stateFilter, setStateFilter] = useState('');
    const [selected, setSelected] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setListError(null);
        try {
            const params = new URLSearchParams();
            if (stateFilter) params.set('state', stateFilter);
            params.set('limit', '200');
            const { body } = await apiGet<ListResult<KnowledgeRecord>>(`/api/admin/v2/knowledge?${params}`);
            setItems(body.items);
        } catch (error) {
            setListError(error);
        } finally {
            setLoading(false);
        }
    }, [stateFilter]);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Section
                title="ナレッジ一覧"
                actions={
                    <div className="flex items-center gap-2">
                        <select
                            value={stateFilter}
                            onChange={(e) => setStateFilter(e.target.value)}
                            className={inputClass}
                            aria-label="状態フィルタ"
                        >
                            <option value="">すべて</option>
                            <option value="draft">下書き</option>
                            <option value="in_review">レビュー中</option>
                            <option value="approved">承認済み</option>
                            <option value="published">公開中</option>
                            <option value="withdrawn">撤回済み</option>
                        </select>
                        <Button onClick={() => void load()} disabled={loading}>
                            {loading ? '読込中' : '再読込'}
                        </Button>
                    </div>
                }
            >
                <ErrorBanner error={listError} />
                {!loading && items.length === 0 && <Empty>該当するナレッジがありません</Empty>}
                <ul className="grid gap-2">
                    {items.map((item) => (
                        <li key={item.knowledgeId}>
                            <button
                                type="button"
                                onClick={() => setSelected(item.knowledgeId)}
                                className={`w-full rounded border p-3 text-left text-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 ${
                                    selected === item.knowledgeId ? 'border-slate-900 bg-slate-50' : 'border-slate-200'
                                }`}
                                aria-pressed={selected === item.knowledgeId}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-slate-900">{item.title}</span>
                                    <StateBadge state={item.state} />
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                                    <span>{item.key}</span>
                                    <span>·</span>
                                    <span>{item.category}</span>
                                    {item.audience === 'admin_only' && (
                                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-800">社内限定</span>
                                    )}
                                </div>
                            </button>
                        </li>
                    ))}
                </ul>
            </Section>
            {selected ? (
                <KnowledgeDetail knowledgeId={selected} onChanged={load} />
            ) : (
                <Section title="詳細">
                    <Empty>左の一覧から項目を選択してください</Empty>
                </Section>
            )}
        </div>
    );
}

function KnowledgeDetail({ knowledgeId, onChanged }: { knowledgeId: string; onChanged: () => void }) {
    const [detail, setDetail] = useState<Detail | null>(null);
    const [etag, setEtag] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
    const [editing, setEditing] = useState(false);
    const [editAnswer, setEditAnswer] = useState('');
    const [editTitle, setEditTitle] = useState('');

    const load = useCallback(async () => {
        setError(null);
        setPreview(null);
        try {
            const { body, etag: tag } = await apiGet<Detail>(`/api/admin/v2/knowledge/${encodeURIComponent(knowledgeId)}`);
            setDetail(body);
            setEtag(tag);
            setEditTitle(body.draftRevision?.answerJa ? body.knowledge.title : body.knowledge.title);
            setEditAnswer(body.draftRevision?.answerJa ?? '');
        } catch (err) {
            setError(err);
            setDetail(null);
        }
    }, [knowledgeId]);

    useEffect(() => {
        void load();
    }, [load]);

    const run = async (label: string, fn: () => Promise<unknown>, done: string, refresh = true) => {
        setBusy(label);
        setActionError(null);
        setNotice('');
        try {
            await fn();
            setNotice(done);
            if (refresh) {
                await load();
                onChanged();
            }
        } catch (err) {
            setActionError(err);
        } finally {
            setBusy(null);
        }
    };

    if (error) return <Section title="詳細"><ErrorBanner error={error} /></Section>;
    if (!detail) return <Section title="詳細"><p className="text-sm text-slate-500">読み込み中…</p></Section>;

    const { knowledge, draftRevision, publishedRevision } = detail;
    const canEdit = ['draft', 'in_review', 'published'].includes(knowledge.state);
    const canApprove = knowledge.state === 'in_review' || knowledge.state === 'draft';
    const canPublish = knowledge.state === 'approved';
    const canWithdraw = knowledge.state === 'published' || knowledge.state === 'approved';

    const saveEdit = async (event: FormEvent) => {
        event.preventDefault();
        if (!draftRevision || !etag) return;
        await run('save', async () => {
            await apiWrite('PATCH', `/api/admin/v2/knowledge/${knowledgeId}`, {
                key: knowledge.key,
                title: editTitle,
                category: knowledge.category,
                locale: knowledge.locale,
                keywords: knowledge.keywords,
                audience: knowledge.audience,
                handling: knowledge.handling,
                riskLevel: knowledge.riskLevel,
                value: draftRevision.value,
                answerJa: editAnswer,
                answerType: draftRevision.answerType,
                evidenceState: draftRevision.evidenceState,
                sourceRefs: draftRevision.sourceRefs,
                asOf: draftRevision.asOf,
                validity: draftRevision.validity,
                operatorNote: draftRevision.operatorNote ?? null
            }, { 'if-match': etag });
        }, '保存しました（新しいdraftリビジョンを作成 — 承認は引き継がれません）');
        setEditing(false);
    };

    return (
        <Section
            title={knowledge.title}
            actions={<StateBadge state={knowledge.state} />}
        >
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-slate-500">キー</dt><dd>{knowledge.key}</dd>
                <dt className="text-slate-500">カテゴリ</dt><dd>{knowledge.category}</dd>
                <dt className="text-slate-500">対象</dt><dd>{knowledge.audience === 'public' ? '公開可' : '社内限定'}</dd>
                <dt className="text-slate-500">更新</dt><dd>{formatDate(knowledge.updatedAt)}（{knowledge.updatedBy}）</dd>
                <dt className="text-slate-500">draft rev</dt><dd>{knowledge.draftRevision ?? '-'}</dd>
                <dt className="text-slate-500">公開 rev</dt><dd>{knowledge.publishedRevision ?? '未公開'}</dd>
            </dl>

            {draftRevision && (
                <div className="rounded border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-medium text-slate-500">draft回答（rev {draftRevision.revision}）</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{draftRevision.answerJa}</p>
                    <p className="mt-2 text-xs text-slate-500">
                        根拠: {draftRevision.evidenceState} · asOf {draftRevision.asOf ?? '-'}
                        {draftRevision.validity.expiresAt && ` · 期限 ${draftRevision.validity.expiresAt}`}
                    </p>
                    {draftRevision.operatorNote && (
                        <p className="mt-1 text-xs text-amber-700">社内メモ（公開されません）: {draftRevision.operatorNote}</p>
                    )}
                </div>
            )}

            {publishedRevision && (
                <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
                    <p className="text-xs font-medium text-emerald-700">公開中の回答（rev {publishedRevision.revision}）</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{publishedRevision.answerJa}</p>
                    <p className="mt-2 text-xs text-emerald-700">
                        承認: {publishedRevision.approval.approvedBy} @ {formatDate(publishedRevision.approval.approvedAt)}
                    </p>
                </div>
            )}

            <ErrorBanner error={actionError} />
            {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" role="status">{notice}</p>}

            <div className="flex flex-wrap gap-2">
                {canEdit && !editing && (
                    <Button onClick={() => setEditing(true)}>編集</Button>
                )}
                {canApprove && draftRevision && (
                    <>
                        <Button
                            variant="primary"
                            disabled={busy !== null}
                            onClick={() => void run('submit', () =>
                                apiWrite('POST', `/api/admin/v2/knowledge/${knowledgeId}/submit-review`, { revision: knowledge.draftRevision }),
                                'レビューに出しました')}
                        >
                            {busy === 'submit' ? '送信中' : 'レビュー依頼'}
                        </Button>
                        <Button
                            variant="primary"
                            disabled={busy !== null}
                            onClick={() => void run('approve', () =>
                                apiWrite('POST', `/api/admin/v2/knowledge/${knowledgeId}/approve`, {
                                    revision: draftRevision.revision,
                                    contentHash: draftRevision.contentHash,
                                    reason: 'UIから承認'
                                }),
                                '承認しました（このリビジョンのハッシュに紐付きます）')}
                        >
                            {busy === 'approve' ? '承認中' : 'この内容を承認'}
                        </Button>
                    </>
                )}
                {canPublish && (
                    <Button
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() => void run('publish', () =>
                            apiWrite('POST', '/api/admin/v2/knowledge-releases', { knowledgeIds: [knowledgeId] }),
                            '公開releaseを作成しました（電話応答で使用可能になりました）')}
                    >
                        {busy === 'publish' ? '公開中' : '公開releaseを作成'}
                    </Button>
                )}
                {canWithdraw && (
                    <Button
                        variant="danger"
                        disabled={busy !== null}
                        onClick={() => {
                            const reason = window.prompt('撤回理由（必須）');
                            if (!reason) return;
                            void run('withdraw', () =>
                                apiWrite('POST', `/api/admin/v2/knowledge/${knowledgeId}/withdraw`, { reason }),
                                '撤回しました（releaseは不変のまま、runtimeで使用停止）');
                        }}
                    >
                        撤回
                    </Button>
                )}
                <Button
                    disabled={busy !== null}
                    onClick={() => void run('preview', async () => {
                        const { body } = await apiWrite<Record<string, unknown>>('POST', '/api/admin/v2/knowledge/preview', { knowledgeId });
                        setPreview(body);
                    }, '', false)}
                >
                    公開プレビュー
                </Button>
            </div>

            {editing && draftRevision && (
                <form onSubmit={saveEdit} className="grid gap-3 rounded border border-slate-300 p-3">
                    <Field label="タイトル">
                        <input className={inputClass} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required />
                    </Field>
                    <Field label="回答文（公開される内容）">
                        <textarea className={inputClass} rows={4} value={editAnswer} onChange={(e) => setEditAnswer(e.target.value)} required />
                    </Field>
                    <div className="flex gap-2">
                        <Button type="submit" variant="primary" disabled={busy !== null}>保存（新rev作成）</Button>
                        <Button onClick={() => setEditing(false)}>キャンセル</Button>
                    </div>
                </form>
            )}

            {preview && (
                <div className="rounded border border-sky-200 bg-sky-50 p-3 text-sm">
                    <p className="font-medium text-sky-800">公開プレビュー（電話で読まれる内容）</p>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(preview.wouldPublish, null, 2)}</pre>
                    <p className="mt-2 text-xs text-sky-700">{String(preview.note)}</p>
                </div>
            )}
        </Section>
    );
}
