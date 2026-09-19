import { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { ApiError } from './api';

export const formatDate = (value?: string | null) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    }).format(date);
};

const STATE_LABELS: Record<string, string> = {
    draft: '下書き',
    in_review: 'レビュー中',
    approved: '承認済み',
    published: '公開中',
    withdrawn: '撤回済み',
    rejected: '却下',
    notified: '通知済み',
    acknowledged: '受諾済み',
    connected: '接続済み',
    resolved: '解決済み',
    required: '要対応',
    assigned: '割当済み',
    connecting: '接続中',
    unavailable: '不在',
    new: '新規',
    in_progress: '対応中',
    needs_callback: '折り返し要',
    done: '完了',
    open: '未解決',
    closed: '解決済み'
};

export const StateBadge = ({ state }: { state: string }) => (
    <span
        className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
            state === 'published' && 'border-emerald-300 bg-emerald-50 text-emerald-800',
            state === 'approved' && 'border-sky-300 bg-sky-50 text-sky-800',
            (state === 'draft' || state === 'new' || state === 'open') && 'border-slate-300 bg-slate-50 text-slate-700',
            state === 'in_review' && 'border-amber-300 bg-amber-50 text-amber-800',
            (state === 'withdrawn' || state === 'rejected') && 'border-red-300 bg-red-50 text-red-800',
            (state === 'acknowledged' || state === 'resolved' || state === 'done' || state === 'closed') && 'border-emerald-300 bg-emerald-50 text-emerald-800',
            state === 'notified' && 'border-amber-300 bg-amber-50 text-amber-800',
            state === 'connected' && 'border-emerald-300 bg-emerald-50 text-emerald-800'
        )}
    >
        {STATE_LABELS[state] ?? state}
    </span>
);

export const ErrorBanner = ({ error }: { error: unknown }) => {
    if (!error) return null;
    const apiError = error instanceof ApiError ? error : null;
    const message = apiError?.message ?? (error instanceof Error ? error.message : String(error));
    return (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            <p>{message}</p>
            {apiError?.fieldErrors && (
                <ul className="mt-1 list-inside list-disc">
                    {Object.entries(apiError.fieldErrors).map(([field, issue]) => (
                        <li key={field}>
                            <span className="font-medium">{field}</span>: {issue}
                        </li>
                    ))}
                </ul>
            )}
            {apiError?.isConflict && (
                <p className="mt-1 text-xs">他の人が先に更新しました。再読み込みして最新を確認してください。</p>
            )}
        </div>
    );
};

export const Button = ({
    children,
    onClick,
    disabled,
    variant = 'default',
    type = 'button',
    ariaLabel
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: 'default' | 'primary' | 'danger' | 'ghost';
    type?: 'button' | 'submit';
    ariaLabel?: string;
}) => (
    <button
        type={type}
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
            'rounded border px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
            variant === 'default' && 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus:ring-slate-400',
            variant === 'primary' && 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800 focus:ring-slate-400',
            variant === 'danger' && 'border-red-300 bg-white text-red-700 hover:bg-red-50 focus:ring-red-300',
            variant === 'ghost' && 'border-transparent bg-transparent text-slate-600 hover:bg-slate-100 focus:ring-slate-400'
        )}
    >
        {children}
    </button>
);

export const Field = ({ label, children, error }: { label: string; children: ReactNode; error?: string }) => (
    <label className="grid gap-1 text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        {children}
        {error && <span className="text-xs text-red-700">{error}</span>}
    </label>
);

export const inputClass = 'w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200';

export const Section = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => (
    <section className="grid gap-3 rounded border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {actions}
        </div>
        {children}
    </section>
);

export const Empty = ({ children }: { children: ReactNode }) => (
    <p className="rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{children}</p>
);
