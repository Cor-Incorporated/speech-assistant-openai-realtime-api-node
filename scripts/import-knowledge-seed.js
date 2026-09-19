// Cor. knowledge seed importer — cor-seed-v1 manifest → Firestore.
//
// Safety contract (from the instruction bundle):
//   * dry-run is the DEFAULT — `--execute` is required for any write
//   * create-only — existing documents are never overwritten; identical
//     content is skipped, different content is reported as a conflict
//   * collection whitelist — callLogs / runtimeSettings / anything outside
//     the manifest's allowed_collections is refused outright
//   * no publication — every imported item stays `draft`; nothing touches
//     currentReleaseId or runtime settings
//   * explicit environment — --execute requires --project AND --database;
//     the script never guesses a target from ambient gcloud config
//   * synthetic calls are never imported anywhere
//
// Usage:
//   node scripts/import-knowledge-seed.js --manifest <path>                    # dry-run (no DB needed with --repository memory)
//   node scripts/import-knowledge-seed.js --manifest <path> --repository firestore --project P --database D   # dry-run vs real store
//   node scripts/import-knowledge-seed.js --manifest <path> --execute --project P --database D               # create-only import

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    seedItemToDraft,
    seedReviewToRecord,
    seedSourceToRecord,
    KNOWLEDGE_SCHEMA_VERSION,
    knowledgeContentHash
} from '../dist-backend/knowledge/schemas.js';

const APPLICATION_FORMAT = 'cor-seed-v1';
const COLLECTION_WHITELIST = new Set([
    'corKnowledgeSources',
    'corKnowledge',
    'corKnowledgeReviews',
    'receptionPolicies'
]);
const FORBIDDEN_COLLECTIONS = new Set(['callLogs', 'runtimeSettings', 'adminAuditEvents']);

const canonicalJson = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

const hashOf = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const parseArgs = (argv) => {
    const args = { repository: 'memory', execute: false, manifest: '', project: '', database: '' };
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        if (flag === '--execute') args.execute = true;
        else if (flag === '--manifest') args.manifest = argv[++i] ?? '';
        else if (flag === '--repository') args.repository = argv[++i] ?? 'memory';
        else if (flag === '--project') args.project = argv[++i] ?? '';
        else if (flag === '--database') args.database = argv[++i] ?? '';
        else if (flag === '--imported-by') args.importedBy = argv[++i] ?? 'seed-importer';
        else throw new Error(`unknown argument: ${flag}`);
    }
    return args;
};

// ---------------------------------------------------------------------------
// Record conversion — manifest → stored docs. Every converter is pure and
// deterministic so a re-run produces byte-identical content for comparison.
// ---------------------------------------------------------------------------

const buildKnowledgeRoot = (data, meta) => ({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    knowledgeId: data.knowledgeId,
    key: data.key,
    title: '',
    category: 'company',
    locale: 'ja-JP',
    keywords: [],
    audience: 'public',
    handling: 'answer_after_approval',
    riskLevel: 'normal',
    state: 'draft',
    draftRevision: data.draftRevision ?? 1,
    publishedRevision: null,
    recordVersion: data.recordVersion ?? 1,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    createdAt: meta.now,
    createdBy: meta.actor,
    updatedAt: meta.now,
    updatedBy: meta.actor
});

const buildRevisionDoc = (knowledgeId, childData, meta) => {
    const converted = seedItemToDraft(childData);
    if (!converted.ok) {
        return { error: converted.issues.map((i) => `${i.field}: ${i.message}`).join('; ') };
    }
    const { revision, contentHash, draft } = converted.value;
    const sourceIds = draft.sourceRefs.map((ref) => ref.sourceId);
    const computed = knowledgeContentHash({
        key: draft.key,
        value: draft.value,
        answerJa: draft.answerJa,
        answerType: draft.answerType,
        evidenceState: draft.evidenceState,
        sourceIds,
        asOf: draft.asOf,
        validity: draft.validity
    });
    return {
        doc: {
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            revision,
            // The canonical content hash is ours — approvals and release
            // manifests bind to this. The seed's own hash is preserved for
            // provenance comparison only.
            contentHash: computed,
            seedContentHash: childData.content_hash ?? null,
            seedContentHashMatches: computed === contentHash,
            value: draft.value,
            answerJa: draft.answerJa,
            answerType: draft.answerType,
            evidenceState: draft.evidenceState,
            sourceRefs: draft.sourceRefs,
            asOf: draft.asOf,
            checkedOn: draft.checkedOn,
            validity: draft.validity,
            approval: { approvedBy: null, approvedAt: null, reason: null, revision: null, contentHash: null },
            operatorNote: draft.operatorNote,
            reviewQuestion: draft.reviewQuestion,
            synthetic: converted.value.synthetic,
            title: draft.title,
            category: draft.category,
            keywords: draft.keywords,
            audience: draft.audience,
            handling: draft.handling,
            riskLevel: draft.riskLevel,
            createdAt: meta.now,
            createdBy: meta.actor
        },
        // Root metadata comes from the revision content (title/category/…)
        rootPatch: {
            title: draft.title,
            category: draft.category,
            locale: draft.locale,
            keywords: draft.keywords,
            audience: draft.audience,
            handling: draft.handling,
            riskLevel: draft.riskLevel
        }
    };
};

