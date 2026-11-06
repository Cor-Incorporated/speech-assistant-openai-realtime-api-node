import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildCallSummaryEmailText,
    NotificationOutbox,
    sendResendEmail
} from '../lib/notification-outbox.js';

test('call summary email separates Twilio caller number from spoken callback number', () => {
    const text = buildCallSummaryEmailText({
        callSid: 'CA_REAL_0',
        startedAtJst: '2026-07-18 13:23:27',
        durationSeconds: 50,
        intent: '相談',
        summary: '相談内容',
        customerName: '山田太郎',
        from: '+819012345678',
        customerPhoneNumber: '09011112222',
        callbackRequired: true
    });

    assert.match(text, /発信者番号（Twilio）: \+819012345678/);
    assert.match(text, /折り返し番号（会話中に確認）: 09011112222/);
    assert.match(text, /折り返し要否: 要/);
});

test('call summary email keeps the caller number when no spoken callback number exists', () => {
    const text = buildCallSummaryEmailText({
        callSid: 'CA_REAL_0B',
        from: '+819012345678',
        customerPhoneNumber: '',
        callbackRequired: false
    });

    assert.match(text, /発信者番号（Twilio）: \+819012345678/);
    assert.match(text, /折り返し番号（会話中に確認）: 未確認/);
});

test('call summary email does not invent an unavailable caller number', () => {
    const text = buildCallSummaryEmailText({
        callSid: 'CA_REAL_0C',
        from: '',
        customerPhoneNumber: '',
        callbackRequired: false
    });

    assert.match(text, /発信者番号（Twilio）: 非通知／取得不可/);
    assert.doesNotMatch(text, /発信者番号（Twilio）: \+8190/);
});

test('notification outbox excludes smoke calls', async () => {
    const outbox = new NotificationOutbox({ enabled: true, apiKey: 'test' });
    const result = await outbox.enqueue({ kind: 'call-summary', callId: 'CA_SMOKE_1', subject: 'smoke', text: 'smoke' });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'smoke_call');
});

test('notification outbox stores accepted Resend response', async () => {
    const outbox = new NotificationOutbox({
        enabled: true,
        apiKey: 're_test',
        from: 'noreply@example.com',
        to: 'ops@example.com',
        fetchImpl: async (_url, options) => {
            assert.equal(options.headers.Authorization, 'Bearer re_test');
            return {
                ok: true,
                status: 200,
                async json() { return { id: 'resend_123' }; }
            };
        }
    });

    const result = await outbox.enqueue({ kind: 'call-summary', callId: 'CA_REAL_1', subject: 'subject', text: 'body' });
    const stored = await outbox.get(result.id);

    assert.equal(result.ok, true);
    assert.equal(stored.status, 'accepted');
    assert.equal(stored.providerMessageId, 'resend_123');
});

test('notification outbox preserves failed delivery for retry', async () => {
    const outbox = new NotificationOutbox({
        enabled: true,
        apiKey: '',
        from: 'noreply@example.com',
        to: 'ops@example.com'
    });

    const result = await outbox.enqueue({ kind: 'handoff-fallback', callId: 'CA_REAL_2', subject: 'subject', text: 'body' });
    const stored = await outbox.get(result.id);

    assert.equal(result.ok, false);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.attempts, 1);
    assert.equal(stored.lastError, 'missing_api_key');
});

