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
