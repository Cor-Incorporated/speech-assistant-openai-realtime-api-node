// Server-side routing policy — a pure function.
// Classification (which intent, which risks) never grants transfer authority
// by itself: the policy decides, informed by the decision, the configured
// flags, and the state of caller confirmation.

import type { HandoffDestination } from '../contracts/tool-arguments.js';
import type { Intent, RiskFlag, RoutingDecision } from '../contracts/routing-result.js';

export interface RoutingPolicyFlags {
    handoffEnabled: boolean;
    handoffNumbersConfigured: boolean;
    blockNonHandoffBusiness: boolean;
    requireBusinessCallback: boolean;
    enforceRoutingPolicy: boolean;
    allowComplexComplaintHandoff: boolean;
}

export const DEFAULT_POLICY_FLAGS: RoutingPolicyFlags = {
    handoffEnabled: false,
    handoffNumbersConfigured: false,
    blockNonHandoffBusiness: true,
    requireBusinessCallback: true,
    enforceRoutingPolicy: true,
    allowComplexComplaintHandoff: false
};

export type TransferVerdict =
    | { allowed: true; destination: HandoffDestination }
    | { allowed: false; reason: string };

const NON_HANDOFF_INTENTS: readonly Intent[] = [
    'sales_offer',
    'recruitment',
    'partnership_media'
];

const COMPLEX_INTENTS: readonly Intent[] = ['billing_complaint', 'existing_support'];

/**
 * Evaluate a transfer_to_human request against a routing decision.
 * Mirrors the safety checks embedded in lib/realtime-tool-flow.js and
 * lib/handoff.js, expressed on the intent/risk taxonomy:
 *
 * - life-safety emergencies are never transferred to staff (guidance only);
 * - caller aggression never transfers (AI continues calmly);
 * - contract destination requires a contract_request intent;
 * - general destination requires urgency, or a complex case the operator
 *   explicitly allowed;
 * - non-handoff business intents (sales / recruiting solicitations /
 *   partnership) are always kept at the AI reception;
 * - an uncertain decision grants nothing.
 */
export function evaluateTransferRequest(
    destination: HandoffDestination,
    decision: RoutingDecision,
    flags: RoutingPolicyFlags
): TransferVerdict {
    if (!flags.handoffEnabled || !flags.handoffNumbersConfigured) {
        return { allowed: false, reason: 'handoff_unavailable' };
    }

    if (decision.kind === 'uncertain') {
        return { allowed: false, reason: 'classification_uncertain' };
    }

    const risks = new Set<RiskFlag>(decision.risks);
    const intents = new Set<Intent>(decision.intents);

    if (risks.has('life_safety_emergency')) {
        return { allowed: false, reason: 'emergency_services' };
    }

    const nonHandoffBusiness = intents.has('sales_offer')
        || intents.has('recruitment')
        || intents.has('partnership_media');

    if (flags.blockNonHandoffBusiness && nonHandoffBusiness) {
        return { allowed: false, reason: 'non_handoff_business_call' };
    }

    if (destination === 'general' && risks.has('caller_aggression')) {
        return { allowed: false, reason: 'customer_harassment_ai_handling' };
    }

    if (destination === 'contract') {
        return intents.has('contract_request')
            ? { allowed: true, destination: 'contract' }
            : { allowed: false, reason: 'contract_request_not_detected' };
    }

    // destination === 'general'
    const urgent = risks.has('urgency') && !nonHandoffBusiness;
    const complexAllowed = flags.allowComplexComplaintHandoff
        && COMPLEX_INTENTS.some((intent) => intents.has(intent))
        && !risks.has('caller_aggression');

    if (flags.enforceRoutingPolicy && !urgent && !complexAllowed) {
        return { allowed: false, reason: 'non_urgent_general_handoff' };
    }

    return { allowed: true, destination: 'general' };
}

export type EscalationTier = 'standard' | 'complex_complaint';

export interface ModelEscalationDecision {
    tier: EscalationTier;
    category: 'standard' | 'complaint' | 'complex_support' | 'customer_harassment';
    humanTransferAllowed: boolean;
}

/**
 * Which backend tier should handle this decision — mirrors
 * lib/realtime-escalation.js classifyRealtimeConversation.
 */
export function evaluateModelEscalation(decision: RoutingDecision): ModelEscalationDecision {
    if (decision.kind === 'uncertain') {
        return { tier: 'standard', category: 'standard', humanTransferAllowed: false };
    }

    const risks = new Set(decision.risks);
    const intents = new Set(decision.intents);

    if (risks.has('caller_aggression')) {
        return { tier: 'complex_complaint', category: 'customer_harassment', humanTransferAllowed: false };
    }
    if (risks.has('security_legal') || intents.has('existing_support') && risks.has('third_party_threat')) {
        return { tier: 'complex_complaint', category: 'complex_support', humanTransferAllowed: true };
    }
    if (intents.has('billing_complaint') || intents.has('existing_support')) {
        return { tier: 'complex_complaint', category: 'complaint', humanTransferAllowed: true };
    }
    return { tier: 'standard', category: 'standard', humanTransferAllowed: false };
}
