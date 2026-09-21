// JevClassifier — optional auxiliary intent classifier.
// Jev never grants transfer authority on its own: it only produces a
// RoutingDecision that RoutingPolicy may or may not act on. A Jev failure is
// 'uncertain', never permission. Confidence values are kept raw — a Choice
// probability is not "the probability this routing decision is right".

import {
    emptySignals,
    isIntent,
    type Intent,
    type RiskFlag,
    type RoutingDecision,
    type RoutingSignals
} from '../contracts/routing-result.js';
import type { ClassifierTurn } from './legacy-classifier.js';

export interface JevQuestionSet {
    /** Question-definition version, recorded for evidence. */
    version: string;
    intentChoiceId: string;
    riskNoulIds: {
        lifeSafetyEmergency: string;
        callerAggression: string;
        thirdPartyThreat: string;
        urgency: string;
    };
    humanRequestedId: string;
}

export const DEFAULT_JEV_QUESTIONS: JevQuestionSet = {
    version: 'jev-questions-0.1',
    intentChoiceId: 'primary_intent',
    riskNoulIds: {
        lifeSafetyEmergency: 'risk_life_safety_emergency',
        callerAggression: 'risk_caller_aggression',
        thirdPartyThreat: 'risk_third_party_threat',
        urgency: 'risk_urgency'
    },
    humanRequestedId: 'signal_human_requested'
};

export interface JevRequest {
    model: string;
    questionVersion: string;
    contextRevision: number;
    /** Sanitized transcript — phone numbers and emails masked. */
    text: string;
}

export interface JevRawResponse {
    intent?: string;
    intentProbabilities?: Record<string, number>;
    risks?: Partial<Record<'life_safety_emergency' | 'caller_aggression' | 'third_party_threat' | 'urgency', number>>;
    humanRequested?: number;
}

export interface JevTransport {
    classify(request: JevRequest, signal: AbortSignal): Promise<JevRawResponse>;
}

/** Transport used when the provider is disabled — always unavailable. */
export class DisabledJevTransport implements JevTransport {
    classify(): Promise<JevRawResponse> {
        return Promise.reject(new Error('jev_disabled'));
    }
}

// REVIEW-R06: full-width Japanese digits/punctuation (０９０－…) must be
// normalized to ASCII BEFORE pattern matching — otherwise the PII boundary
// leaks raw phone numbers to the external Jev API. The +81 branch allows a
// separator between the country code and the subscriber digits.
const PHONE_LIKE_PATTERN = /(?:\+81[\s().ー‐-]*\d[\d\s().ー‐-]{6,}\d|0\d[\d\s().ー‐-]{7,}\d)/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/g;

/** Mask contact details before anything leaves the process. */
export function maskSensitiveText(text: string): string {
    return String(text || '')
        .normalize('NFKC')
        .replace(EMAIL_PATTERN, '<EMAIL>')
        .replace(PHONE_LIKE_PATTERN, '<CALLBACK_PHONE>');
}

const isValidProbability = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const riskThreshold = 0.5;

export interface JevClassifierOptions {
    transport: JevTransport;
    model: string;
    questions?: JevQuestionSet;
    /** Total deadline for the synchronous classify call, AbortSignal-driven. */
    deadlineMs: number;
    policyVersion?: string;
}

export class JevClassifier {
    readonly source = 'jev' as const;
    private readonly questions: JevQuestionSet;

    constructor(private readonly options: JevClassifierOptions) {
        this.questions = options.questions ?? DEFAULT_JEV_QUESTIONS;
    }

    /** Cache key: same call context + same model/question/policy versions. */
    cacheKey(contextRevision: number): string {
        const policyVersion = this.options.policyVersion ?? 'policy-0';
        return `${contextRevision}:${this.options.model}:${this.questions.version}:${policyVersion}`;
    }

