// LegacyRulesClassifier — maps the existing regex policy (lib/handoff.js)
// onto the intent/risk taxonomy. It reports what the current rules produce,
// including their known blind spots (negation, quoted danger words, threat
// direction) — it is the baseline Jev is compared against, not an oracle.

import {
    COMPLAINT_PATTERNS,
    COMPLEX_SUPPORT_PATTERNS,
    CONTRACT_REQUEST_PATTERNS,
    CUSTOMER_HARASSMENT_PATTERNS,
    EMERGENCY_PATTERNS,
    EVENT_BUSINESS_PATTERNS,
    GENERAL_HANDOFF_PATTERNS,
    PARTNERSHIP_AND_MEDIA_PATTERNS,
    RECRUITING_APPLICANT_PATTERNS,
    REPRESENTATIVE_REQUEST_PATTERNS,
    SALES_BUSINESS_PATTERNS,
    PAYMENT_DISPUTE_PATTERNS
} from '../../lib/handoff.js';
import type { HandoffTurn } from '../../lib/handoff.js';
import {
    emptySignals,
    type Intent,
    type RiskFlag,
    type RoutingDecision,
    type RoutingSignals
} from '../contracts/routing-result.js';

export interface ClassifierTurn {
    role: 'user' | 'assistant' | 'agent' | string;
    text: string;
}

const normalizeText = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim();

const joinedUserText = (turns: readonly ClassifierTurn[], maxTurns = 8): string =>
    turns
        .filter((turn) => turn?.role === 'user')
        .slice(-maxTurns)
        .map((turn) => normalizeText(turn.text))
        .join(' ');

const anyMatch = (patterns: readonly RegExp[], text: string): boolean =>
    patterns.some((pattern) => pattern.test(text));

export class LegacyRulesClassifier {
    readonly source = 'legacy' as const;

    /**
     * Classify the recent user context. Order encodes the same precedence the
     * production prompt enforces: work requests and complaints first, then the
     * non-handoff business buckets, then the representative-request fallback.
     */
    classify(turns: readonly ClassifierTurn[], contextRevision: number): RoutingDecision {
        const text = joinedUserText(turns);
        const risks = new Set<RiskFlag>();
        const signals: RoutingSignals = emptySignals();

        if (!text) {
            return {
                kind: 'uncertain',
                reason: 'insufficient_context',
                signals,
                contextRevision
            };
        }

        // --- risks (independent of intent) ---
        if (anyMatch(EMERGENCY_PATTERNS, text)) risks.add('life_safety_emergency');
        if (anyMatch(CUSTOMER_HARASSMENT_PATTERNS, text)) risks.add('caller_aggression');
        if (anyMatch(COMPLEX_SUPPORT_PATTERNS, text)) risks.add('security_legal');
        if (anyMatch(GENERAL_HANDOFF_PATTERNS, text)) risks.add('urgency');

        // --- intents (multi-label; first entry is primary) ---
        const intents: Intent[] = [];
        const partnershipOrMedia = anyMatch(PARTNERSHIP_AND_MEDIA_PATTERNS, text)
            || anyMatch(EVENT_BUSINESS_PATTERNS, text);
        const sales = anyMatch(SALES_BUSINESS_PATTERNS, text);
        const recruitingApplicant = anyMatch(RECRUITING_APPLICANT_PATTERNS, text);
        const contractRequest = !partnershipOrMedia && anyMatch(CONTRACT_REQUEST_PATTERNS, text);
        const billingComplaint = anyMatch(PAYMENT_DISPUTE_PATTERNS, text)
            || anyMatch(COMPLAINT_PATTERNS, text);
        const existingSupport = anyMatch(COMPLEX_SUPPORT_PATTERNS, text);
        const representativeRequest = anyMatch(REPRESENTATIVE_REQUEST_PATTERNS, text);

        if (contractRequest) intents.push('contract_request');
        if (billingComplaint) intents.push('billing_complaint');
        if (existingSupport) intents.push('existing_support');
        if (sales) intents.push('sales_offer');
        if (recruitingApplicant && !sales) intents.push('recruitment');
        if (partnershipOrMedia) intents.push('partnership_media');

        // Urgency on a non-business context implies an existing-customer
        // support matter (matches the current auto-handoff-general surface).
        if (intents.length === 0 && risks.has('urgency')) {
            intents.push('existing_support');
        }
        if (intents.length === 0 && representativeRequest) {
            intents.push('general_inquiry');
        }
        if (intents.length === 0) {
            intents.push('unknown');
        }

        signals.humanRequested = representativeRequest;
        signals.multipleIntents = intents.filter((intent) => intent !== 'unknown').length > 1;

        return {
            kind: 'known',
            intents,
            risks: [...risks],
            signals,
            source: 'legacy',
            contextRevision
        };
    }
}

/** Convenience wrapper matching the lib function's turn shape. */
export const classifyWithLegacyRules = (
    turns: readonly HandoffTurn[],
    contextRevision: number
): RoutingDecision =>
    new LegacyRulesClassifier().classify(
        turns.map((turn) => ({ role: String(turn?.role || ''), text: String(turn?.text || '') })),
        contextRevision
    );
