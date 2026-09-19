import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiWrite } from './api';
import type { KnowledgeReview } from './types';
import { Button, Empty, ErrorBanner, Field, inputClass, Section, StateBadge, formatDate } from './ui';

interface ReviewWithTag {
    review: KnowledgeReview;
    etag: string | null;
}

export default function ReviewsPage() {
    const [items, setItems] = useState<KnowledgeReview[]>([]);
    const [etags, setEtags] = useState<Record<string, string>>({});
    const [error, setError] = useState<unknown>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const [notice, setNotice] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { body } = await apiGet<{ items: KnowledgeReview[] }>('/api/admin/v2/knowledge-reviews?state=open');
            setItems(body.items);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // The list endpoint does not return ETags — fetch each record's tag
    // lazily on first resolve attempt via a GET (keeps list cheap).
    const ensureEtag = async (reviewId: string): Promise<string> => {
        const cached = etags[reviewId];
        if (cached) return cached;
        const { body, etag } = await apiGet<{ review: KnowledgeReview }>(`/api/admin/v2/knowledge-reviews/${encodeURIComponent(reviewId)}`);
        const tag = etag ?? `"rev-v${body.review.recordVersion}"`;
        setEtags((prev) => ({ ...prev, [reviewId]: tag }));
        return tag;
    };

    const resolve = async (reviewId: string) => {
        const resolvedValue = drafts[reviewId]?.trim();
        if (!resolvedValue) {
            setActionError(new Error('解決値を入力してください'));
            return;
        }
        setBusyId(reviewId);
        setActionError(null);
        try {
            const tag = await ensureEtag(reviewId);
            await apiWrite('PATCH', `/api/admin/v2/knowledge-reviews/${encodeURIComponent(reviewId)}`, { resolvedValue }, { 'if-match': tag });
            setNotice('レビューを解決しました');
            await load();
        } catch (err) {
            setActionError(err);
        } finally {
            setBusyId(null);
        }
    };

    return (
        <Section title="レビュー依頼" actions={<Button onClick={() => void load()} disabled={loading}>再読込</Button>}>
            <p className="text-xs text-slate-500">ナレッジの「確認したい点」への回答を記録します。解決後、該当ナレッジの承認・公開へ進みます。</p>
            <ErrorBanner error={error} />
            <ErrorBanner error={actionError} />
            {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" role="status">{notice}</p>}
            {!loading && items.length === 0 && <Empty>未解決のレビューはありません</Empty>}
            <ul className="grid gap-2">
                {items.map((r) => (
                    <li key={r.reviewId} className="grid gap-2 rounded border border-slate-200 p-3">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{r.knowledgeId}</span>
                            <div className="flex items-center gap-2">
                                <StateBadge state={r.state} />
                                <span className="text-xs text-slate-500">{formatDate(r.createdAt)}</span>
                            </div>
                        </div>
                        <p className="text-sm">{r.question}</p>
                        <div className="flex items-end gap-2">
                            <Field label="解決値">
                                <input
                                    className={inputClass}
                                    value={drafts[r.reviewId] ?? ''}
                                    onChange={(e) => setDrafts((prev) => ({ ...prev, [r.reviewId]: e.target.value }))}
                                    placeholder="確認した正しい値"
                                />
                            </Field>
                            <Button variant="primary" disabled={busyId === r.reviewId} onClick={() => void resolve(r.reviewId)}>
                                {busyId === r.reviewId ? '記録中' : '解決'}
                            </Button>
                        </div>
                    </li>
                ))}
            </ul>
        </Section>
    );
}
