import { Firestore } from '@google-cloud/firestore';
import { createHash, randomUUID } from 'node:crypto';

const isSmokeCall = (callId) => String(callId || '').startsWith('CA_SMOKE');
const asList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
// 廃止済みの通知先。環境変数・GitHub Variableに残っていても送信しない最終防御。
// 追加の除外先は NOTIFY_EMAIL_BLOCKLIST（カンマ区切り）で指定する。
export const RETIRED_NOTIFY_RECIPIENTS = Object.freeze(['k.isayama@cor-jp.com']);

const withoutBlocked = (addresses, blocked) => addresses.filter(
    (address) => !blocked.has((address.match(/<([^<>]+)>$/)?.[1] || address).trim().toLowerCase())
);
const displayValue = (value, fallback) => {
    if (value === null || value === undefined) return fallback;
    return String(value).trim() || fallback;
};

export function buildCallSummaryEmailText(record = {}) {
    return [
        `通話ID: ${displayValue(record.callSid, '未確認')}`,
        `開始: ${displayValue(record.startedAtJst || record.startedAt, '未確認')}`,
        `通話秒数: ${displayValue(record.durationSeconds, '未確認')}`,
        `用件: ${displayValue(record.intent, '未抽出')}`,
        `要約: ${displayValue(record.summary, '未抽出')}`,
        `顧客名: ${displayValue(record.customerName, '未確認')}`,
        `発信者番号（Twilio）: ${displayValue(record.from, '非通知／取得不可')}`,
        `折り返し番号（会話中に確認）: ${displayValue(record.customerPhoneNumber, '未確認')}`,
        `折り返し要否: ${record.callbackRequired ? '要' : '不要'}`
    ].join('\n');
}

