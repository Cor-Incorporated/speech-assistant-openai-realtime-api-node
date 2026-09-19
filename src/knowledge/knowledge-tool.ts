// Read-only knowledge tool for the Live/Realtime voice path.
// The argument schema deliberately exposes only `query` — there is no
// includePrivate flag, no collection selector, no SQL, no revision picker,
// so a prompt-injected caller cannot widen its own access through the tool.

import type { KnowledgeReader, LookupResult } from './knowledge-reader.js';

export const LOOKUP_COMPANY_KNOWLEDGE_TOOL_NAME = 'lookup_company_knowledge';

export interface KnowledgeToolResult {
    status: 'found' | 'unknown' | 'expired' | 'unavailable';
    releaseId: string | null;
    stale: boolean;
    items: Array<{
        knowledgeId: string;
        revision: number;
        answer: string | null;
        sourceIds: string[];
        asOf: string | null;
        requiresHumanReview: boolean;
    }>;
}

/**
 * Responses-API function tool definition — the same shape the existing
 * Realtime tools and Live delegation.responses.tools already accept.
 */
export function buildLookupCompanyKnowledgeTool(): Record<string, unknown> {
    return {
        type: 'function',
        name: LOOKUP_COMPANY_KNOWLEDGE_TOOL_NAME,
        description:
            '承認・公開済みのCor.株式会社情報を検索する読取専用tool。営業時間、事業内容、料金目安、連絡先など、発信者から会社について聞かれたときだけ使う。未承認・社内専用の情報は一切返らない。',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '発信者の質問内容または検索したいトピック（日本語）'
                }
            },
            required: ['query'],
            additionalProperties: false
        },
        strict: true
    };
}

const MAX_QUERY_CHARS = 300;

/** Execute one lookup. Errors degrade to `unavailable` — the voice layer
 * must still be able to answer "確認します" instead of crashing the call. */
export async function executeKnowledgeLookup(
    reader: KnowledgeReader,
    rawArguments: unknown
): Promise<KnowledgeToolResult> {
    let query = '';
    if (typeof rawArguments === 'string') {
        try {
            const parsed = JSON.parse(rawArguments) as unknown;
            query = extractQuery(parsed);
        } catch {
            return unavailable();
        }
    } else {
        query = extractQuery(rawArguments);
    }

    if (!query) return { status: 'unknown', releaseId: null, stale: false, items: [] };

    try {
        const result: LookupResult = await reader.lookup(query.slice(0, MAX_QUERY_CHARS));
        return {
            status: result.status,
            releaseId: result.releaseId,
            stale: result.stale,
            items: result.items.map((item) => ({
                knowledgeId: item.knowledgeId,
                revision: item.revision,
                answer: item.answer,
                sourceIds: item.sourceIds,
                asOf: item.asOf,
                requiresHumanReview: item.requiresHumanReview
            }))
        };
    } catch {
        return unavailable();
    }
}

const extractQuery = (value: unknown): string => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const query = (value as Record<string, unknown>).query;
    return typeof query === 'string' ? query.trim() : '';
};

const unavailable = (): KnowledgeToolResult => ({
    status: 'unavailable',
    releaseId: null,
    stale: false,
    items: []
});

/** Detects a tool call item for this tool in a provider response output —
 * same wire shape for Realtime `response.output_item.done` and Live
 * delegated `output_item.done`. */
export function isKnowledgeLookupCall(item: unknown): item is { call_id?: string; name: string; arguments?: string } {
    return Boolean(item)
        && typeof item === 'object'
        && (item as Record<string, unknown>).type === 'function_call'
        && (item as Record<string, unknown>).name === LOOKUP_COMPANY_KNOWLEDGE_TOOL_NAME;
}
