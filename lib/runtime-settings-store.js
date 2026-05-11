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

export class RuntimeSettingsStoreUnavailableError extends Error {
    constructor(operation, cause) {
        super('Runtime settings storage is unavailable', { cause });
        this.name = 'RuntimeSettingsStoreUnavailableError';
        this.code = 'RUNTIME_SETTINGS_STORE_UNAVAILABLE';
        this.statusCode = 503;
        this.operation = operation;
    }
}

const throwSettingsUnavailable = (operation, error) => {
    console.error(`Failed to ${operation} runtime settings from Firestore:`, error.message);
    throw new RuntimeSettingsStoreUnavailableError(operation, error);
};

export class RuntimeSettingsStore {
    constructor({
        firestoreEnabled = process.env.RUNTIME_SETTINGS_FIRESTORE_ENABLED ?? process.env.CALL_LOG_FIRESTORE_ENABLED,
        firestoreDatabaseId = process.env.RUNTIME_SETTINGS_FIRESTORE_DATABASE_ID || process.env.CALL_LOG_FIRESTORE_DATABASE_ID,
        firestoreCollection = process.env.RUNTIME_SETTINGS_FIRESTORE_COLLECTION || 'runtimeSettings',
        firestoreDocumentId = process.env.RUNTIME_SETTINGS_FIRESTORE_DOCUMENT_ID || 'admin',
        googleProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_PROJECT_ID || '',
        firestore = null,
        initialSettings = {}
    } = {}) {
        this.firestoreEnabled = toBool(firestoreEnabled);
        this.firestoreDatabaseId = String(firestoreDatabaseId || '').trim();
        this.firestoreCollection = String(firestoreCollection || 'runtimeSettings').trim();
        this.firestoreDocumentId = String(firestoreDocumentId || 'admin').trim();
        this.googleProjectId = String(googleProjectId || '').trim();
        this.firestore = firestore;
        this.memorySettings = { ...initialSettings };
    }

    isEnabled() {
        return this.firestoreEnabled;
    }

    async get() {
        if (!this.firestoreEnabled) return { ...this.memorySettings };

        try {
            const doc = await this.getDocument().get();
            if (!doc.exists) return {};
            return firestoreValueToJson(doc.data());
        } catch (error) {
            throwSettingsUnavailable('read', error);
        }
    }

    async update(patch, {
        actor = 'admin',
        updatedAt = new Date().toISOString()
    } = {}) {
        const settings = {
            ...(await this.get()),
            ...patch,
            updatedAt,
            updatedBy: actor
        };

        if (!this.firestoreEnabled) {
            this.memorySettings = settings;
            return { ...this.memorySettings };
        }

        try {
            await this.getDocument().set(settings, { merge: true });
        } catch (error) {
            throwSettingsUnavailable('update', error);
        }

        return settings;
    }

    health() {
        return {
            runtimeSettings: {
                firestoreEnabled: this.firestoreEnabled,
                firestoreCollection: this.firestoreEnabled ? this.firestoreCollection : '',
                firestoreDocumentId: this.firestoreEnabled ? this.firestoreDocumentId : ''
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

    getDocument() {
        return this.getFirestore()
            .collection(this.firestoreCollection)
            .doc(this.firestoreDocumentId);
    }
}
