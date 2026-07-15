import {
    appendPhoneDigitFragments,
    extractJapanesePhoneCandidates,
    extractPhoneDigits,
    findValidateCallbackPhoneToolCalls,
    recoverRepeatedJapaneseCallbackPhoneNumber,
    validateJapaneseCallbackPhoneNumber
} from './phone-number-validation.js';
import { findFinishReceptionToolCalls } from './realtime-call-end.js';
import { findTransferToHumanToolCalls } from './handoff.js';

const functionCallOutputItem = (callId, output) => ({
    type: 'conversation.item.create',
    item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output)
    }
});

export function handleRealtimeToolCalls({
    event,
    state,
    callEndConfig,
    handoffConfig = { enabled: false, numbers: [] },
    onPhoneValidation = null
}) {
    const outputs = [];
    const callEndRequests = [];
    const handoffRequests = [];
    const toolState = state || {};

    const phoneToolCalls = findValidateCallbackPhoneToolCalls(event);
    if (phoneToolCalls.length > 0) {
        for (const toolCall of phoneToolCalls) {
            const rawValidation = validateJapaneseCallbackPhoneNumber(toolCall.heardPhoneNumber);
            let validation = recoverRepeatedJapaneseCallbackPhoneNumber(toolCall.heardPhoneNumber)
                || rawValidation;
            let captureAction = validation !== rawValidation ? 'recovered_repeated' : 'direct';
            const currentDigits = extractPhoneDigits(toolCall.heardPhoneNumber);
            const previousDigits = toolState.callbackPhoneCapture?.digits || '';

            if (!validation.valid && ['no_candidate', 'too_short'].includes(rawValidation.reason) && currentDigits) {
                const combinedDigits = appendPhoneDigitFragments(previousDigits, currentDigits);
                const combinedInput = combinedDigits.startsWith('81') ? `+${combinedDigits}` : combinedDigits;
                const combinedValidation = validateJapaneseCallbackPhoneNumber(combinedInput);

                if (combinedValidation.valid) {
                    validation = combinedValidation;
                    captureAction = 'combined_fragments';
                    delete toolState.callbackPhoneCapture;
                } else if (combinedDigits.length < 11) {
                    toolState.callbackPhoneCapture = {
                        digits: combinedDigits,
                        updatedAt: new Date().toISOString()
                    };
                    captureAction = 'buffered_fragment';
                } else {
                    delete toolState.callbackPhoneCapture;
                }
            } else if (validation.valid) {
                delete toolState.callbackPhoneCapture;
            } else if (rawValidation.reason === 'too_long') {
                delete toolState.callbackPhoneCapture;
            }

            toolState.callbackPhone = validation.valid
                ? {
                    valid: true,
                    normalizedPhoneNumber: validation.normalizedPhoneNumber,
                    validatedAt: new Date().toISOString()
                }
                : {
                    valid: false,
                    reason: validation.reason,
                    validatedAt: new Date().toISOString()
                };

            if (typeof onPhoneValidation === 'function') {
                onPhoneValidation({
                    callId: toolCall.callId,
                    reason: validation.reason,
                    rawReason: rawValidation.reason,
                    captureAction,
                    inputChars: toolCall.heardPhoneNumber.length,
                    inputDigits: currentDigits.length,
                    candidateCount: extractJapanesePhoneCandidates(toolCall.heardPhoneNumber).length,
                    bufferedDigits: toolState.callbackPhoneCapture?.digits.length || 0,
                    valid: validation.valid
                });
            }

            outputs.push(functionCallOutputItem(toolCall.callId, {
                valid: validation.valid,
                reason: validation.reason,
                normalizedPhoneNumber: validation.normalizedPhoneNumber,
                formattedSpokenDigits: validation.formattedSpokenDigits,
                confirmationPrompt: validation.confirmationPrompt,
                clarificationPrompt: validation.clarificationPrompt,
                instruction: validation.valid
                    ? 'confirmationPromptをそのまま自然に読み上げ、顧客の確認を待ってください。番号を変更・補完してはいけません。'
                    : 'clarificationPromptをそのまま自然に読み上げ、もう一度電話番号を聞いてください。番号を補完してはいけません。'
            }));
        }

        return {
            handled: true,
            responseReason: 'validate_callback_phone_tool_output',
            outputs,
            callEndRequests,
            handoffRequests
        };
    }

    const handoffToolCalls = findTransferToHumanToolCalls(event);
    if (handoffToolCalls.length > 0) {
        if (!handoffConfig.enabled || handoffConfig.numbers.length === 0) {
            for (const toolCall of handoffToolCalls) {
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: false,
                    reason: 'handoff_unavailable',
                    instruction: '担当者への転送機能が現在利用できません。転送できない旨を丁寧に案内し、受付内容を記録してください。'
                }));
            }
        } else {
            for (const toolCall of handoffToolCalls) {
                handoffRequests.push({
                    callId: toolCall.callId,
                    reason: toolCall.reason,
                    destination: toolCall.destination
                });
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: true,
                    status: 'starting',
                    destination: toolCall.destination,
                    instruction: '担当者へおつなぎします。システムが転送を開始します。'
                }));
            }
        }

        return {
            handled: true,
            responseReason: 'transfer_to_human_tool_output',
            outputs,
            callEndRequests,
            handoffRequests
        };
    }

    const finishToolCalls = findFinishReceptionToolCalls(event);
    if (finishToolCalls.length > 0) {
        for (const toolCall of finishToolCalls) {
            if (toolCall.callbackRequired && !toolState.callbackPhone?.valid) {
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: false,
                    reason: 'callback_phone_not_validated',
                    instruction: '折り返しが必要です。finish_receptionの前に折り返し先電話番号を聞き、validate_callback_phoneで有効判定を受けてから顧客に確認してください。'
                }));
                continue;
            }

            callEndRequests.push({
                source: 'realtime_tool',
                reason: toolCall.reason
            });
            outputs.push(functionCallOutputItem(toolCall.callId, {
                ok: true,
                final_phrase: callEndConfig.finalPhrase,
                instruction: '受付完了です。短く最終案内を発話し、final_phraseを必ず含めてください。発話後にシステムが通話を終了します。',
                callback_required: toolCall.callbackRequired
            }));
        }

        return {
            handled: true,
            responseReason: 'finish_reception_tool_output',
            outputs,
            callEndRequests,
            handoffRequests
        };
    }

    return {
        handled: false,
        responseReason: '',
        outputs,
        callEndRequests,
        handoffRequests
    };
}
