import { useState } from 'react';
import { cn } from '../lib/cn';
import KnowledgePage from './KnowledgePage';
import CallsPage from './CallsPage';
import EscalationsPage from './EscalationsPage';
import SourcesPage from './SourcesPage';
import ReviewsPage from './ReviewsPage';
import StatusPage from './StatusPage';

type Tab = 'knowledge' | 'calls' | 'escalations' | 'reviews' | 'sources' | 'status';

const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'knowledge', label: 'ナレッジ' },
    { id: 'calls', label: '通話（v2）' },
    { id: 'escalations', label: 'エスカレーション' },
    { id: 'reviews', label: 'レビュー' },
    { id: 'sources', label: 'ソース' },
    { id: 'status', label: 'ステータス' }
];

export default function V2App() {
    const [tab, setTab] = useState<Tab>(() => {
        const hash = window.location.hash.replace('#v2-', '').replace('#v2', '');
        return (TABS.some((t) => t.id === hash) ? hash : 'knowledge') as Tab;
    });

    const select = (id: Tab) => {
        setTab(id);
        window.location.hash = `v2-${id}`;
    };

    return (
        <div className="min-h-screen bg-slate-50 p-4 text-slate-900 md:p-6">
            <div className="mx-auto grid w-full min-w-0 max-w-7xl gap-4">
                <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-sm font-medium text-slate-500">Cor Voice Admin v2</p>
                        <h1 className="text-2xl font-semibold text-slate-950">受付管理コンソール</h1>
                    </div>
                    <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); window.location.hash = ''; window.location.reload(); }}
                        className="text-sm text-sky-700 underline hover:text-sky-900"
                    >
                        通話ログ（従来UI）へ
                    </a>
                </header>

                <nav className="flex flex-wrap gap-1" aria-label="管理セクション">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => select(t.id)}
                            aria-pressed={tab === t.id}
                            className={cn(
                                'rounded-t border border-b-0 px-4 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-slate-400',
                                tab === t.id
                                    ? 'border-slate-300 bg-white text-slate-900'
                                    : 'border-transparent bg-transparent text-slate-600 hover:bg-slate-100'
                            )}
                        >
                            {t.label}
                        </button>
                    ))}
                </nav>

                <main>
                    {tab === 'knowledge' && <KnowledgePage />}
                    {tab === 'calls' && <CallsPage />}
                    {tab === 'escalations' && <EscalationsPage />}
                    {tab === 'reviews' && <ReviewsPage />}
                    {tab === 'sources' && <SourcesPage />}
                    {tab === 'status' && <StatusPage />}
                </main>
            </div>
        </div>
    );
}
