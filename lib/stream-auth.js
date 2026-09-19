// Media Stream access token — binds a WebSocket upgrade to a call that already
// passed Twilio webhook signature verification.
//
// Twilio does not send X-Twilio-Signature on the Media Streams WebSocket
// itself, so the signature-verified webhook (/incoming-call, /gateway/route,
// /handoff/dial-status fallback) embeds a short-lived HMAC token in the
// <Stream url> query. The /media-stream handler verifies it BEFORE creating
// any provider connection, then cross-checks the `start` frame's callSid.
//
// The token only authorizes the stream for the callSid it was issued for —
// a leaked token cannot be replayed onto another call, and it expires with
// the call's maximum plausible duration.

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // calls never legitimately outlive this
const TOKEN_VERSION = 'v1';

const base64url = (value) => Buffer.from(String(value), 'utf8').toString('base64url');

/**
 * Issue a token for one verified call.
 * @param {{callSid: string, secret: string, ttlMs?: number, now?: () => number}} args
 * @returns {string} `${version}.${payload}.${signature}` — URL-safe
 */
export function createStreamToken({ callSid, secret, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    if (!callSid || !secret) return '';
    const payload = base64url(JSON.stringify({ sid: String(callSid), exp: now() + ttlMs }));
    const signature = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
    return `${TOKEN_VERSION}.${payload}.${signature}`;
}

/**
 * Verify a stream token. Returns the bound callSid or null.
 * Constant-time on the signature; expiry checked against `now`.
 * @returns {{callSid: string} | null}
 */
export function verifyStreamToken(token, secret, now = Date.now()) {
    if (!token || !secret) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;

    const [, payload, signature] = parts;
    const expected = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
        return null;
    }

    let claims;
    try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!claims?.sid || typeof claims.exp !== 'number' || claims.exp < now) {
        return null;
    }
    return { callSid: String(claims.sid) };
}

/**
 * Extract and verify the token from the upgrade request URL.
 * Enabled-but-unconfigured (no secret) fails CLOSED — a stream with no way to
 * verify callers is worse than no stream.
 * @returns {{ok: true, callSid: string} | {ok: false, reason: string}}
 */
export function verifyMediaStreamRequest(req, { secret = '', enabled = true, now = Date.now() } = {}) {
    if (enabled !== true && enabled !== 'true') {
        // Explicit opt-out for local development only — log loudly at call site.
        return { ok: true, callSid: '', bypassed: true };
    }
    if (!secret) return { ok: false, reason: 'stream_auth_unconfigured' };

    let token = '';
    try {
        token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    } catch {
        return { ok: false, reason: 'malformed_request_url' };
    }
    if (!token) return { ok: false, reason: 'missing_stream_token' };

    const verified = verifyStreamToken(token, secret, now);
    return verified ? { ok: true, callSid: verified.callSid } : { ok: false, reason: 'invalid_stream_token' };
}