test('Resend client rejects incomplete configuration before network call', async () => {
    const result = await sendResendEmail({ apiKey: 'test', from: '', to: 'ops@example.com', subject: 'subject' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_email_configuration');
});

test('retired and blocklisted recipients never receive notifications even if configured', async () => {
    const sent = [];
    const outbox = new NotificationOutbox({
        enabled: true,
        apiKey: 'test',
        to: 'Ops@example.test, K.Isayama@cor-jp.com',
        cc: 'k.isayama@cor-jp.com, old@example.test, keep@example.test',
        blocklist: 'old@example.test',
        from: 'noreply@example.test',
        fetchImpl: async (_url, options) => {
            sent.push(JSON.parse(options.body));
            return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
        }
    });

    await outbox.enqueue({ kind: 'call-summary', callId: 'CA_REAL_9', subject: 's', text: 't' });
    assert.deepEqual(sent[0].to, ['Ops@example.test']);
    assert.deepEqual(sent[0].cc, ['keep@example.test']);
    assert.equal(outbox.removedRecipients, 3);
});

test('notification outbox skips instead of sending when every recipient was removed', async () => {
    const outbox = new NotificationOutbox({
        enabled: true,
        apiKey: 'test',
        to: 'k.isayama@cor-jp.com',
        from: 'noreply@example.test',
        fetchImpl: async () => { throw new Error('must not send'); }
    });
    const result = await outbox.enqueue({ kind: 'call-summary', callId: 'CA_REAL_10', subject: 's', text: 't' });
    assert.deepEqual(result, { ok: false, skipped: true, reason: 'no_recipients' });
});

test('retry filters retired and newly blocklisted recipients from persisted entries', async () => {
    const sent = [];
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'test', blocklist: 'old@example.test',
        fetchImpl: async (_url, options) => {
            sent.push(JSON.parse(options.body));
            return new Response(JSON.stringify({ id: 'mail_legacy' }));
        }
    });
    await outbox.save('legacy-failed', {
        status: 'failed', from: 'noreply@example.test',
        to: ['ops@example.test', 'K.Isayama@cor-jp.com'],
        cc: ['old@example.test', 'k.isayama@cor-jp.com'],
        subject: 'legacy', text: 'stored before retirement'
    });
    assert.equal((await outbox.retry('legacy-failed')).ok, true);
    assert.deepEqual(sent[0].to, ['ops@example.test']);
    assert.equal(sent[0].cc, undefined);
});

test('concurrent and later enqueue of one call notification sends only once', async () => {
    const sent = [];
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'test', from: 'noreply@example.test', to: 'ops@example.test',
        fetchImpl: async (_url, options) => {
            sent.push(options);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return new Response(JSON.stringify({ id: 'mail_once' }));
        }
    });
    const payload = { kind: 'voicemail', callId: 'CA_ONCE', subject: 'recording', text: 'message' };
    const results = await Promise.all([outbox.enqueue(payload), outbox.enqueue(payload)]);
    const later = await outbox.enqueue({ ...payload, text: 'a later transcription' });
    assert.equal(sent.length, 1);
    assert.equal(results[0].id, results[1].id);
    assert.equal(later.id, results[0].id);
    assert.ok(sent[0].headers['Idempotency-Key']);
});

test('failed enqueue retries the original payload with the same provider key', async () => {
    const sent = [];
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'test', from: 'noreply@example.test', to: 'ops@example.test',
        fetchImpl: async (_url, options) => {
            sent.push(options);
            return sent.length === 1
                ? new Response(JSON.stringify({ message: 'temporary' }), { status: 503 })
                : new Response(JSON.stringify({ id: 'mail_retry' }));
        }
    });
    const payload = { kind: 'voicemail', callId: 'CA_RETRY', subject: 'recording', text: 'original' };
    assert.equal((await outbox.enqueue(payload)).ok, false);
    assert.equal((await outbox.enqueue({ ...payload, text: 'changed' })).ok, true);
    assert.ok(sent[0].headers['Idempotency-Key']);
    assert.equal(sent[0].headers['Idempotency-Key'], sent[1].headers['Idempotency-Key']);
    assert.equal(sent[0].body, sent[1].body);
});

test('network failure is persisted as retryable instead of leaving sending state', async () => {
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'test', from: 'noreply@example.test', to: 'ops@example.test',
        fetchImpl: async () => { throw new Error('socket disconnected'); }
    });
    const result = await outbox.enqueue({ kind: 'voicemail', callId: 'CA_DISCONNECT', subject: 's', text: 't' });
    assert.equal(result.ok, false);
    assert.equal((await outbox.get(result.id)).status, 'failed');
});

test('delivery boundary rejects retired addresses even in display-name form', async () => {
    const result = await sendResendEmail({
        apiKey: 'test', from: 'noreply@example.test',
        to: ['Former Staff <K.Isayama@cor-jp.com>'], subject: 's', text: 't',
        fetchImpl: async () => { throw new Error('must not send'); }
    });
    assert.equal(result.reason, 'no_recipients');
});

