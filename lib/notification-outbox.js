import { Firestore } from '@google-cloud/firestore';

const isSmokeCall = (callId) => String(callId || '').startsWith('CA_SMOKE');
const asList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

export async function sendResendEmail({
    apiKey,
    from,
    to,
    cc = [],
    subject,
    text,
    fetchImpl = fetch
} = {}) {
    if (!apiKey) return { ok: false, reason: 'missing_api_key' };
    if (!from || !to || !subject) return { ok: false, reason: 'missing_email_configuration' };

    const payload = {
        from,
        to: Array.isArray(to) ? to : asList(to),
        subject,
        text: String(text || '')
    };
    const recipients = Array.isArray(cc) ? cc.filter(Boolean) : asList(cc);
    if (recipients.length > 0) payload.cc = recipients;

    const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    let body = {};
    try {
        body = await response.json();
    } catch {
        body = {};
    }

    return response.ok
        ? { ok: true, statusCode: response.status, providerMessageId: body.id || '' }
        : { ok: false, statusCode: response.status, reason: body.message || 'resend_api_error' };
}

export class NotificationOutbox {
    constructor({
        enabled = false,
        apiKey = '',
        to = '',
        cc = '',
        from = '',
        firestoreEnabled = false,
        firestoreDatabaseId = '',
        googleProjectId = '',
        firestore = null,
        fetchImpl = fetch
    } = {}) {
        this.enabled = enabled === true || enabled === 'true';
        this.apiKey = String(apiKey || '').trim();
        this.to = asList(to);
        this.cc = asList(cc);
        this.from = String(from || '').trim();
        this.firestoreEnabled = firestoreEnabled === true || firestoreEnabled === 'true';
        this.firestoreDatabaseId = String(firestoreDatabaseId || '').trim();
        this.googleProjectId = String(googleProjectId || '').trim();
        this.firestore = firestore;
        this.fetchImpl = fetchImpl;
        this.memory = new Map();
    }

    isEnabled() {
        return this.enabled;
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

    async save(id, value) {
        this.memory.set(id, value);
        if (this.firestoreEnabled) {
            await this.getFirestore().collection('mailOutbox').doc(id).set(value, { merge: true });
        }
    }

    async get(id) {
        if (this.firestoreEnabled) {
            const snapshot = await this.getFirestore().collection('mailOutbox').doc(id).get();
            if (snapshot.exists) return { id, ...snapshot.data() };
        }
        const value = this.memory.get(id);
        return value ? { id, ...value } : null;
    }

    async enqueue({ kind, callId, subject, text } = {}) {
        if (!this.enabled) return { ok: false, skipped: true, reason: 'disabled' };
        if (isSmokeCall(callId)) return { ok: false, skipped: true, reason: 'smoke_call' };

        const id = `${String(kind || 'notification')}-${String(callId || 'unknown')}-${Date.now()}`;
        const now = new Date().toISOString();
        await this.save(id, {
            kind: String(kind || 'notification'),
            callId: String(callId || ''),
            to: this.to,
            cc: this.cc,
            from: this.from,
            subject: String(subject || ''),
            text: String(text || ''),
            status: 'queued',
            attempts: 0,
            lastError: '',
            providerMessageId: '',
            createdAt: now,
            updatedAt: now
        });

        return this.retry(id);
    }

    async retry(id) {
        const current = await this.get(id);
        if (!current) return { ok: false, reason: 'outbox_not_found' };
        if (current.status === 'accepted') return { ok: true, status: 'accepted', id };

        const attempts = Number(current.attempts || 0) + 1;
        const sending = { ...current, status: 'sending', attempts, updatedAt: new Date().toISOString() };
        delete sending.id;
        await this.save(id, sending);

        const result = await sendResendEmail({
            apiKey: this.apiKey,
            from: current.from,
            to: current.to,
            cc: current.cc,
            subject: current.subject,
            text: current.text,
            fetchImpl: this.fetchImpl
        });
        const updated = {
            ...sending,
            status: result.ok ? 'accepted' : 'failed',
            lastError: result.ok ? '' : result.reason,
            providerMessageId: result.providerMessageId || '',
            updatedAt: new Date().toISOString()
        };
        await this.save(id, updated);
        return { ok: result.ok, status: updated.status, id, reason: result.reason || '' };
    }
}
