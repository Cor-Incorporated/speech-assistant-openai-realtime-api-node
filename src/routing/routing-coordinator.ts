// RoutingCoordinator — owns the context revision and the classifier pipeline.
//
// Rules it enforces:
// - every user-side context change (new intent, correction) bumps the
//   revision, so a result computed at an old revision can be identified and
//   discarded rather than applied;
// - Jev only runs when configured, is deadline-bounded, and a late or failed
//   answer never grants authority and never overwrites a newer decision;
// - shadow mode always returns the legacy decision — the Jev answer is
//   recorded for comparison only.

import type { RoutingProvider } from '../config/schema.js';
import type { RoutingDecision } from '../contracts/routing-result.js';
import { JevClassifier } from './jev-classifier.js';
import { LegacyRulesClassifier, type ClassifierTurn } from './legacy-classifier.js';

export interface ShadowRecord {
    contextRevision: number;
    legacy: RoutingDecision;
    jev: RoutingDecision;
    latencyMs: number;
    stale: boolean;
}

export interface RoutingCoordinatorOptions {
    mode: RoutingProvider;
    legacy?: LegacyRulesClassifier;
    jev?: JevClassifier;
    now?: () => number;
}

export class RoutingCoordinator {
    private contextRevision = 0;
    private lastDecision: RoutingDecision | null = null;
    private readonly shadowLog: ShadowRecord[] = [];
    private readonly jevCache = new Map<string, RoutingDecision>();
    private readonly legacy: LegacyRulesClassifier;
    private readonly jev: JevClassifier | null;
    private readonly now: () => number;

    constructor(private readonly options: RoutingCoordinatorOptions) {
        this.legacy = options.legacy ?? new LegacyRulesClassifier();
        this.jev = options.jev ?? null;
        this.now = options.now ?? (() => Date.now());
    }

    get revision(): number {
        return this.contextRevision;
    }

    get decision(): RoutingDecision | null {
        return this.lastDecision;
    }

    get shadowRecords(): readonly ShadowRecord[] {
        return this.shadowLog;
    }

    /** Caller changed intent or corrected content — decisions must recompute. */
    noteContextChanged(): number {
        this.contextRevision += 1;
        return this.contextRevision;
    }

    /**
     * Classify the current context. In 'jev' mode the Jev result is awaited
     * within its deadline; 'jev_shadow' returns legacy immediately and records
     * the Jev answer asynchronously for comparison.
     */
    async classify(turns: readonly ClassifierTurn[]): Promise<RoutingDecision> {
        const revision = this.contextRevision;
        const legacyDecision = this.legacy.classify(turns, revision);

        if (this.options.mode === 'legacy' || !this.jev) {
            this.lastDecision = legacyDecision;
            return legacyDecision;
        }

        if (this.options.mode === 'jev_shadow') {
            this.lastDecision = legacyDecision;
            void this.runShadow(turns, revision, legacyDecision);
            return legacyDecision;
        }

        // mode === 'jev'
        const jevDecision = await this.runJev(turns, revision);
        if (this.contextRevision !== revision) {
            // Context moved on while classifying — the result is stale and
            // must not drive routing, prompts, or commentary.
            return {
                kind: 'uncertain',
                reason: 'ambiguous',
                signals: { humanRequested: false, multipleIntents: false, intentChanged: true },
                contextRevision: this.contextRevision
            };
        }

        const decision = jevDecision.kind === 'uncertain' ? legacyDecision : jevDecision;
        this.lastDecision = decision;
        return decision;
    }

    private async runShadow(
        turns: readonly ClassifierTurn[],
        revision: number,
        legacyDecision: RoutingDecision
    ): Promise<void> {
        const started = this.now();
        const jevDecision = await this.runJev(turns, revision);
        this.shadowLog.push({
            contextRevision: revision,
            legacy: legacyDecision,
            jev: jevDecision,
            latencyMs: this.now() - started,
            stale: this.contextRevision !== revision
        });
    }

    private async runJev(
        turns: readonly ClassifierTurn[],
        revision: number
    ): Promise<RoutingDecision> {
        if (!this.jev) {
            return {
                kind: 'uncertain',
                reason: 'unavailable',
                signals: { humanRequested: false, multipleIntents: false, intentChanged: false },
                contextRevision: revision
            };
        }

        const cacheKey = this.jev.cacheKey(revision);
        const cached = this.jevCache.get(cacheKey);
        if (cached) return cached;

        const decision = await this.jev.classify(turns, revision);
        this.jevCache.set(cacheKey, decision);
        return decision;
    }
}
