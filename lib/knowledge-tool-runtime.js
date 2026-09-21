// Voice-path knowledge tool bridge — lazy-loads the compiled backend modules
// so index.js still boots without dist-backend (dev smoke). When the reader
// is unavailable the tool is simply not advertised to the provider, so the
// model can never call a tool that does not exist.
//
// Contract carried over from src/knowledge/knowledge-tool.ts:
//   * read-only — `query` is the only argument, nothing can widen access
//   * only the current release's whitelisted items are visible
//   * store failures degrade to `unavailable`, never crash the call
//   * every lookup carries the releaseId it was answered from

export const LOOKUP_COMPANY_KNOWLEDGE_TOOL_NAME = 'lookup_company_knowledge';

const state = {
    loaded: false,
    failed: false,
    reader: null,
    buildTool: null,
    executeLookup: null
};

export const initKnowledgeTool = async ({ knowledgeRepo = null, log = console } = {}) => {
    if (state.loaded || state.failed) return state;
    try {
        const { KnowledgeReader } = await import('../dist-backend/knowledge/knowledge-reader.js');
        const tool = await import('../dist-backend/knowledge/knowledge-tool.js');
        const { InMemoryKnowledgeRepository } = await import('../dist-backend/knowledge/repository.js');
        state.reader = new KnowledgeReader(knowledgeRepo ?? new InMemoryKnowledgeRepository());
        state.buildTool = tool.buildLookupCompanyKnowledgeTool;
        state.executeLookup = tool.executeKnowledgeLookup;
        state.loaded = true;
    } catch (error) {
        state.failed = true;
        log.warn('knowledge tool unavailable (backend build missing?)', { error: error.message });
    }
    return state;
};

/** Tool definition for session.tools / liveTools — null when unavailable so
 * callers can spread-filter it away. */
export const getKnowledgeToolDef = () => (state.loaded ? state.buildTool() : null);

/** Extract lookup_company_knowledge function_call items from a
 * response.done-shaped event (Realtime wire format — the Live bridge already
 * normalizes delegated calls into this shape). */
export const findKnowledgeToolCalls = (event) => {
    const output = event?.response?.output;
    if (!Array.isArray(output)) return [];
    return output
        .filter((item) => item?.type === 'function_call' && item?.name === LOOKUP_COMPANY_KNOWLEDGE_TOOL_NAME)
        .map((item) => ({ callId: item.call_id ?? '', name: item.name, arguments: item.arguments }));
};

/** Run one lookup. Returns a Realtime function_call_output item; the Live
 * path converts it with toLiveToolResultItem like every other output. */
export const executeKnowledgeCall = async (toolCall) => {
    const result = await state.executeLookup(state.reader, toolCall.arguments);
    return {
        type: 'function_call_output',
        call_id: toolCall.callId,
        output: JSON.stringify({
            status: result.status,
            stale: result.stale,
            // ACCEPT-V02: carry each item's key/title — answer text alone
            // does not always name the entity (「掲載目安はTeam Betaが
            // 月額5万円から」), which once made the answering model reject
            // a correct `found` result as "product unknown". The caller's
            // raw query is never echoed back — it could itself contain
            // sensitive wording.
            items: result.items.map((item) => ({
                key: item.key,
                title: item.title,
                answer: item.answer,
                as_of: item.asOf,
                requires_human_review: item.requiresHumanReview
            })),
            instruction: result.status === 'found'
                ? '以下は発信者の質問に対応する承認・公開済みの会社情報です。title/keyが示す対象（商品名等）の情報として、answerに対象名がなくても質問への回答そのものです。内容をそのまま簡潔に案内してください。requires_human_review=trueの項目は案内せず「担当者へ確認して折り返します」と伝えてください。'
                : result.status === 'expired'
                    ? '該当情報は確認期限切れです。推測で答えず「担当者へ確認して折り返します」と伝えてください。'
                    : '公開済みの情報では回答できません。推測・一般論で答えず「担当者へ確認して折り返します」と伝えてください。'
        }),
        // Side-channel for the caller's audit/call-event logging — stripped
        // before send.
        _meta: { releaseId: result.releaseId, stale: result.stale, status: result.status }
    };
};