export async function sendResendEmail({
    apiKey,
    from,
    to,
    cc = [],
    subject,
    text,
    idempotencyKey = '',
    blockedRecipients = [],
    timeoutMs = 10000,
    fetchImpl = fetch
} = {}) {
    if (!apiKey) return { ok: false, reason: 'missing_api_key' };
    if (!from || !to || !subject) return { ok: false, reason: 'missing_email_configuration' };
    // Recheck at the delivery boundary, including entries persisted before a
    // recipient was retired and entries retried by another process.
    const blocked = new Set([...RETIRED_NOTIFY_RECIPIENTS, ...blockedRecipients].map((value) => value.toLowerCase()));
    const recipients = withoutBlocked(asList(to), blocked);
    const copies = withoutBlocked(asList(cc), blocked);
    if (recipients.length === 0) return { ok: false, reason: 'no_recipients' };

    const payload = {
        from,
        to: recipients,
        subject,
        text: String(text || '')
    };
    if (copies.length > 0) payload.cc = copies;

    let response;
    try {
        response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 10000) : 10000)
        });
    } catch {
        return { ok: false, reason: 'network_error' };
    }

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
        blocklist = '',
        firestoreEnabled = false,
        firestoreDatabaseId = '',
        googleProjectId = '',
        firestore = null,
        fetchImpl = fetch
    } = {}) {
        this.enabled = enabled === true || enabled === 'true';
        this.apiKey = String(apiKey || '').trim();
        const blocked = new Set([...RETIRED_NOTIFY_RECIPIENTS, ...asList(blocklist)].map((item) => item.toLowerCase()));
        this.blockedRecipients = [...blocked];
        this.to = withoutBlocked(asList(to), blocked);
        this.cc = withoutBlocked(asList(cc), blocked);
        this.removedRecipients = [...asList(to), ...asList(cc)].filter((item) => blocked.has(item.toLowerCase())).length;
        this.from = String(from || '').trim();
        this.firestoreEnabled = firestoreEnabled === true || firestoreEnabled === 'true';
        this.firestoreDatabaseId = String(firestoreDatabaseId || '').trim();
        this.googleProjectId = String(googleProjectId || '').trim();
        this.firestore = firestore;
        this.fetchImpl = fetchImpl;
        this.memory = new Map();
        this.inflight = new Map();
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
        if (this.firestoreEnabled) {
            await this.getFirestore().collection('mailOutbox').doc(id).set(value, { merge: true });
        }
        this.memory.set(id, value);
    }

    async get(id) {
        if (this.firestoreEnabled) {
            const snapshot = await this.getFirestore().collection('mailOutbox').doc(id).get();
            if (snapshot.exists) return { id, ...snapshot.data() };
        }
        const value = this.memory.get(id);
        return value ? { id, ...value } : null;
    }

    async enqueue({ kind, callId, subject, text, timeoutMs = 10000 } = {}) {
        if (!this.enabled) return { ok: false, skipped: true, reason: 'disabled' };
        if (isSmokeCall(callId)) return { ok: false, skipped: true, reason: 'smoke_call' };
        if (this.to.length === 0) return { ok: false, skipped: true, reason: 'no_recipients' };

        const key = JSON.stringify([String(kind || 'notification'), String(callId || randomUUID())]);
        const id = `notification-${createHash('sha256').update(key).digest('hex')}`;
        const now = new Date().toISOString();
        return this.retry(id, {
            kind: String(kind || 'notification'),
            callId: String(callId || ''),
            to: this.to,
            cc: this.cc,
            from: this.from,
            subject: String(subject || ''),
            text: String(text || ''),
            timeoutMs,
            status: 'queued',
            attempts: 0,
            lastError: '',
            providerMessageId: '',
            createdAt: now,
            updatedAt: now
        });
    }

    async retry(id, initial = null) {
        if (!this.enabled) return { ok: false, skipped: true, reason: 'disabled' };
        if (this.inflight.has(id)) return this.inflight.get(id);
        const pending = this.deliver(id, initial).finally(() => this.inflight.delete(id));
        this.inflight.set(id, pending);
        return pending;
    }

    // The same Firestore document and claim are shared by Cloud Run replicas.
    // Keep the first payload immutable: provider retries with changed content
    // would otherwise conflict with the original idempotency key.
    async change(id, update) {
        if (!this.firestoreEnabled) {
            const { value, result } = update(this.memory.get(id) || null);
            if (value) this.memory.set(id, value);
            return result;
        }
        const doc = this.getFirestore().collection('mailOutbox').doc(id);
        return this.getFirestore().runTransaction(async (transaction) => {
            const snapshot = await transaction.get(doc);
            const { value, result } = update(snapshot.exists ? snapshot.data() : null);
            if (value) transaction.set(doc, value);
            return result;
        });
    }

    async deliver(id, initial) {
        const owner = randomUUID();
        const claim = await this.change(id, (stored) => {
            const current = stored || initial;
            if (!current) return { result: { ok: false, reason: 'outbox_not_found' } };
            if (current.status === 'accepted') return { result: { ok: true, status: 'accepted', id } };
            if (current.status === 'sending' && current.leaseUntil > Date.now()) {
                return { result: { ok: false, status: 'sending', id, reason: 'delivery_in_progress' } };
            }
            const sending = {
                ...current, status: 'sending', attempts: Number(current.attempts || 0) + 1,
                leaseOwner: owner, leaseUntil: Date.now() + 30000, updatedAt: new Date().toISOString()
            };
            delete sending.id;
            return { value: sending, result: { sending } };
        });
        if (!claim.sending) return claim;
        const sending = claim.sending;

        const result = await sendResendEmail({
            apiKey: this.apiKey,
            from: sending.from,
            to: sending.to,
            cc: sending.cc,
            subject: sending.subject,
            text: sending.text,
            idempotencyKey: id,
            blockedRecipients: this.blockedRecipients,
            timeoutMs: sending.timeoutMs,
            fetchImpl: this.fetchImpl
        });
        return this.change(id, (current) => {
            // An expired worker may not overwrite the result of a newer claim.
            if (current?.leaseOwner !== owner) {
                return { result: { ok: current?.status === 'accepted', status: current?.status, id, reason: 'claim_changed' } };
            }
            const updated = {
                ...current,
                status: result.ok ? 'accepted' : 'failed',
                lastError: result.ok ? '' : result.reason,
                providerMessageId: result.providerMessageId || '',
                leaseUntil: 0,
                updatedAt: new Date().toISOString()
            };
            return { value: updated, result: { ok: result.ok, status: updated.status, id, reason: result.reason || '' } };
        });
    }
}
