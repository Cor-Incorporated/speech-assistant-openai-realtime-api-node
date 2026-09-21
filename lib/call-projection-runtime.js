// Call projection runtime — lazily binds the compiled
// dist-backend/calls/call-projector.js against the admin v2 repositories.
// REVIEW-R09: real provider calls must appear in callLogsV2; when the
// backend build is missing this degrades to a no-op instead of breaking
// calls, and all failures are logged + swallowed.

const state = {
    loaded: false,
    failed: false,
    project: null
};

export const initCallProjection = async ({ callRepo, escalationRepo, log } = {}) => {
    if (state.loaded || state.failed) return state;
    try {
        if (!callRepo) throw new Error('call_repository_unavailable');
        const mod = await import('../dist-backend/calls/call-projector.js');
        state.project = async (input) => mod.projectProviderCall(callRepo, escalationRepo ?? null, input);
        state.loaded = true;
    } catch (error) {
        state.failed = true;
        log?.warn?.({ err: String(error?.message ?? error) }, 'call projection disabled');
    }
    return state;
};

/** Never throws — projection must not break the voice path. */
export const projectProviderCall = async (input) => {
    if (!state.project) return null;
    try {
        return await state.project(input);
    } catch (error) {
        console.warn('[call-projection] projection failed:', error?.message ?? error);
        return null;
    }
};
