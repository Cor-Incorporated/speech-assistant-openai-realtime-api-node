import {
    appendPhoneDigitFragments,
    extractJapanesePhoneCandidates,
    extractPhoneDigits,
    findValidateCallbackPhoneToolCalls,
    recoverRepeatedJapaneseCallbackPhoneNumber,
    validateJapaneseCallbackPhoneNumber
} from './phone-number-validation.js';
import { findFinishReceptionToolCalls } from './realtime-call-end.js';
import {
    findTransferToHumanToolCalls,
    isComplaintCall,
    isCustomerHarassmentCall,
    isEmergencyCall,
    resolveHandoffDestination,
    shouldAllowHumanHandoff
} from './handoff.js';

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
    allowComplexComplaintHandoff = false,
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
        const handoffBlockedByBusinessPolicy = handoffConfig.blockNonHandoffBusiness === true;
        const businessCallbackRequired = handoffConfig.requireBusinessCallback === true;
        if (handoffBlockedByBusinessPolicy || !handoffConfig.enabled || handoffConfig.numbers.length === 0) {
            for (const toolCall of handoffToolCalls) {
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: false,
                    reason: handoffBlockedByBusinessPolicy
                        ? 'non_handoff_business_call'
                        : 'handoff_unavailable',
                    instruction: handoffBlockedByBusinessPolicy
                        ? businessCallbackRequired
                            ? '今回は電話転送を行わず、内容を受付して担当者から改めて折り返します。内部の判定理由は顧客に説明せず、必要時の連絡先電話番号を聞いてvalidate_callback_phoneで検証し、callback_required=trueのfinish_receptionで受付を完了してください。'
                            : '今回は電話転送を行わず、内容を受付・記録して担当者へ報告します。必要時の連絡先電話番号を聞いてvalidate_callback_phoneで検証し、明確な折り返し希望がなければcallback_required=falseのfinish_receptionで受付を完了してください。内部の判定理由は顧客に説明しないでください。'
                        : '担当者への転送機能が現在利用できません。転送できない旨を丁寧に案内し、受付内容を記録してください。'
                }));
            }
        } else {
            for (const toolCall of handoffToolCalls) {
                const destination = resolveHandoffDestination(toolState.turns || [], toolCall.destination);
                const emergencyCall = isEmergencyCall(toolState.turns || []);
                const customerHarassmentBlocked = isCustomerHarassmentCall(toolState.turns || [])
                    && destination === 'general';
                const complexComplaintHandoffAllowed = allowComplexComplaintHandoff
                    && destination === 'general'
                    && isComplaintCall(toolState.turns || [])
                    && !customerHarassmentBlocked;
                if (emergencyCall || customerHarassmentBlocked || (handoffConfig.enforceRoutingPolicy
                    && !shouldAllowHumanHandoff(toolState.turns || [], destination)
                    && !complexComplaintHandoffAllowed)) {
                    outputs.push(functionCallOutputItem(toolCall.callId, {
                        ok: false,
                        reason: emergencyCall
                            ? 'emergency_services'
                            : customerHarassmentBlocked
                            ? 'customer_harassment_ai_handling'
                            : destination === 'contract'
                            ? 'contract_request_not_detected'
                            : 'non_urgent_general_handoff',
                        instruction: emergencyCall
                            ? '生命や身体に関わる緊急事態の可能性があるため、電話転送は行いません。顧客には、直ちに緊急の場合は110または119へ連絡するよう短く案内し、会社の受付で対応できる範囲を説明してください。'
                            : customerHarassmentBlocked
                            ? '人間への転送は行いません。暴言や威圧には反論せず、落ち着いた言葉で対応可能な範囲を案内し、必要な事実を最小限確認してください。攻撃的な発言が続く場合は丁寧に終話してください。'
                            : destination === 'contract'
                            ? '転送対象の仕事の依頼として確認できないため、電話転送は行いません。顧客には判定理由を説明せず、内容を受付して確認後に折り返す案内をしてください。'
                            : '転送対象として確認できないため、電話転送は行いません。顧客には判定理由を説明せず、内容を受付して必要な情報を確認してください。'
                    }));
                    continue;
                }
                handoffRequests.push({
                    callId: toolCall.callId,
                    reason: toolCall.reason,
                    destination
                });
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: true,
                    status: 'starting',
                    destination,
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
            const businessCallbackRequired = handoffConfig.requireBusinessCallback === true;
            const callbackContactRequired = toolCall.callbackRequired
                || handoffConfig.requireCallbackContact === true
                || businessCallbackRequired;
            if (callbackContactRequired && !toolState.callbackPhone?.valid) {
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: false,
                    reason: toolCall.callbackRequired
                        ? 'callback_phone_not_validated'
                        : 'business_callback_contact_not_validated',
                    instruction: toolCall.callbackRequired
                        ? '折り返しが必要です。finish_receptionの前に折り返し先電話番号を聞き、validate_callback_phoneで有効判定を受けてから顧客に確認してください。'
                        : businessCallbackRequired
                            ? '緊急性のない相談の受付を完了する前に、折り返し先電話番号を一つ聞き、validate_callback_phoneで有効判定を受けてください。担当者から改めて折り返すためcallback_required=trueでfinish_receptionを再実行してください。'
                            : '営業・採用提案の受付を完了する前に、必要時の連絡先電話番号を一つ聞き、validate_callback_phoneで有効判定を受けてください。折り返し希望がなければcallback_required=falseのままfinish_receptionを再実行してください。'
                }));
                continue;
            }

            if (businessCallbackRequired && !toolCall.callbackRequired) {
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: false,
                    reason: 'business_callback_required',
                    instruction: '営業ではない緊急性のない相談なので、担当者から改めて折り返します。finish_receptionをcallback_required=trueで再実行してください。'
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
