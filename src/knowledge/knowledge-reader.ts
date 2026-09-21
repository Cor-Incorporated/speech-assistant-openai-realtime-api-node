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
    // REVIEW-R04: the revoked set must survive a settings-read failure —
    // serving a last-known release with an EMPTY revoked list resurrects
    // withdrawn knowledge during the outage.
    private lastKnownRevokedIds: readonly string[] = [];
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

        // RECHECK-RR06 / ACCEPT-T04: an unmatched entity term (a
        // katakana/roman product name the caller named but we know nothing
        // about) must not be answered from a generic sibling item — say
        // unknown so the voice layer asks for clarification instead of
        // quoting the wrong price.
        const entities = analyzeEntityTerms(normalized, candidates);
        if (entities.unknownTerm) {
            return { status: 'unknown', releaseId: cache.releaseId, stale, items: [] };
        }

        let matched = candidates
            .map((item) => ({ item, score: scoreItem(item, normalized) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score || a.item.knowledgeId.localeCompare(b.item.knowledgeId));

        // A named product that IS known restricts the answer to that
        // product's items — generic pricing must not leak into a
        // product-specific question (「グリフト月額料金」).
        if (entities.constraints.length > 0) {
            matched = matched.filter(({ item }) =>
                entities.constraints.every((variants) =>
                    variants.some((v) => itemHaystack(item).includes(v))));
        }

        matched = matched.slice(0, this.maxItems);

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
                        revokedKnowledgeIds: [...this.lastKnownRevokedIds],
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
            this.lastKnownRevokedIds = settings.revokedKnowledgeIds;
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
        this.lastKnownRevokedIds = settings.revokedKnowledgeIds;
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

// REVIEW-R07: natural Japanese questions must retrieve the same items as
// bare keyword queries. Whitespace splitting alone turns
// 「御社の住所を教えてください」 into one giant term that matches nothing —
// the query is segmented on particles/politeness markers, expanded through
// a synonym table, and scored per conceptual term (max, not sum) with a
// CJK-bigram coverage bonus.

/** Particles, politeness forms, and interrogatives that carry no retrieval
 * signal — splitting on them yields content-bearing segments. */
const SEGMENT_SPLIT =
    /[\s、。？！?!…・「」『』（）()：:]+|ください|下さい|教えて|おしえて|お願いします|お願い|でしょうか|ですか|いただき|たい|です|ます|を|が|は|の|に|へ|で|と|も|から|まで|より|ね|よ|な|か/g;

/** Synonym groups — a segment matching any member is expanded to the whole
 * group so 代表者/代表取締役/社長 retrieve the same item. */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
    ['代表取締役', '代表者', '代表', '社長', 'ceo'],
    ['住所', '所在地', '本社', '本社所在地', 'アクセス', '場所', '地図'],
    ['営業時間', '受付時間', '営業日', '定休日', '休業日', '開店', '閉店', '何時'],
    ['料金', '価格', '費用', '値段', '金額', 'いくら', 'プラン'],
    ['電話番号', '連絡先', '電話', 'fax', '問い合わせ先'],
    ['会社名', '社名', '名称', '会社概要'],
    ['設立', '創業', '設立年月日'],
    ['事業内容', '事業', 'サービス', '業務内容', '仕事内容'],
    ['会社', '御社', '貴社', 'そちら', 'cor'],
    ['メールアドレス', 'メール', 'mail', 'eメール'],
    ['担当者', '担当', 'スタッフ', 'オペレーター'],
    ['採用', '求人', '採用情報', '募集'],
    ['名前', '氏名', 'お名前'],
    ['資本金', '資本'],
    ['決算', '決算期', '決算月'],
    // Product names: speech recognition renders "Grift" as katakana —
    // both surface forms must resolve to the same published items.
    ['grift', 'グリフト']
];

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uFF66-\uFF9F]/;

/** Split a normalized query into content segments (≥2 chars, or a single
 * latin/digit run) with particles and politeness forms removed. */
function querySegments(normalizedQuery: string): string[] {
    return normalizedQuery
        .split(SEGMENT_SPLIT)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 || /^[a-z0-9]/.test(s));
}

/** Expand each segment into a synonym group — one conceptual term, one
 * score. A segment that contains a member (代表取締役 ⊃ 代表) joins the group. */
function termGroups(segments: string[]): string[][] {
    return segments.map((segment) => {
        for (const group of SYNONYM_GROUPS) {
            if (group.some((member) => segment === member
                || (member.length >= 2 && segment.includes(member))
                || (segment.length >= 2 && member.includes(segment)))) {
                return [...group];
            }
        }
        return [segment];
    });
}

function cjkBigrams(text: string): Set<string> {
    const grams = new Set<string>();
    let run = '';
    const flush = () => {
        for (let i = 0; i + 1 < run.length; i += 1) grams.add(run.slice(i, i + 2));
        if (run.length === 2) grams.add(run);
        run = '';
    };
    for (const ch of text) {
        if (CJK_CHAR.test(ch)) run += ch;
        else flush();
    }
    flush();
    return grams;
}