test('independent Cloud Run outboxes share one durable claim and preserve accepted mail', async () => {
    const rows = new Map();
    let transactions = Promise.resolve();
    const firestore = {
        collection: () => ({ doc: (id) => ({ id }) }),
        runTransaction: (work) => {
            const result = transactions.then(() => work({
                get: async (doc) => ({ exists: rows.has(doc.id), data: () => rows.get(doc.id) }),
                set: (doc, value) => rows.set(doc.id, structuredClone(value))
            }));
            transactions = result.catch(() => {});
            return result;
        }
    };
    let releaseSend;
    let startedSend;
    const started = new Promise((resolve) => { startedSend = resolve; });
    const release = new Promise((resolve) => { releaseSend = resolve; });
    const sent = [];
    const options = {
        enabled: true, apiKey: 'test', from: 'noreply@example.test', to: 'ops@example.test',
        firestoreEnabled: true, firestore,
        fetchImpl: async (_url, request) => {
            sent.push(request);
            startedSend();
            await release;
            return new Response(JSON.stringify({ id: 'mail_across_replicas' }));
        }
    };
    const first = new NotificationOutbox(options);
    const second = new NotificationOutbox(options);
    const payload = { kind: 'voicemail', callId: 'CA_SHARED', subject: 'recording', text: 'original' };
    const pending = first.enqueue(payload);
    await started;
    const concurrent = await second.enqueue({ ...payload, text: 'different transcript' });
    assert.equal(concurrent.reason, 'delivery_in_progress');
    releaseSend();
    const accepted = await pending;
    const repeated = await second.enqueue(payload);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.id, accepted.id);
    assert.equal(sent.length, 1);
    assert.equal(rows.get(accepted.id).providerMessageId, 'mail_across_replicas');
    assert.equal(rows.get(accepted.id).text, 'original');
});

test('an expired durable sending claim can resume with its original payload and key', async () => {
    const sent = [];
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'test', from: 'noreply@example.test', to: 'ops@example.test',
        fetchImpl: async (_url, options) => {
            sent.push(options);
            return new Response(JSON.stringify({ id: 'mail_recovered' }));
        }
    });
    await outbox.save('interrupted-send', {
        status: 'sending', leaseUntil: 0, leaseOwner: 'terminated-instance', attempts: 1,
        from: 'noreply@example.test', to: ['ops@example.test'], cc: [], subject: 's', text: 'original'
    });
    assert.equal((await outbox.retry('interrupted-send')).ok, true);
    assert.equal(sent[0].headers['Idempotency-Key'], 'interrupted-send');
    assert.equal((await outbox.get('interrupted-send')).attempts, 2);
});

test('a callback-specific timeout is enforced and retained when its notification is retried', async (t) => {
    const timeouts = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
        timeouts.push(milliseconds);
        return timeout(milliseconds);
    });
    let attempts = 0;
    const outbox = new NotificationOutbox({
        enabled: true, apiKey: 'test', from: 'noreply@example.test', to: 'ops@example.test',
        fetchImpl: async (_url, { signal }) => {
            if (++attempts > 1) return new Response(JSON.stringify({ id: 'bounded_retry' }));
            return new Promise((resolve, reject) => {
                const watchdog = setTimeout(() => resolve(new Response('{}')), 1000);
                signal.addEventListener('abort', () => {
                    clearTimeout(watchdog);
                    reject(signal.reason);
                }, { once: true });
            });
        }
    });
    const payload = { kind: 'voicemail', callId: 'CA_TIMEOUT', subject: 's', text: 't', timeoutMs: 20 };
    const failed = await outbox.enqueue(payload);
    assert.equal(failed.reason, 'network_error');
    assert.equal((await outbox.get(failed.id)).timeoutMs, 20);
    assert.equal((await outbox.enqueue({ ...payload, timeoutMs: 3000 })).ok, true);
    assert.deepEqual(timeouts, [20, 20]);
});
