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

// REVIEW-R05: phone syntax validity and caller confirmation are distinct
// facts. `valid: true` only proves the digits parse — the finish gate also
// requires `confirmed: true`, which is set only when (1) an agent turn after
// validation read the number back and (2) a later user turn affirmed it.
// A validate+finish pair inside ONE response can never satisfy this — the
// caller has not heard the readback yet.
const AFFIRM_PATTERN = /はい|そうです|あっています|合っています|あってます|合ってます|間違いありません|間違いない|まちがいない|まちがいありません|大丈夫|だいじょうぶ|お願いします|おねがいします|ええ|うん|yes|ok|オーケー/i;
// RECHECK-RR05/N02: a bare "間違" also matches the affirmation
// "間違いありません" — negation must only fire on explicit corrections, so
// the affirmative forms are excluded from the negation surface.
// ACCEPT-U01: "いいえ"/"間違いです" are explicit denials even when the same
// sentence carries an affirmative token ("いいえ、もう一度お願いします",
// "はい、間違いです" — C01/C02). A re-readback request ("もう一度") also
// cancels the pending confirmation.
const NEGATE_PATTERN = /いいえ|いえ|違います|ちがいます|違う|ちがう|訂正|否定|間違いです|間違いでした|間違いだ|まちがいです|まちがいでした|まちがいだ|間違って|まちがって|もう一度|もう一回|かけないで|掛けないで|止めて|やめて/;

/** Domestic digit form for comparison — "+81" and "0" prefixes denote the
 * same Japanese number. */
const canonicalPhoneDigits = (value) => {
    const digits = extractPhoneDigits(value || '');
    return digits.startsWith('81') && digits.length >= 12 ? `0${digits.slice(2)}` : digits;
};

const refreshCallerConfirmation = (toolState) => {
    const phone = toolState.callbackPhone;
    if (!phone?.valid || !phone.validatedAt) return;
    const turns = Array.isArray(toolState.turns) ? toolState.turns : [];
    const afterValidation = turns.filter((t) => t.at && t.at > phone.validatedAt && !t.provisional);
    const expectedDigits = canonicalPhoneDigits(phone.normalizedPhoneNumber);

    // RECHECK-RR05: confirmation is bound to the readback of THIS number.
    // Only an agent turn containing the validated digits opens the window
    // (an unrelated question does not — N01), a later user negation revokes
    // an existing confirmation (N03), and affirmative phrasing containing
    // "間違いありません" still counts as affirmation (N02).
    // ACCEPT-T01: the readback window is per-question — a user negation or
    // an intervening agent turn on another topic expires it, so a later
    // "はい" answers the CURRENT question, not a stale readback (B01/B02).
    let pendingReadback = false;
    for (const turn of afterValidation) {
        const isAgent = turn.role === 'agent' || turn.role === 'assistant';
        if (isAgent) {
            pendingReadback = Boolean(expectedDigits)
                && canonicalPhoneDigits(String(turn.text || '')).includes(expectedDigits);
            continue;
        }
        if (turn.role !== 'user') continue;
        const text = String(turn.text || '');
        if (NEGATE_PATTERN.test(text)) {
            phone.confirmed = false;
            phone.confirmedAt = undefined;
            pendingReadback = false;
            continue;
        }
        if (pendingReadback && phone.confirmed !== true && AFFIRM_PATTERN.test(text)) {
            phone.confirmed = true;
            phone.confirmedAt = turn.at;
        }
    }
};

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
    // A failed/incomplete/cancelled response can carry truncated tool calls —
    // their outputs are still returned (the model did emit them) but business
    // side effects (transfer, call end) must not execute on stale data.
    const responseStatus = event?.response?.status;
    const responseCompleted = responseStatus === undefined
        || responseStatus === 'completed'
        || responseStatus === 'response.completed';
    // One response can mix categories (phone validation + transfer + finish).
    // Every category is processed in a single pass and each call_id yields at
    // most one output — a resent/duplicated call never gets a second result.
    const seenCallIds = new Set();
    const handledCategories = [];

    const alreadySeen = (callId) => {
        if (!callId || seenCallIds.has(callId)) return true;
        seenCallIds.add(callId);
        return false;
    };

    const phoneToolCalls = findValidateCallbackPhoneToolCalls(event);
    if (phoneToolCalls.length > 0) {
        handledCategories.push('validate_callback_phone');
        for (const toolCall of phoneToolCalls) {
            if (alreadySeen(toolCall.callId)) continue;
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
                    confirmed: false,
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
    }

    const handoffToolCalls = findTransferToHumanToolCalls(event);
    if (handoffToolCalls.length > 0) {
        handledCategories.push('transfer_to_human');
        const handoffBlockedByBusinessPolicy = handoffConfig.blockNonHandoffBusiness === true;
        const businessCallbackRequired = handoffConfig.requireBusinessCallback === true;
        if (handoffBlockedByBusinessPolicy || !handoffConfig.enabled || handoffConfig.numbers.length === 0) {
            for (const toolCall of handoffToolCalls) {
                if (alreadySeen(toolCall.callId)) continue;
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
                if (alreadySeen(toolCall.callId)) continue;
                const destination = resolveHandoffDestination(toolState.turns || [], toolCall.destination);
                const emergencyCall = isEmergencyCall(toolState.turns || []);
                const customerHarassmentBlocked = isCustomerHarassmentCall(toolState.turns || [])
                    && destination === 'general';
                const complexComplaintHandoffAllowed = allowComplexComplaintHandoff
                    && destination === 'general'
                    && isComplaintCall(toolState.turns || [])
                    && !customerHarassmentBlocked;
                if (!responseCompleted) {
                    outputs.push(functionCallOutputItem(toolCall.callId, {
                        ok: false,
                        reason: 'response_not_completed',
                        instruction: '前回の応答が完了せず転送を実行できませんでした。顧客の最新の発話を踏まえ、必要なら転送可否をもう一度評価してください。'
                    }));
                    continue;
                }
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
    }

    const finishToolCalls = findFinishReceptionToolCalls(event);
    if (finishToolCalls.length > 0) {
        handledCategories.push('finish_reception');
        // The caller may have affirmed the readback in the turns since the
        // last tool event — refresh the confirmation fact before gating.
        refreshCallerConfirmation(toolState);
        for (const toolCall of finishToolCalls) {
            if (alreadySeen(toolCall.callId)) continue;
            if (!responseCompleted) {
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: false,
                    reason: 'response_not_completed',
                    instruction: '前回の応答が完了せず終話を実行できませんでした。顧客の発話を待ってから受付完了をもう一度評価してください。'
                }));
                continue;
            }
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
            // Valid ≠ confirmed: the caller must have affirmed the readback
            // in a turn AFTER the assistant spoke it. Same-response
            // validate+finish can never satisfy this.
            if (callbackContactRequired && toolState.callbackPhone?.confirmed !== true) {
                outputs.push(functionCallOutputItem(toolCall.callId, {
                    ok: false,
                    reason: 'callback_phone_not_confirmed',
                    instruction: '電話番号の形式は有効ですが、顧客の確認がまだです。confirmationPromptで番号を読み上げ、顧客の確認を待ってからfinish_receptionを再実行してください。'
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
    }

    if (handledCategories.length === 0) {
        return {
            handled: false,
            responseReason: '',
            outputs,
            callEndRequests,
            handoffRequests
        };
    }

    return {
        handled: true,
        responseReason: handledCategories.map((name) => `${name}_tool_output`).join('+'),
        outputs,
        callEndRequests,
        handoffRequests
    };
}
