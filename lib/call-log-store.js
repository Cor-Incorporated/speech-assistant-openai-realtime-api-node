import { Firestore } from '@google-cloud/firestore';

const toBool = (value) => value === true || value === 'true';

const firestoreValueToJson = (value) => {
    if (!value) return value;
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (Array.isArray(value)) return value.map(firestoreValueToJson);
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, firestoreValueToJson(entry)])
        );
    }
    return value;
};

const asPlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...value };
};

const getOps = (log) => asPlainObject(log.ops);

const isPendingCallback = (log) => Boolean(log.callbackRequired)
    && !['completed', 'not_required'].includes(getOps(log).callbackStatus);

const isInProgress = (log) => ['needs_callback', 'in_progress'].includes(getOps(log).status);

const isCompleted = (log) => getOps(log).status === 'done';

export class CallLogStoreUnavailableError extends Error {
    constructor(operation, cause) {
        super('Call log storage is unavailable', { cause });
        this.name = 'CallLogStoreUnavailableError';
        this.code = 'CALL_LOG_STORE_UNAVAILABLE';
        this.statusCode = 503;
        this.operation = operation;
    }
}

const throwStoreUnavailable = (operation, error) => {
    console.error(`Failed to ${operation} call logs from Firestore:`, error.message);
    throw new CallLogStoreUnavailableError(operation, error);
};

export class CallLogStore {
    constructor({
        firestoreEnabled = process.env.CALL_LOG_FIRESTORE_ENABLED,
        firestoreDatabaseId = process.env.CALL_LOG_FIRESTORE_DATABASE_ID,
        firestoreCollection = process.env.CALL_LOG_FIRESTORE_COLLECTION || 'callLogs',
        googleProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_PROJECT_ID || '',
        firestore = null
    } = {}) {
        this.firestoreEnabled = toBool(firestoreEnabled);
        this.firestoreDatabaseId = String(firestoreDatabaseId || '').trim();
        this.firestoreCollection = String(firestoreCollection || 'callLogs').trim();
        this.googleProjectId = String(googleProjectId || '').trim();
        this.firestore = firestore;
    }

    isEnabled() {
        return this.firestoreEnabled;
    }

    async list({ limit = 50 } = {}) {
        if (!this.firestoreEnabled) return [];

        try {
            const snapshot = await this.getCollection()
                .orderBy('startedAt', 'desc')
                .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
                .get();

            return snapshot.docs.map((doc) => ({
                callSid: doc.id,
                ...firestoreValueToJson(doc.data())
            }));
        } catch (error) {
            throwStoreUnavailable('list', error);
        }
    }

    async get(callSid) {
        if (!this.firestoreEnabled || !callSid) return null;

        try {
            const doc = await this.getCollection().doc(callSid).get();
            if (!doc.exists) return null;
            return {
                callSid: doc.id,
                ...firestoreValueToJson(doc.data())
            };
        } catch (error) {
            throwStoreUnavailable('read', error);
        }
    }

    async updateOps(callSid, opsPatch, {
        actor = 'admin',
        updatedAt = new Date().toISOString()
    } = {}) {
        if (!this.firestoreEnabled || !callSid) return null;

        const current = await this.get(callSid);
        if (!current) return null;

        const ops = {
            ...asPlainObject(current.ops),
            ...asPlainObject(opsPatch)
        };

        try {
            await this.getCollection().doc(callSid).set({
                ops,
                opsUpdatedAt: updatedAt,
                opsUpdatedBy: actor,
                updatedAt
            }, { merge: true });
        } catch (error) {
            throwStoreUnavailable('update', error);
        }

        return {
            ...current,
            ops,
            opsUpdatedAt: updatedAt,
            opsUpdatedBy: actor,
            updatedAt
        };
    }

    async summary() {
        const logs = await this.list({ limit: 200 });
        return {
            total: logs.length,
            callbackRequired: logs.filter(isPendingCallback).length,
            inProgress: logs.filter(isInProgress).length,
            completed: logs.filter(isCompleted).length,
            needsReview: logs.filter((log) => Boolean(getOps(log).needsReview)).length
        };
    }

    health() {
        return {
            storage: {
                firestoreEnabled: this.firestoreEnabled,
                firestoreCollection: this.firestoreEnabled ? this.firestoreCollection : ''
            }
        };
    }

    getFirestore() {
        if (!this.firestore) {
            this.firestore = new Firestore({
                projectId: this.googleProjectId || undefined,
                databaseId: this.firestoreDatabaseId || undefined
            });
        }
        return this.firestore;
    }

    getCollection() {
        return this.getFirestore().collection(this.firestoreCollection);
    }
}
