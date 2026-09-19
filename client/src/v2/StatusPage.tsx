import { useCallback, useEffect, useState } from 'react';
import { apiGet } from './api';
import type { Release, StatusResponse } from './types';
import { Button, ErrorBanner, Section, formatDate } from './ui';

const ROLE_LABELS: Record<string, string> = {
    viewer: '閲覧',
    operator: 'オペレータ',
    knowledge_editor: 'ナレッジ編集',
    knowledge_approver: 'ナレッジ承認',
    supervisor: 'スーパーバイザ',
    privacy_admin: 'プライバシ管理',
    ingestion_service: '取込サービス'
};

export default function StatusPage() {
    const [status, setStatus] = useState<StatusResponse | null>(null);
    const [releases, setReleases] = useState<Release[]>([]);
    const [currentReleaseId, setCurrentReleaseId] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [statusRes, releasesRes] = await Promise.all([
                apiGet<StatusResponse>('/api/admin/v2/status'),
                apiGet<{ items: Release[]; currentReleaseId: string | null }>('/api/admin/v2/knowledge-releases')
            ]);
            setStatus(statusRes.body);
            setReleases(releasesRes.body.items);
            setCurrentReleaseId(releasesRes.body.currentReleaseId);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Section title="アカウント・権限" actions={<Button onClick={() => void load()} disabled={loading}>再読込</Button>}>
                <ErrorBanner error={error} />
                {status && (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <dt className="text-slate-500">subject</dt><dd>{status.actor.subject}</dd>
                        <dt className="text-slate-500">ロール</dt>
                        <dd className="flex flex-wrap gap-1">
                            {status.actor.roles.map((r) => (
                                <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{ROLE_LABELS[r] ?? r}</span>
                            ))}
                        </dd>
                        <dt className="text-slate-500">アカウント種別</dt>
                        <dd>{status.actor.sharedAccount ? '共有アカウント（個人操作は制限されます）' : '個人アカウント'}</dd>
                        <dt className="text-slate-500">音声プロバイダ</dt><dd>{status.voiceProvider}</dd>
                        <dt className="text-slate-500">ルーティング</dt><dd>{status.routingProvider}</dd>
                    </dl>
                )}
            </Section>

            <Section title="ナレッジ公開状態">
                {status && (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <dt className="text-slate-500">現在のrelease</dt><dd>{status.knowledge.currentReleaseId ?? '未公開'}</dd>
                        <dt className="text-slate-500">失効epoch</dt><dd>{status.knowledge.revocationEpoch}</dd>
                        <dt className="text-slate-500">状態別件数</dt>
                        <dd className="flex flex-wrap gap-2">
                            {Object.entries(status.knowledge.byState).map(([state, count]) => (
                                <span key={state} className="text-xs">{state}: {count}</span>
                            ))}
                        </dd>
                    </dl>
                )}
            </Section>

            <Section title="release履歴">
                {releases.length === 0 ? (
                    <p className="text-sm text-slate-500">releaseはまだありません</p>
                ) : (
                    <ul className="grid gap-2 text-sm">
                        {releases.map((r) => (
                            <li key={r.releaseId} className="flex items-center justify-between rounded border border-slate-200 p-2">
                                <span>{r.releaseId}</span>
                                <span className="flex items-center gap-2 text-xs text-slate-500">
                                    {r.releaseId === currentReleaseId && <span className="rounded bg-emerald-100 px-1.5 text-emerald-800">現行</span>}
                                    {formatDate(r.createdAt)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>
        </div>
    );
}
