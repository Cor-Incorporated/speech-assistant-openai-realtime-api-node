import {
    isContractRequest,
    isCustomerHarassmentCall,
    isEmergencyCall,
    isNonHandoffBusinessCall,
    shouldAllowHumanHandoff,
    shouldAutoHandoffGeneral
} from './handoff.js';
import { classifyRealtimeConversation } from './realtime-escalation.js';

/**
 * Single decision surface for "does this call need a human?".
 *
 * Production (index.js) and the golden/scenario tests both call these
 * functions, so a routing change cannot pass the tests while the live path
 * behaves differently.
 */
export const DISPOSITIONS = Object.freeze({
    EMERGENCY_GUIDANCE: 'emergency_guidance',
    HUMAN_GATE: 'human_gate',
    AI_HARASSMENT_BOUNDARY: 'ai_harassment_boundary',
    AI_BUSINESS_INTAKE: 'ai_business_intake',
    AI_PRECISION_INTAKE: 'ai_precision_intake',
    AI_GENERAL_INTAKE: 'ai_general_intake'
});

export function resolveUrgentDestination(turns = []) {
    return isContractRequest(turns) ? 'contract' : 'general';
}

// The automatic transfer trigger: an explicit urgency request that is not an
// emergency (110/119 guidance), not a sales/recruiting/partnership call and not
// a complaint that the high-precision mode must first sort out.
export function shouldAutoStartUrgentHandoff(turns = [], classification = classifyRealtimeConversation(turns)) {
    return shouldAutoHandoffGeneral(turns)
        && classification.tier !== 'complex_complaint'
        && !isEmergencyCall(turns)
        && !isNonHandoffBusinessCall(turns);
}

export function classifyCallDisposition(turns = []) {
    const classification = classifyRealtimeConversation(turns);

    if (isEmergencyCall(turns)) {
        return { disposition: DISPOSITIONS.EMERGENCY_GUIDANCE, handledBy: 'ai', destination: null, trigger: null, notifyEmail: true };
    }
    if (isCustomerHarassmentCall(turns)) {
        return { disposition: DISPOSITIONS.AI_HARASSMENT_BOUNDARY, handledBy: 'ai', destination: null, trigger: null, notifyEmail: true };
    }
    if (shouldAutoStartUrgentHandoff(turns, classification)) {
        return {
            disposition: DISPOSITIONS.HUMAN_GATE,
            handledBy: 'human_gate',
            destination: resolveUrgentDestination(turns),
            trigger: 'urgent_auto',
            notifyEmail: true
        };
    }
    if (isNonHandoffBusinessCall(turns)) {
        return { disposition: DISPOSITIONS.AI_BUSINESS_INTAKE, handledBy: 'ai', destination: null, trigger: null, notifyEmail: true };
    }
    if (isContractRequest(turns) && shouldAllowHumanHandoff(turns, 'contract')) {
        return { disposition: DISPOSITIONS.HUMAN_GATE, handledBy: 'human_gate', destination: 'contract', trigger: 'contract_request', notifyEmail: true };
    }
    if (classification.tier === 'complex_complaint') {
        return {
            disposition: DISPOSITIONS.AI_PRECISION_INTAKE,
            handledBy: 'ai',
            destination: null,
            trigger: null,
            notifyEmail: true,
            humanGatePossible: classification.humanTransferAllowed === true
        };
    }
    return { disposition: DISPOSITIONS.AI_GENERAL_INTAKE, handledBy: 'ai', destination: null, trigger: null, notifyEmail: true };
}