    async classify(
        turns: readonly ClassifierTurn[],
        contextRevision: number,
        signal?: AbortSignal
    ): Promise<RoutingDecision> {
        const signals: RoutingSignals = emptySignals();
        const text = maskSensitiveText(
            turns
                .filter((turn) => turn?.role === 'user')
                .slice(-8)
                .map((turn) => turn.text)
                .join(' ')
        );

        if (!text) {
            return { kind: 'uncertain', reason: 'insufficient_context', signals, contextRevision };
        }

        const deadlineSignal = AbortSignal.timeout(this.options.deadlineMs);
        const combined = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;

        let raw: JevRawResponse;
        try {
            raw = await this.options.transport.classify(
                {
                    model: this.options.model,
                    questionVersion: this.questions.version,
                    contextRevision,
                    text
                },
                combined
            );
        } catch (error) {
            const timedOut = error instanceof Error && error.name === 'TimeoutError';
            return {
                kind: 'uncertain',
                reason: timedOut ? 'timeout' : 'unavailable',
                signals,
                contextRevision
            };
        }

        return this.toDecision(raw, contextRevision);
    }

    /**
     * Validate the raw response — unknown labels, out-of-range probabilities
     * and malformed payloads degrade to 'unavailable', they are never coerced.
     */
    toDecision(raw: JevRawResponse, contextRevision: number): RoutingDecision {
        const signals: RoutingSignals = emptySignals();

        if (!raw || typeof raw !== 'object') {
            return { kind: 'uncertain', reason: 'unavailable', signals, contextRevision };
        }

        // humanRequested is independent of the intent label — a bare
        // "let me talk to a person" is ambiguous as a business intent but the
        // signal is still real. Evaluate it before any early return so the
        // uncertain decision carries it.
        if (raw.humanRequested !== undefined) {
            if (!isValidProbability(raw.humanRequested)) {
                return { kind: 'uncertain', reason: 'unavailable', signals, contextRevision };
            }
            signals.humanRequested = raw.humanRequested >= riskThreshold;
        }

        // Risks are evaluated BEFORE the intent early-return: an ambiguous or
        // unknown intent must not discard independent risk evidence (a caller
        // can be hard to classify and still be reporting an emergency). Raw
        // scores are preserved alongside the flags for calibration.
        const risks: RiskFlag[] = [];
        const riskScores: Record<string, number> = {};
        const rawRiskScores = raw.risks ?? {};
        for (const [flag, score] of Object.entries(rawRiskScores)) {
            if (!isValidProbability(score)) {
                return { kind: 'uncertain', reason: 'unavailable', signals, contextRevision };
            }
            riskScores[flag] = score;
            if (score >= riskThreshold) {
                if (flag === 'life_safety_emergency') risks.push('life_safety_emergency');
                else if (flag === 'caller_aggression') risks.push('caller_aggression');
                else if (flag === 'third_party_threat') risks.push('third_party_threat');
                else if (flag === 'urgency') risks.push('urgency');
            }
        }

        // Choice probabilities are calibration metadata — kept separate from
        // Noul risk scores and never used as a production gate on their own.
        const intentProbabilities: Record<string, number> = {};
        if (raw.intentProbabilities) {
            for (const [label, probability] of Object.entries(raw.intentProbabilities)) {
                if (isValidProbability(probability)) intentProbabilities[label] = probability;
            }
        }

        const intents: Intent[] = [];
        if (raw.intent !== undefined) {
            if (!isIntent(raw.intent) || raw.intent === 'unknown') {
                return {
                    kind: 'uncertain',
                    reason: 'ambiguous',
                    signals,
                    contextRevision,
                    risks,
                    riskScores,
                    intentProbabilities
                };
            }
            intents.push(raw.intent);
        }

        if (intents.length === 0) {
            return {
                kind: 'uncertain',
                reason: 'insufficient_context',
                signals,
                contextRevision,
                risks,
                riskScores,
                intentProbabilities
            };
        }

        return {
            kind: 'known',
            intents,
            risks,
            signals,
            source: 'jev',
            contextRevision,
            intentProbabilities,
            riskScores
        };
    }
}
