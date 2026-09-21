// Admin v2 service wiring — lazily loads the compiled TypeScript backend so
// `node index.js` still boots in environments where `npm run build:backend`
// has not run (dev tooling, minimal smoke setups). In production the image
// always builds dist-backend, so the admin API is available there; if it is
// missing locally the routes respond 503 instead of failing startup.

const state = {
    loaded: false,
    failed: false,
    knowledgeService: null,
    knowledgeRepo: null,
    knowledgeReader: null,
    callService: null,
    callRepo: null,
    escalationService: null,
    escalationRepo: null
};

const loadModule = async (spec) => import(spec);

/** Build the Firestore-backed repositories. Falls back to in-memory when
 * CALL_LOG_FIRESTORE_ENABLED is off so the API still answers in dev. */
const buildRepositories = async () => {
    const { FirestoreKnowledgeRepository } = await loadModule('../dist-backend/knowledge/firestore-repository.js');
    const { InMemoryKnowledgeRepository } = await loadModule('../dist-backend/knowledge/repository.js');
    const { FirestoreCallRepository } = await loadModule('../dist-backend/calls/firestore-call-repository.js');
    const { InMemoryCallRepository } = await loadModule('../dist-backend/calls/call-repository.js');
    const { InMemoryEscalationRepository } = await loadModule('../dist-backend/escalations/escalation-service.js');
    const { FirestoreEscalationRepository } = await loadModule('../dist-backend/escalations/firestore-escalation-repository.js');

    const firestoreEnabled = process.env.CALL_LOG_FIRESTORE_ENABLED === 'true';
    return {
        knowledgeRepo: firestoreEnabled ? new FirestoreKnowledgeRepository() : new InMemoryKnowledgeRepository(),
        callRepo: firestoreEnabled ? new FirestoreCallRepository() : new InMemoryCallRepository(),
        // unacknowledged critical cases must survive restarts
        escalationRepo: firestoreEnabled ? new FirestoreEscalationRepository() : new InMemoryEscalationRepository()
    };
};

export const initAdminV2Services = async ({ log = console } = {}) => {
    if (state.loaded || state.failed) return state;
    try {
        const { KnowledgeService } = await loadModule('../dist-backend/knowledge/knowledge-service.js');
        const { KnowledgeReader } = await loadModule('../dist-backend/knowledge/knowledge-reader.js');
        const { CallService } = await loadModule('../dist-backend/calls/call-service.js');
        const { EscalationService } = await loadModule('../dist-backend/escalations/escalation-service.js');
        const { knowledgeRepo, callRepo, escalationRepo } = await buildRepositories();

        state.knowledgeRepo = knowledgeRepo;
        state.knowledgeService = new KnowledgeService(knowledgeRepo);
        state.knowledgeReader = new KnowledgeReader(knowledgeRepo);
        state.callService = new CallService(callRepo);
        state.callRepo = callRepo;
        state.escalationService = new EscalationService(escalationRepo);
        state.escalationRepo = escalationRepo;
        state.loaded = true;
    } catch (error) {
        state.failed = true;
        log.warn('admin-v2 services unavailable (backend build missing?)', { error: error.message });
    }
    return state;
};

export const getAdminV2Services = () => state;