// ---------------------------------------------------------------------------
// Plan building — pure: manifest + existing docs → per-record actions
// ---------------------------------------------------------------------------

const planRecord = async (record, meta, store) => {
    const { collection, document_id: docId, data } = record;
    if (FORBIDDEN_COLLECTIONS.has(collection)) {
        return { collection, docId, action: 'refused', reason: 'forbidden_collection' };
    }
    if (!COLLECTION_WHITELIST.has(collection)) {
        return { collection, docId, action: 'refused', reason: 'not_in_whitelist' };
    }

    if (collection === 'corKnowledgeSources') {
        const converted = seedSourceToRecord(data, { createdBy: meta.actor, createdAt: meta.now });
        if (!converted.ok) {
            return { collection, docId, action: 'invalid', reason: converted.issues.map((i) => `${i.field}: ${i.message}`).join('; ') };
        }
        const existing = await store.getDoc(collection, docId);
        if (!existing) {
            return { collection, docId, action: 'create', doc: converted.value };
        }
        return compareAndReport(collection, docId, existing, converted.value);
    }

    if (collection === 'corKnowledgeReviews') {
        const converted = seedReviewToRecord(data, { createdAt: meta.now });
        if (!converted.ok) {
            return { collection, docId, action: 'invalid', reason: converted.issues.map((i) => `${i.field}: ${i.message}`).join('; ') };
        }
        const existing = await store.getDoc(collection, docId);
        if (!existing) {
            return { collection, docId, action: 'create', doc: converted.value };
        }
        return compareAndReport(collection, docId, existing, converted.value);
    }

    if (collection === 'receptionPolicies') {
        // Proposals only — never enabled, never published on import.
        const doc = {
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            ...data,
            enabled: false,
            publication_state: 'draft',
            createdAt: meta.now,
            createdBy: meta.actor
        };
        const existing = await store.getDoc(collection, docId);
        if (!existing) {
            return { collection, docId, action: 'create', doc };
        }
        return compareAndReport(collection, docId, existing, doc);
    }

    if (collection === 'corKnowledge') {
        const children = Array.isArray(record.children) ? record.children : [];
        const revisionChild = children.find((c) => c.collection === 'revisions');
        if (!revisionChild) {
            return { collection, docId, action: 'invalid', reason: 'missing revisions child' };
        }
        const built = buildRevisionDoc(docId, revisionChild.data, meta);
        if (built.error) {
            return { collection, docId, action: 'invalid', reason: built.error };
        }
        const root = { ...buildKnowledgeRoot(data, meta), ...built.rootPatch };
        const existingRoot = await store.getDoc(collection, docId);
        const existingRevision = await store.getDoc(`${collection}/${docId}/revisions`, String(built.doc.revision));
        const plan = { collection, docId, actions: [] };
        if (!existingRoot) {
            plan.actions.push({ kind: 'create', path: `${collection}/${docId}`, doc: root });
        } else {
            const same = hashOf(stripMetadata(existingRoot)) === hashOf(stripMetadata(root));
            if (!same) {
                plan.actions.push({ kind: 'conflict', path: `${collection}/${docId}`, reason: 'root content differs' });
            }
        }
        if (!existingRevision) {
            plan.actions.push({ kind: 'create', path: `${collection}/${docId}/revisions/${built.doc.revision}`, doc: built.doc });
        } else {
            const same = existingRevision.contentHash === built.doc.contentHash;
            if (!same) {
                plan.actions.push({ kind: 'conflict', path: `${collection}/${docId}/revisions/${built.doc.revision}`, reason: 'content hash differs' });
            }
        }
        if (plan.actions.length === 0) {
            return { collection, docId, action: 'skip', reason: 'identical content' };
        }
        if (plan.actions.every((a) => a.kind === 'conflict')) {
            return { collection, docId, action: 'conflict', reason: plan.actions.map((a) => a.reason).join('; ') };
        }
        return { collection, docId, action: 'create', plan: plan.actions, note: 'root+revision' };
    }

    return { collection, docId, action: 'refused', reason: 'unhandled_collection' };
};

const METADATA_FIELDS = new Set(['schemaVersion', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
const stripMetadata = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !METADATA_FIELDS.has(k)));

