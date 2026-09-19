// Published-only knowledge reader for the voice path.
// Drafts, admin_only items, withdrawn/deleted knowledge, and internal
// annotations can never reach this layer — the release items it reads were
// already whitelisted at publish time. The reader adds revocation-epoch and
// expiry checks on top so a safety withdrawal stops in-flight use too.

import type { KnowledgeRepository } from './repository.js';
import type {
    KnowledgeRelease,
    KnowledgeRuntimeSettings,
    PublishedKnowledgeItem
} from './schemas.js';

export type LookupStatus = 'found' | 'unknown' | 'expired' | 'unavailable';

export interface LookupResultItem {
    knowledgeId: string;
    key: string;
    revision: number;
    answer: string | null;
    value: Record<string, unknown>;
    sourceIds: string[];
    asOf: string | null;
    requiresHumanReview: boolean;
}

export interface LookupResult {
    status: LookupStatus;
    releaseId: string | null;
    /** True when the answer came from a bounded last-known release after a
     * store failure — the caller logs the staleness, never treats it as
     * current. */
    stale: boolean;
    items: LookupResultItem[];
}

export interface KnowledgeReaderOptions {
    /** Max items returned per lookup — the voice path never needs more. */
    maxItems?: number;
    /** Max characters of answer text per item. */
    maxAnswerChars?: number;
    /** How long a cached release may serve after a store failure. */
    maxStaleMs?: number;
    now?: () => number;
}

const nfkc = (value: string): string => value.normalize('NFKC').toLowerCase();

interface CachedRelease {
    releaseId: string;
    manifestHash: string;
    items: PublishedKnowledgeItem[];
    loadedAt: number;
}

/**
 * Reads the current release manifest once and caches it. Every lookup still
 * re-checks runtimeSettings so a new release or a revocation-epoch bump on
 * another instance takes effect without a restart.
 */
export class KnowledgeReader {
    private cache: CachedRelease | null = null;
    private cacheEpoch = -1;
    private lastGood: CachedRelease | null = null;
    private readonly maxItems: number;
    private readonly maxAnswerChars: number;
    private readonly maxStaleMs: number;
    private readonly now: () => number;

    constructor(
        private readonly repo: KnowledgeRepository,
        options: KnowledgeReaderOptions = {}
    ) {
        this.maxItems = options.maxItems ?? 3;
        this.maxAnswerChars = options.maxAnswerChars ?? 400;
        this.maxStaleMs = options.maxStaleMs ?? 5 * 60 * 1000;
        this.now = options.now ?? Date.now;
    }

    /** The release a new call pins to — logged on the call record so the UI
     * can show which version answered. */
    async currentReleaseId(): Promise<string | null> {
        const settings = await this.repo.getRuntimeSettings();
        return settings.currentReleaseId;
    }

