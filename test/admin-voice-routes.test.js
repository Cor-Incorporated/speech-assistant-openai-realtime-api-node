import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerAdminVoiceRoutes } from '../lib/admin-voice-routes.js';

const callSid = `CA${'1'.repeat(32)}`;
const recordingSid = `RE${'2'.repeat(32)}`;
async function fixture(t, { context = null, call = { providerCallSid: callSid }, unavailable = false } = {}) {
    const app = Fastify();
    await app.register(registerAdminVoiceRoutes, {
        callService: { get: async () => call },
        contextStore: { get: async () => { if (unavailable) throw new Error('private storage error'); return context; } },
        preHandler: async (request, reply) => {
            if (request.headers.authorization !== 'operator') return reply.code(403).send({ code: 'FORBIDDEN' });
            request.adminActor = { subject: 'operator' };
        }
    });
    t.after(() => app.close());
    return (authorization = 'operator') => app.inject({ url: `/api/admin/v2/calls/${callSid}/voice`, headers: { authorization } });
}

test('voice metadata exposes authenticated playback without provider URL or contact data', async (t) => {
    const get = await fixture(t, { context: {
        status: 'voicemail_recorded', voicemailRecordingStatus: 'completed', voicemailRecordingSid: recordingSid,
        voicemailRecordingUrl: 'https://provider.invalid/private', callerNumber: 'PRIVATE',
        voicemailDurationSeconds: 12, voicemailTranscribed: true, voicemailNotified: true
    } });
    const response = await get();
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.json().voicemail, {
        status: 'completed', durationSeconds: 12, transcribed: true, notificationAccepted: true,
        playbackUrl: `/api/admin/voicemails/${recordingSid}?call_sid=${callSid}`
    });
    assert.doesNotMatch(response.body, /PRIVATE|provider.invalid/);
    assert.equal((await get('viewer')).statusCode, 403);
});

test('no recording, absent recording, unavailable storage, and deleted calls stay distinct', async (t) => {
    const none = await fixture(t);
    assert.deepEqual((await none()).json(), { handoff: null, voicemail: null });
    const absent = await fixture(t, { context: { voicemailRecordingStatus: 'absent' } });
    assert.equal((await absent()).json().voicemail.playbackUrl, null);
    const failed = await fixture(t, { unavailable: true });
    assert.equal((await failed()).statusCode, 503);
    assert.doesNotMatch((await failed()).body, /private storage/);
    const deleted = await fixture(t, { call: { providerCallSid: callSid, deletedAt: '2026-11-07' } });
    assert.equal((await deleted()).statusCode, 404);
});
