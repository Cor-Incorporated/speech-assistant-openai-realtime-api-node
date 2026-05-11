export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2';
export const DEFAULT_REALTIME_REASONING_EFFORT = 'low';

export const REALTIME_MODEL_OPTIONS = [
    {
        value: 'gpt-realtime-2',
        label: 'GPT Realtime 2',
        description: '受付MVPの推奨。推論設定を利用できます。',
        supportsReasoning: true
    },
    {
        value: 'gpt-realtime-1.5',
        label: 'GPT Realtime 1.5',
        description: '単純案内や比較検証用。推論設定は送りません。',
        supportsReasoning: false
    }
];

export const REALTIME_REASONING_EFFORT_OPTIONS = ['low', 'medium', 'high'];

export const isSupportedRealtimeModel = (value) => REALTIME_MODEL_OPTIONS
    .some((option) => option.value === value);

export const normalizeRealtimeModel = (
    value,
    fallback = DEFAULT_REALTIME_MODEL
) => {
    const model = String(value || '').trim();
    if (isSupportedRealtimeModel(model)) return model;
    return isSupportedRealtimeModel(fallback) ? fallback : DEFAULT_REALTIME_MODEL;
};

export const normalizeReasoningEffort = (
    value,
    fallback = DEFAULT_REALTIME_REASONING_EFFORT
) => {
    const effort = String(value || '').trim();
    if (REALTIME_REASONING_EFFORT_OPTIONS.includes(effort)) return effort;
    return REALTIME_REASONING_EFFORT_OPTIONS.includes(fallback)
        ? fallback
        : DEFAULT_REALTIME_REASONING_EFFORT;
};

export const shouldSetRealtimeReasoning = (model) => normalizeRealtimeModel(model)
    .startsWith('gpt-realtime-2');

export const resolveRealtimeSettings = ({
    env = process.env,
    runtimeSettings = {}
} = {}) => {
    const realtimeModel = normalizeRealtimeModel(
        runtimeSettings.realtimeModel,
        env.REALTIME_MODEL || DEFAULT_REALTIME_MODEL
    );
    const realtimeReasoningEffort = normalizeReasoningEffort(
        runtimeSettings.realtimeReasoningEffort,
        env.REALTIME_REASONING_EFFORT || DEFAULT_REALTIME_REASONING_EFFORT
    );

    return {
        realtimeModel,
        realtimeReasoningEffort,
        source: runtimeSettings.realtimeModel ? 'store' : 'env',
        updatedAt: runtimeSettings.updatedAt || '',
        updatedBy: runtimeSettings.updatedBy || ''
    };
};

export const validateRealtimeSettingsPatch = (body = {}) => {
    const patch = {};
    const errors = [];

    if (Object.hasOwn(body, 'realtimeModel')) {
        const model = String(body.realtimeModel || '').trim();
        if (!isSupportedRealtimeModel(model)) {
            errors.push({
                field: 'realtimeModel',
                message: `Unsupported realtime model: ${model || '(empty)'}`
            });
        } else {
            patch.realtimeModel = model;
        }
    }

    if (Object.hasOwn(body, 'realtimeReasoningEffort')) {
        const effort = String(body.realtimeReasoningEffort || '').trim();
        if (!REALTIME_REASONING_EFFORT_OPTIONS.includes(effort)) {
            errors.push({
                field: 'realtimeReasoningEffort',
                message: `Unsupported reasoning effort: ${effort || '(empty)'}`
            });
        } else {
            patch.realtimeReasoningEffort = effort;
        }
    }

    if (Object.keys(patch).length === 0 && errors.length === 0) {
        errors.push({
            field: 'runtimeSettings',
            message: 'No supported runtime setting was provided'
        });
    }

    return {
        ok: errors.length === 0,
        patch,
        errors
    };
};
