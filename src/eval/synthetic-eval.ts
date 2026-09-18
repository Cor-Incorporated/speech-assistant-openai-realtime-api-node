// Synthetic seed evaluation harness.
// The seed is a *design* artifact: `proposed_expectations` are assertions to
// check, not approved gold labels. This harness reports the current rules'
// output next to the proposed labels — the three columns (current output /
// proposed label / applied policy) stay separate on purpose.

import { readFile } from 'node:fs/promises';
import { LegacyRulesClassifier } from '../routing/legacy-classifier.js';
import {
    evaluateModelEscalation,
    evaluateTransferRequest,
    DEFAULT_POLICY_FLAGS,
    type RoutingPolicyFlags
} from '../domain/routing-policy.js';
import type { HandoffDestination } from '../contracts/tool-arguments.js';
import type { RoutingDecision } from '../contracts/routing-result.js';

export interface EvalTurn {
    role: string;
    text: string;
}

export interface EvalCase {
    id: string;
    kind: 'semantic' | 'fault_injection';
    name: string;
    turns?: EvalTurn[];
    event_sequence?: unknown[];
    context?: Record<string, unknown>;
    proposed_expectations?: {
        semantic_intents?: string[];
        assertions?: string[];
    };
}

export interface SemanticCaseResult {
    id: string;
    name: string;
    /** What the current regex rules produce. */
    currentIntents: string[];
    currentRisks: string[];
    /** The seed's proposed label — not an approved gold. */
    proposedIntents: string[];
    /** Set-equality between current output and proposed label. */
    matchesProposal: boolean;
    /** Transfer surface under the applied policy flags. */
    policy: {
        contract: string;
        general: string;
        escalation: string;
    };
    assertions: string[];
}

export interface FaultCaseResult {
    id: string;
    name: string;
    /** Fault cases are asserted by dedicated unit tests — the harness links
     *  each case to its coverage point rather than re-executing it here. */
    eventSequence: unknown[];
    assertions: string[];
    coverage: string;
}

export interface EvalReport {
    generatedAt: string;
    source: string;
    split: string;
    totals: {
        semantic: number;
        fault: number;
        semanticMatchingProposal: number;
    };
    semanticResults: SemanticCaseResult[];
    faultResults: FaultCaseResult[];
    notes: string[];
}

const FAULT_COVERAGE: Record<string, string> = {
    'FAULT-001': 'test/playback-controller.test.js',
    'FAULT-002': 'test/reception-state.test.js + test/playback-controller.test.js',
    'FAULT-003': 'test/routing-coordinator.test.js',
    'FAULT-004': 'test/routing-coordinator.test.js + test/jev-classifier.test.js',
    'FAULT-005': 'test/jev-classifier.test.js + test/routing-coordinator.test.js',
    'FAULT-006': 'test/tool-arguments.test.js',
    'FAULT-007': 'test/tool-arguments.test.js + test/routing-policy.test.js + test/action-gate.test.js',
    'FAULT-008': 'test/action-ledger.test.js + test/action-gate.test.js',
    'FAULT-009': 'test/action-ledger.test.js',
    'FAULT-010': 'test/live-adapter.test.js',
    'FAULT-011': 'test/voice-events.test.js (delegation contract)',
    'FAULT-012': 'test/reception-state.test.js + test/action-gate.test.js'
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseEvalCase(line: string): EvalCase | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') return null;
    return parsed as unknown as EvalCase;
}

export async function loadEvalCases(path: string): Promise<EvalCase[]> {
    const raw = await readFile(path, 'utf8');
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseEvalCase)
        .filter((item): item is EvalCase => item !== null);
}

const verdict = (result: { allowed: boolean; reason?: string; destination?: HandoffDestination }): string =>
    result.allowed ? `allow:${result.destination}` : `deny:${result.reason}`;

/**
 * Eval transfer surface: handoff is assumed deployed so the semantic deny
 * reasons (emergency_services, non_handoff_business_call, ...) stay visible.
 * Deployment availability is a separate gate — evaluateTransferRequest already
 * models it via the flags, so callers can pass stricter flags explicitly.
 */
export const EVAL_SURFACE_FLAGS: RoutingPolicyFlags = {
    ...DEFAULT_POLICY_FLAGS,
    handoffEnabled: true,
    handoffNumbersConfigured: true
};

export function runSemanticCase(
    evalCase: EvalCase,
    classifier: LegacyRulesClassifier,
    flags: RoutingPolicyFlags = EVAL_SURFACE_FLAGS
): SemanticCaseResult {
    const turns = (evalCase.turns ?? []).map((turn) => ({ role: turn.role, text: turn.text }));
    const decision: RoutingDecision = classifier.classify(turns, 0);

    const currentIntents = decision.kind === 'known' ? decision.intents : ['uncertain'];
    const currentRisks = decision.kind === 'known' ? decision.risks : [];
    const proposed = evalCase.proposed_expectations?.semantic_intents ?? [];

    const matchesProposal =
        proposed.length > 0
        && currentIntents.length === proposed.length
        && currentIntents.every((intent) => proposed.includes(intent));

    const contractVerdict = evaluateTransferRequest('contract', decision, flags);
    const generalVerdict = evaluateTransferRequest('general', decision, flags);
    const escalation = evaluateModelEscalation(decision);

    return {
        id: evalCase.id,
        name: evalCase.name,
        currentIntents,
        currentRisks,
        proposedIntents: proposed,
        matchesProposal,
        policy: {
            contract: verdict(contractVerdict),
            general: verdict(generalVerdict),
            escalation: `${escalation.tier}:${escalation.category}`
        },
        assertions: evalCase.proposed_expectations?.assertions ?? []
    };
}

export function runEval(cases: EvalCase[], source: string): EvalReport {
    const classifier = new LegacyRulesClassifier();
    const semanticResults: SemanticCaseResult[] = [];
    const faultResults: FaultCaseResult[] = [];

    for (const evalCase of cases) {
        if (evalCase.kind === 'semantic') {
            semanticResults.push(runSemanticCase(evalCase, classifier, EVAL_SURFACE_FLAGS));
        } else if (evalCase.kind === 'fault_injection') {
            faultResults.push({
                id: evalCase.id,
                name: evalCase.name,
                eventSequence: evalCase.event_sequence ?? [],
                assertions: evalCase.proposed_expectations?.assertions ?? [],
                coverage: FAULT_COVERAGE[evalCase.id] ?? 'not_mapped'
            });
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        source,
        split: 'design_seed_not_holdout',
        totals: {
            semantic: semanticResults.length,
            fault: faultResults.length,
            semanticMatchingProposal: semanticResults.filter((result) => result.matchesProposal).length
        },
        semanticResults,
        faultResults,
        notes: [
            'proposed_intents は承認済みgoldではなく設計seedの提案ラベル。',
            '不一致は現行regexの限界または提案の誤りのどちらでもありうる。判定差分だけでpolicy変更の承認を意味しない。',
            'faultケースはユニットテストで検査する（coverage列参照）。'
        ]
    };
}
