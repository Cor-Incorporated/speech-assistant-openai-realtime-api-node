// Domain contracts for call routing. These are the application's own types —
// they are not the provider (Realtime / Live / Jev) wire types.

/**
 * Coarse intent taxonomy proposed for the reception domain.
 * `unknown` means "no reliable intent", not "general inquiry".
 */
export const INTENTS = [
    'contract_request',
    'existing_support',
    'billing_complaint',
    'sales_offer',
    'recruitment',
    'partnership_media',
    'general_inquiry',
    'unknown'
] as const;

export type Intent = (typeof INTENTS)[number];

/**
 * Risk attributes tracked independently of the primary intent.
 * A billing complaint can also carry a security risk; a third-party threat
 * report is not the same as the caller being aggressive.
 */
export const RISK_FLAGS = [
    'life_safety_emergency',
    'security_legal',
    'caller_aggression',
    'third_party_threat',
    'urgency'
] as const;

export type RiskFlag = (typeof RISK_FLAGS)[number];

export interface RoutingSignals {
    /** Caller explicitly asked for a human / representative. */
    humanRequested: boolean;
    /** More than one distinct intent was detected in the same context. */
    multipleIntents: boolean;
    /** The caller changed or withdrew a previously stated intent. */
    intentChanged: boolean;
}

export type ClassifierSource = 'legacy' | 'jev';

export type RoutingDecision =
    | {
          kind: 'known';
          /** Ordered best-first; [0] is the primary intent. */
          intents: Intent[];
          risks: RiskFlag[];
          signals: RoutingSignals;
          source: ClassifierSource;
          contextRevision: number;
      }
    | {
          kind: 'uncertain';
          reason: 'ambiguous' | 'insufficient_context' | 'timeout' | 'unavailable';
          signals: RoutingSignals;
          contextRevision: number;
      };

export const isIntent = (value: unknown): value is Intent =>
    typeof value === 'string' && (INTENTS as readonly string[]).includes(value);

export const isRiskFlag = (value: unknown): value is RiskFlag =>
    typeof value === 'string' && (RISK_FLAGS as readonly string[]).includes(value);

export const emptySignals = (): RoutingSignals => ({
    humanRequested: false,
    multipleIntents: false,
    intentChanged: false
});