const compareAndReport = (collection, docId, existing, incoming) => {
    const same = hashOf(stripMetadata(existing)) === hashOf(stripMetadata(incoming));
    return same
        ? { collection, docId, action: 'skip', reason: 'identical content' }
        : { collection, docId, action: 'conflict', reason: 'stored content differs from seed' };
};

// ---------------------------------------------------------------------------
// Store adapters — memory (no DB) and Firestore (emulator or named database)
// ---------------------------------------------------------------------------

const memoryStore = () => ({
    async getDoc() {
        return null;
    },
    async commit() {
        return { written: 0 };
    }
});

const firestoreStore = async ({ project, database }) => {
    const { Firestore } = await import('@google-cloud/firestore');
    const db = new Firestore({ projectId: project, databaseId: database });
    return {
        async getDoc(collection, docId) {
            const doc = await db.doc(`${collection}/${docId}`).get();
            return doc.exists ? doc.data() : null;
        },
        async commit(writes) {
            let written = 0;
            let batch = db.batch();
            let pending = 0;
            for (const { path, doc } of writes) {
                batch.create(db.doc(path), doc);
                pending += 1;
                if (pending === 400) {
                    await batch.commit();
                    batch = db.batch();
                    pending = 0;
                }
            }
            if (pending > 0) await batch.commit();
            written += writes.length;
            return { written };
        }
    };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.manifest) {
        console.error('usage: import-knowledge-seed.js --manifest <path> [--repository firestore --project P --database D] [--execute]');
        process.exit(2);
    }
    if (args.execute && (!args.project || !args.database)) {
        console.error('refusing to execute: --execute requires explicit --project and --database');
        process.exit(2);
    }
    if (args.execute) args.repository = 'firestore';

    const manifestPath = resolve(args.manifest);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.application_format !== APPLICATION_FORMAT && manifest.application_format !== `${APPLICATION_FORMAT} (not Firestore managed export)`) {
        console.error(`refusing: application_format "${manifest.application_format}" is not ${APPLICATION_FORMAT}`);
        process.exit(2);
    }
    const allowed = new Set(manifest.allowed_collections ?? []);
    for (const collection of allowed) {
        if (!COLLECTION_WHITELIST.has(collection)) {
            console.error(`refusing: manifest allows collection "${collection}" outside the importer whitelist`);
            process.exit(2);
        }
    }

    const records = (manifest.records ?? []).filter((r) => allowed.has(r.collection));
    const meta = { now: new Date().toISOString(), actor: args.importedBy ?? 'seed-importer' };
    const store = args.repository === 'firestore'
        ? await firestoreStore({ project: args.project, database: args.database })
        : memoryStore();

    const plans = [];
    for (const record of records) {
        plans.push(await planRecord(record, meta, store));
    }

    const summary = { create: 0, skip: 0, conflict: 0, invalid: 0, refused: 0 };
    const writes = [];
    for (const plan of plans) {
        summary[plan.action] = (summary[plan.action] ?? 0) + 1;
        if (plan.action === 'create') {
            if (plan.plan) {
                for (const step of plan.plan) {
                    if (step.kind === 'create') writes.push({ path: step.path, doc: step.doc });
                    else if (step.kind === 'conflict') {
                        summary.conflict += 1;
                        console.log(`conflict ${step.path}: ${step.reason}`);
                    }
                }
            } else if (plan.doc) {
                writes.push({ path: `${plan.collection}/${plan.docId}`, doc: plan.doc });
            }
        } else if (plan.action === 'conflict' || plan.action === 'invalid' || plan.action === 'refused') {
            console.log(`${plan.action} ${plan.collection}/${plan.docId}: ${plan.reason}`);
        }
    }

    const mode = args.execute ? 'EXECUTE' : 'DRY-RUN';
    console.log(JSON.stringify({
        mode,
        target: args.repository === 'firestore' ? { project: args.project, database: args.database } : 'memory',
        records: records.length,
        ...summary,
        writes: args.execute ? 'committing' : writes.length,
        publication: 'all items remain draft — no release, no runtimeSettings change'
    }, null, 1));

    if (!args.execute) {
        console.log('dry-run only — pass --execute --project <p> --database <d> to write (create-only).');
        return;
    }
    if (summary.invalid > 0 || summary.refused > 0) {
        console.error('refusing to execute: manifest contains invalid or refused records');
        process.exit(1);
    }
    if (summary.conflict > 0) {
        console.error('refusing to execute: conflicts detected — resolve manually before re-running');
        process.exit(1);
    }
    const result = await store.commit(writes);
    console.log(`imported ${result.written} documents (create-only, all draft).`);
};

main().catch((error) => {
    console.error(`import failed: ${error.message}`);
    process.exit(1);
});