    async lookup(query: string): Promise<LookupResult> {
        const loaded = await this.loadCurrent();
        if (loaded.status !== 'ok') {
            return { status: loaded.status, releaseId: loaded.releaseId, stale: loaded.stale, items: [] };
        }
        const { cache, settings, stale } = loaded;

        const normalized = nfkc(String(query ?? '')).trim();
        if (!normalized) {
            return { status: 'unknown', releaseId: cache.releaseId, stale, items: [] };
        }
        const nowIso = new Date(this.now()).toISOString();
        const revoked = new Set(settings.revokedKnowledgeIds);

        const candidates = cache.items.filter((item) => {
            if (revoked.has(item.knowledgeId)) return false;
            if (item.expiresAt && nowIso > item.expiresAt) return false;
            return true;
        });

        const matched = candidates
            .map((item) => ({ item, score: scoreItem(item, normalized) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score || a.item.knowledgeId.localeCompare(b.item.knowledgeId))
            .slice(0, this.maxItems);

        if (matched.length === 0) {
            return { status: 'unknown', releaseId: cache.releaseId, stale, items: [] };
        }

        return {
            status: 'found',
            releaseId: cache.releaseId,
            stale,
            items: matched.map(({ item }) => ({
                knowledgeId: item.knowledgeId,
                key: item.key,
                revision: item.revision,
                answer: item.answerJa ? item.answerJa.slice(0, this.maxAnswerChars) : null,
                value: item.value,
                sourceIds: item.sourceIds,
                asOf: item.asOf,
                requiresHumanReview: item.requiresHumanReview
            }))
        };
    }

    private async loadCurrent(): Promise<
        | { status: 'ok'; cache: CachedRelease; settings: KnowledgeRuntimeSettings; stale: boolean }
        | { status: LookupStatus; releaseId: string | null; stale: boolean }
    > {
        let settings: KnowledgeRuntimeSettings;
        try {
            settings = await this.repo.getRuntimeSettings();
        } catch {
            // Store unreachable — serve a bounded last-known release if one
            // was loaded recently; otherwise the answer is unavailable, not
            // "no information". The result is marked stale so callers log it.
            const stale = this.staleCandidate();
            if (stale) {
                return {
                    status: 'ok',
                    cache: stale,
                    settings: {
                        currentReleaseId: stale.releaseId,
                        revocationEpoch: this.cacheEpoch,
                        revokedKnowledgeIds: [],
                        updatedAt: ''
                    },
                    stale: true
                };
            }
            return { status: 'unavailable', releaseId: null, stale: false };
        }

        if (!settings.currentReleaseId) {
            return { status: 'unavailable', releaseId: null, stale: false };
        }

        if (this.cache && this.cache.releaseId === settings.currentReleaseId) {
            this.cacheEpoch = settings.revocationEpoch;
            return { status: 'ok', cache: this.cache, settings, stale: false };
        }

        let release: KnowledgeRelease | null;
        let items: PublishedKnowledgeItem[];
        try {
            release = await this.repo.getRelease(settings.currentReleaseId);
            if (!release) {
                return { status: 'unavailable', releaseId: settings.currentReleaseId, stale: false };
            }
            items = await this.repo.getReleaseItems(release.releaseId);
        } catch {
            const stale = this.staleCandidate();
            if (stale) {
                return { status: 'ok', cache: stale, settings, stale: true };
            }
            return { status: 'unavailable', releaseId: settings.currentReleaseId, stale: false };
        }

        this.cache = {
            releaseId: release.releaseId,
            manifestHash: release.manifestHash,
            items,
            loadedAt: this.now()
        };
        this.cacheEpoch = settings.revocationEpoch;
        this.lastGood = this.cache;
        return { status: 'ok', cache: this.cache, settings, stale: false };
    }

    /** A previously loaded release may serve for a bounded window after a
     * store failure — beyond that the knowledge path degrades to
     * unavailable rather than answering from an arbitrarily old version. */
    private staleCandidate(): CachedRelease | null {
        if (!this.lastGood) return null;
        return this.now() - this.lastGood.loadedAt <= this.maxStaleMs ? this.lastGood : null;
    }
}

/** Deterministic small-scale scoring over the whitelisted snapshot —
 * key/category/keyword/title/answer/value text. No embeddings, no external
 * calls, and query text is never executed as anything but a string. */
function scoreItem(item: PublishedKnowledgeItem, normalizedQuery: string): number {
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return 0;

    let score = 0;
    const key = nfkc(item.key);
    const title = nfkc(item.title);
    const category = nfkc(item.category);
    const keywords = item.keywords.map(nfkc);
    const answer = nfkc(item.answerJa ?? '');
    const valueText = nfkc(JSON.stringify(item.value));

    for (const term of terms) {
        if (key === term || key.includes(term)) score += 6;
        if (keywords.some((k) => k === term)) score += 5;
        if (keywords.some((k) => k.includes(term) || term.includes(k))) score += 3;
        if (title.includes(term)) score += 3;
        if (category === term) score += 2;
        if (answer.includes(term)) score += 1;
        if (valueText.includes(term)) score += 1;
    }
    // Whole-phrase hit beats scattered term hits.
    if (answer.includes(normalizedQuery) || title.includes(normalizedQuery)) score += 4;
    if (key === normalizedQuery) score += 8;
    return score;
}
