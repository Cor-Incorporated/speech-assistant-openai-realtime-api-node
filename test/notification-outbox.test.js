import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationOutbox, sendResendEmail } from '../lib/notification-outbox.js';

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