// A katakana word or roman token that matches NO published item is most
// likely a product/service name the caller misheard or misremembered —
// answering from a generic item would attribute another service's facts to
// it (RECHECK-RR06: "ブリストの料金" must not return generic pricing).
//
// ACCEPT-T04: entity runs are extracted from INSIDE compound segments too —
// 「ブリスト料金」「商品アオゾラ」 still name an unknown product even though
// the whole segment is not entity-shaped (K03/K04). Pure digits are not
// entity names (years, amounts, phone fragments stay retrievable).
const ENTITY_RUN_PATTERN = /[ァ-ヶー]{2,}|[a-z][a-z0-9.-]*/g;

const itemHaystack = (item: PublishedKnowledgeItem): string =>
    nfkc(`${item.key} ${item.title} ${item.category} ${item.keywords.join(' ')} ${item.answerJa ?? ''} ${JSON.stringify(item.value)}`);

const synonymGroupFor = (term: string): readonly string[] | null =>
    SYNONYM_GROUPS.find((group) => group.some((member) =>
        term === member
        || (member.length >= 2 && term.includes(member))
        || (term.length >= 2 && member.includes(term)))) ?? null;

interface EntityAnalysis {
    /** A product-like token no published item knows — answer 'unknown'. */
    unknownTerm: string | null;
    /** Product entities identified in the query (e.g. Grift) — matched
     * items must be about THIS entity, not a generic sibling
     * (「グリフト月額料金」 returns Grift items only). */
    constraints: string[][];
}

/** Detect unknown product names and pin down known ones. The key's first
 * segment (grift.*, service.*, ...) doubles as the entity namespace — a
 * query naming a known product constrains answers to that product. */
function analyzeEntityTerms(
    normalizedQuery: string,
    candidates: PublishedKnowledgeItem[]
): EntityAnalysis {
    const constraints: string[][] = [];
    const keyPrefixes = new Set(candidates.map((item) => nfkc(item.key).split('.')[0]));
    for (const segment of querySegments(normalizedQuery)) {
        for (const match of segment.matchAll(ENTITY_RUN_PATTERN)) {
            const run = match[0];
            const group = synonymGroupFor(run);
            const variants = group ? [...group] : [run];
            const appearsInItems = candidates.some((item) =>
                variants.some((v) => itemHaystack(item).includes(v)));
            if (!appearsInItems) {
                // A run that is itself a generic synonym member (サービス,
                // プラン) is ordinary vocabulary, not a product name —
                // only non-member runs gate on item coverage.
                if (group) continue;
                return { unknownTerm: run, constraints };
            }
            if (variants.some((v) => keyPrefixes.has(v))) {
                constraints.push(variants);
            }
        }
    }
    return { unknownTerm: null, constraints };
}

/** Deterministic small-scale scoring over the whitelisted snapshot —
 * key/category/keyword/title/answer/value text. No embeddings, no external
 * calls, and query text is never executed as anything but a string. */
function scoreItem(item: PublishedKnowledgeItem, normalizedQuery: string): number {
    const segments = querySegments(normalizedQuery);
    const groups = termGroups(segments);
    if (groups.length === 0) return 0;

    const key = nfkc(item.key);
    const title = nfkc(item.title);
    const category = nfkc(item.category);
    const keywords = item.keywords.map(nfkc);
    const answer = nfkc(item.answerJa ?? '');
    const valueText = nfkc(JSON.stringify(item.value));

    let score = 0;
    let matchedGroups = 0;
    for (const group of groups) {
        // A conceptual term scores once — its best field across all synonyms.
        let groupScore = 0;
        for (const term of group) {
            let termScore = 0;
            if (key === term) termScore = 8;
            else if (key.length >= 2 && (key.includes(term) || term.includes(key))) termScore = 6;
            if (keywords.some((k) => k === term)) termScore = Math.max(termScore, 6);
            if (keywords.some((k) => k.length >= 2 && (k.includes(term) || term.includes(k)))) {
                termScore = Math.max(termScore, 4);
            }
            if (title === term) termScore = Math.max(termScore, 5);
            else if (title.includes(term) || (term.length >= 2 && term.includes(title))) {
                termScore = Math.max(termScore, 3);
            }
            if (category === term) termScore = Math.max(termScore, 2);
            if (answer.includes(term)) termScore = Math.max(termScore, 1);
            if (valueText.includes(term)) termScore = Math.max(termScore, 1);
            groupScore = Math.max(groupScore, termScore);
        }
        score += groupScore;
        if (groupScore > 0) matchedGroups += 1;
    }

    // Coverage bonus: fraction of the query's content CJK bigrams the item
    // reproduces — catches 代表者-of-代表取締役 style near misses without
    // letting particle noise inflate unrelated items.
    const queryGrams = new Set<string>();
    for (const segment of segments) {
        for (const g of cjkBigrams(segment)) queryGrams.add(g);
    }
    if (queryGrams.size > 0 && matchedGroups > 0) {
        const haystack = `${key} ${title} ${category} ${keywords.join(' ')} ${answer} ${valueText}`;
        const itemGrams = cjkBigrams(haystack);
        let covered = 0;
        for (const g of queryGrams) if (itemGrams.has(g)) covered += 1;
        score += Math.round(4 * (covered / queryGrams.size));
    }

    // Whole-phrase hit beats scattered term hits.
    if (answer.includes(normalizedQuery) || title.includes(normalizedQuery)) score += 4;
    if (key === normalizedQuery) score += 8;
    return score;
}
