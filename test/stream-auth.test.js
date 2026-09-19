import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStreamToken, verifyStreamToken, verifyMediaStreamRequest } from '../lib/stream-auth.js';

const SECRET = 'test-auth-token-secret';
const CALL_SID = 'CA' + 'a'.repeat(32);

describe('stream-auth token', () => {
    it('round-trips a valid token to its bound callSid', () => {
        const token = createStreamToken({ callSid: CALL_SID, secret: SECRET });
        assert.ok(token);
        const verified = verifyStreamToken(token, SECRET);
        assert.equal(verified?.callSid, CALL_SID);
    });

    it('rejects a token signed with a different secret', () => {
        const token = createStreamToken({ callSid: CALL_SID, secret: SECRET });
        assert.equal(verifyStreamToken(token, 'wrong-secret'), null);
    });

    it('rejects an expired token', () => {
        let now = 1_000_000;
        const token = createStreamToken({ callSid: CALL_SID, secret: SECRET, ttlMs: 1000, now: () => now });
        now += 2000;
        assert.equal(verifyStreamToken(token, SECRET, now), null);
    });

    it('rejects malformed and tampered tokens', () => {
        assert.equal(verifyStreamToken('', SECRET), null);
        assert.equal(verifyStreamToken('v1.payload', SECRET), null);
        const token = createStreamToken({ callSid: CALL_SID, secret: SECRET });
        const [v, payload, sig] = token.split('.');
        // Tamper with the payload — a different callSid must not verify.
        const tamperedPayload = Buffer.from(JSON.stringify({ sid: 'CA' + 'b'.repeat(32), exp: Date.now() + 60000 })).toString('base64url');
        assert.equal(verifyStreamToken(`${v}.${tamperedPayload}.${sig}`, SECRET), null);
    });

    it('returns empty token when callSid or secret is missing', () => {
        assert.equal(createStreamToken({ callSid: '', secret: SECRET }), '');
        assert.equal(createStreamToken({ callSid: CALL_SID, secret: '' }), '');
    });
});

describe('verifyMediaStreamRequest', () => {
    const req = (url) => ({ url });

    it('accepts a request carrying a valid token', () => {
        const token = createStreamToken({ callSid: CALL_SID, secret: SECRET });
        const result = verifyMediaStreamRequest(req(`/media-stream?token=${encodeURIComponent(token)}`), {
            secret: SECRET,
            enabled: 'true'
        });
        assert.deepEqual(result, { ok: true, callSid: CALL_SID });
    });

    it('rejects missing and invalid tokens', () => {
        assert.equal(
            verifyMediaStreamRequest(req('/media-stream'), { secret: SECRET, enabled: 'true' }).reason,
            'missing_stream_token'
        );
        assert.equal(
            verifyMediaStreamRequest(req('/media-stream?token=bad'), { secret: SECRET, enabled: 'true' }).reason,
            'invalid_stream_token'
        );
    });

    it('fails closed when enabled but no secret is configured', () => {
        const result = verifyMediaStreamRequest(req('/media-stream?token=x'), { secret: '', enabled: 'true' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'stream_auth_unconfigured');
    });

    it('bypasses only when explicitly disabled', () => {
        const result = verifyMediaStreamRequest(req('/media-stream'), { secret: '', enabled: 'false' });
        assert.equal(result.ok, true);
        assert.equal(result.bypassed, true);
    });
});
