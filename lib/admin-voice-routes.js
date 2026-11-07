import { isRecordingSid } from './voicemail.js';

const CALL_SID = /^CA[a-fA-F0-9]{32}$/;

// Read the existing handoff record rather than maintaining a second copy of
// recording state in the call projection. The authenticated playback route
// remains the only path to provider audio; provider URLs never leave here.
export async function registerAdminVoiceRoutes(fastify, {
    callService,
    contextStore,
    preHandler,
    auditLog = () => {}
}) {
    if (typeof preHandler !== 'function') throw new Error('voice admin permission guard required');
    fastify.get('/api/admin/v2/calls/:id/voice', { preHandler }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        try {
            const call = await callService.get(request.adminActor, request.params.id);
            if (!call || call.deletedAt) return reply.code(404).send({ code: 'NOT_FOUND' });
            const callSid = call.providerCallSid;
            const context = CALL_SID.test(callSid ?? '') ? await contextStore.get(callSid) : null;
            if (!context) return { handoff: null, voicemail: null };
            const status = context.voicemailRecordingStatus;
            const hasRecording = status === 'completed' && isRecordingSid(context.voicemailRecordingSid);
            const duration = Number(context.voicemailDurationSeconds);
            auditLog('admin.voice.read', {
                actor: request.adminActor.subject, target: request.params.id, result: 'success'
            });
            return {
                handoff: {
                    status: context.status ?? 'unknown',
                    summary: context.whisperSummary || context.summary || null,
                    updatedAt: context.updatedAt ?? null
                },
                voicemail: status === 'completed' || status === 'absent' ? {
                    status,
                    durationSeconds: context.voicemailDurationSeconds != null && Number.isFinite(duration) && duration >= 0 ? duration : null,
                    transcribed: context.voicemailTranscribed === true,
                    notificationAccepted: context.voicemailNotified === true,
                    playbackUrl: hasRecording
                        ? `/api/admin/voicemails/${encodeURIComponent(context.voicemailRecordingSid)}?call_sid=${encodeURIComponent(callSid)}`
                        : null
                } : null
            };
        } catch (error) {
            // Do not turn unavailable storage into "no voicemail".
            const status = error.statusCode === 403 ? 403 : 503;
            return reply.code(status).send({ code: status === 403 ? 'FORBIDDEN' : 'VOICE_UNAVAILABLE' });
        }
    });
}
