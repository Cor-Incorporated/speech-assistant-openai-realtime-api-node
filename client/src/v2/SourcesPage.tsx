import { FormEvent, useCallback, useEffect, useState } from 'react';
import { apiGet, apiWrite } from './api';
import type { SourceRecord, ListResult } from './types';
import { Button, Empty, ErrorBanner, Field, inputClass, Section, formatDate } from './ui';

const SOURCE_TYPES = [
    ['official_site', '公式サイト'],
    ['official_document', '公式文書'],
    ['staff_confirmed', '担当者確認済み'],
    ['customer_report', '顧客報告'],
    ['memory_candidate', '記憶由来（未確認）'],
    ['other', 'その他']
] as const;

export default function SourcesPage() {
    const [items, setItems] = useState<SourceRecord[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [actionError, setActionError] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [notice, setNotice] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { body } = await apiGet<{ items: SourceRecord[] }>('/api/admin/v2/knowledge-sources');
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

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setActionError(null);
        try {
            await apiWrite('POST', '/api/admin/v2/knowledge-sources', {
                sourceType: form.get('sourceType'),
                title: form.get('title'),
                url: form.get('url') || null,
                observation: form.get('observation') || null,
                publicationCaveat: form.get('publicationCaveat') || null
            });
            setNotice('ソースを登録しました');
            setShowForm(false);
            await load();
        } catch (err) {
            setActionError(err);
        }
    };

    const remove = async (sourceId: string) => {
        if (!window.confirm(`ソース ${sourceId} を削除しますか？参照中のナレッジがある場合は拒否されます。`)) return;
        setActionError(null);
        try {
            await apiWrite('DELETE', `/api/admin/v2/knowledge-sources/${encodeURIComponent(sourceId)}`);
            setNotice('削除しました');
            await load();
        } catch (err) {
            setActionError(err);
        }
    };

    return (
        <Section
            title="根拠ソース"
            actions={
                <div className="flex gap-2">
                    <Button onClick={() => setShowForm((v) => !v)}>{showForm ? '閉じる' : '新規登録'}</Button>
                    <Button onClick={() => void load()} disabled={loading}>再読込</Button>
                </div>
            }
        >
            <p className="text-xs text-slate-500">ナレッジの回答が「どこから来たか」の記録です。公開回答には必ずソースが紐付きます。</p>
            <ErrorBanner error={error} />
            <ErrorBanner error={actionError} />
            {notice && <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" role="status">{notice}</p>}

            {showForm && (
                <form onSubmit={submit} className="grid gap-3 rounded border border-slate-300 p-3">
                    <Field label="種別">
                        <select name="sourceType" className={inputClass} required>
                            {SOURCE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </Field>
                    <Field label="タイトル">
                        <input name="title" className={inputClass} required />
                    </Field>
                    <Field label="URL（任意）">
                        <input name="url" type="url" className={inputClass} />
                    </Field>
                    <Field label="観測メモ">
                        <textarea name="observation" className={inputClass} rows={2} />
                    </Field>
                    <Field label="公開時の注意（任意）">
                        <input name="publicationCaveat" className={inputClass} />
                    </Field>
                    <Button type="submit" variant="primary">登録</Button>
                </form>
            )}

            {!loading && items.length === 0 && <Empty>ソースが登録されていません</Empty>}
            <ul className="grid gap-2">
                {items.map((s) => (
                    <li key={s.sourceId} className="rounded border border-slate-200 p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{s.title}</span>
                            <span className="text-xs text-slate-500">{s.sourceId}</span>
                        </div>
                        <div className="mt-1 text-xs text-slate-600">
                            {SOURCE_TYPES.find(([v]) => v === s.sourceType)?.[1] ?? s.sourceType}
                            {s.url && <> · <a href={s.url} className="text-sky-700 underline" target="_blank" rel="noreferrer">{s.url}</a></>}
                        </div>
                        {s.observation && <p className="mt-1 text-xs text-slate-600">{s.observation}</p>}
                        {s.publicationCaveat && <p className="mt-1 text-xs text-amber-700">注意: {s.publicationCaveat}</p>}
                        <div className="mt-2">
                            <Button variant="danger" onClick={() => void remove(s.sourceId)}>削除</Button>
                        </div>
                    </li>
                ))}
            </ul>
        </Section>
    );
}
