import { isHandoffCallConnected } from './handoff.js';
import { waitForWhisperSummary } from './handoff-summary.js';
import {
    buildDialStatusTwiml,
    buildMediaStreamTwimlWithParams,
    buildVoicemailThanksTwiml,
    buildVoicemailTwiml,
    buildWhisperConfirmTwiml,
    buildWhisperTwiml
} from './twiml.js';
import {
    buildVoicemailEmail,
    fetchTwilioRecording,
    isRecordingSid,
    parseTwilioRecordingUrl,
    transcribeVoicemail
} from './voicemail.js';

const DEFAULT_SUMMARY = '受付内容の確認';
const CALL_SID_PATTERN = /^CA[a-fA-F0-9]{32}$/;

const sendTwiml = (reply, body) => reply.type('text/xml').send(body);

const parseDuration = (value) => {
    const seconds = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

/**
 * Human-gate webhooks for the PSTN transfer.
 *
 *   transfer -> whisper (AI summary + "press 1 to connect / 2 if you cannot")
 *            -> connected                       : caller stays bridged
 *            -> rejected / no input / no answer : caller goes to voicemail
 *                                                 (or back to the AI, when
 *                                                 HANDOFF_FALLBACK_MODE=ai_reception)
 *
 * Every dependency is injected so the whole flow runs without Twilio, OpenAI or
 * Firestore in tests.
 */
export async function registerHandoffRoutes(fastify, {
    config,
    contextStore,
    notificationOutbox,
    isValidTwilioWebhook,
    getPublicUrl,
    createStreamToken = () => '',
    twilioAuthToken = '',
    openAiApiKey = '',
    transcriptionModel = 'gpt-4o-transcribe',
    adminPreHandler,
    auditLog = () => {},
    fetchImpl = fetch,
    sleep
} = {}) {
    const guard = (request, reply) => {
        if (!config.enabled) {
            reply.code(404).send({ error: 'handoff_disabled' });
            return false;
        }
        if (!isValidTwilioWebhook({ request })) {
            reply.code(403).send('Forbidden');
            return false;
        }
        return true;
    };
    const callSidOf = (request) => request.query?.call_sid || request.body?.CallSid || '';
    const safeUpdate = async (callSid, patch, label) => {
        try {
            await contextStore.update(callSid, patch);
        } catch (error) {
            console.error(`Failed to update handoff context (${label}):`, error.message);
        }
    };
    const safeEnqueue = async (payload, label) => {
        try {
            return await notificationOutbox.enqueue(payload);
        } catch (error) {
            // A notification failure must never strand the caller or fail the webhook.
            console.error(`Failed to enqueue ${label} notification:`, error.message);
            return { ok: false, reason: 'enqueue_failed' };
        }
    };

    fastify.post('/handoff/whisper', async (request, reply) => {
        if (!guard(request, reply)) return reply;
        const callSid = callSidOf(request);

        let context = null;
        try {
            context = await waitForWhisperSummary({
                store: contextStore,
                callSid,
                waitMs: config.summaryWaitMs,
                ...(sleep ? { sleep } : {})
            });
        } catch (error) {
            // The recipient must still hear the gate prompt even without a summary.
            console.error('Failed to load handoff whisper context:', error.message);
        }
        const summary = context?.whisperSummary || context?.summary || DEFAULT_SUMMARY;
        await safeUpdate(callSid, { status: 'whisper_started' }, 'whisper');
        auditLog('handoff.whisper.started', {
            actor: 'twilio',
            target: callSid,
            metadata: {
                hasSummary: Boolean(context?.summary),
                summarySource: context?.summarySource || 'none',
                summaryStatus: context?.summaryStatus || 'none'
            }
        });

        return sendTwiml(reply, buildWhisperTwiml({
            summary,
            acceptDigit: config.whisperAcceptDigit,
            rejectDigit: config.whisperRejectDigit,
            fallbackMode: config.fallbackMode,
            confirmUrl: getPublicUrl(request, `/handoff/whisper-confirm?call_sid=${encodeURIComponent(callSid)}`)
        }));
    });

    fastify.post('/handoff/whisper-confirm', async (request, reply) => {
        if (!guard(request, reply)) return reply;
        const callSid = callSidOf(request);

        const digits = String(request.body?.Digits || '');
        const accepted = digits === config.whisperAcceptDigit;
        const rejectedToCallCenter = digits === config.whisperRejectDigit;
        await safeUpdate(callSid, {
            status: accepted ? 'whisper_accepted' : 'whisper_rejected',
            whisperAccepted: accepted,
            whisperRejectDigit: rejectedToCallCenter ? digits : ''
        }, 'whisper-confirm');
        auditLog('handoff.whisper.completed', {
            actor: 'twilio',
            target: callSid,
            metadata: { accepted }
        });
        return sendTwiml(reply, buildWhisperConfirmTwiml({
            accepted,
            rejectedToCallCenter,
            fallbackMode: config.fallbackMode
        }));
    });

    fastify.post('/handoff/leg-status', async (request, reply) => {
        if (!guard(request, reply)) return reply;
        const callSid = callSidOf(request);

        auditLog('handoff.leg.status', {
            actor: 'twilio',
            target: callSid,
            metadata: {
                callStatus: request.body?.CallStatus || '',
                dialCallStatus: request.body?.DialCallStatus || '',
                duration: request.body?.DialCallDuration || ''
            }
        });
        return reply.code(204).send();
    });

    const buildVoicemailResponse = (request, callSid) => buildVoicemailTwiml({
        actionUrl: getPublicUrl(request, `/handoff/voicemail-complete?call_sid=${encodeURIComponent(callSid)}`),
        recordingStatusUrl: getPublicUrl(request, `/handoff/recording-status?call_sid=${encodeURIComponent(callSid)}`),
        maxLengthSeconds: config.voicemailMaxSeconds
    });

    fastify.post('/handoff/dial-status', async (request, reply) => {
        if (!guard(request, reply)) return reply;
        const callSid = callSidOf(request);

        let context = null;
        try {
            context = await contextStore.get(callSid);
        } catch (error) {
            console.error('Failed to load handoff dial context:', error.message);
        }
        const whisperRejected = context?.status === 'whisper_rejected';
        const dialCallStatus = request.body?.DialCallStatus || '';
        const connected = isHandoffCallConnected(dialCallStatus, context);
        let responseTwiml;

        if (connected) {
            await safeUpdate(callSid, { status: 'connected', dialCallStatus: 'completed' }, 'connected');
            responseTwiml = buildDialStatusTwiml({ connected: true });
        } else if (config.fallbackMode === 'voicemail') {
            await safeUpdate(callSid, {
                status: 'voicemail_started',
                dialCallStatus,
                callerNumber: String(request.body?.From || '')
            }, 'voicemail-start');
            responseTwiml = buildVoicemailResponse(request, callSid);
        } else {
            await safeEnqueue({
                kind: 'handoff-fallback',
                callId: callSid,
                subject: `【電話受付】担当者不応答 ${callSid}`,
                text: [
                    '担当者への転送が成立しませんでした。',
                    context?.summary ? `受付内容: ${context.summary}` : '受付内容は管理画面で確認してください。',
                    '通話はコールセンターへ戻り、残りの情報を確認して受付を完了します。'
                ].join('\n')
            }, 'handoff fallback');
            await safeUpdate(callSid, { status: 'fallback_returned', dialCallStatus }, 'fallback');
            responseTwiml = buildMediaStreamTwimlWithParams({
                host: request.headers.host,
                from: request.body?.From || '',
                to: request.body?.To || '',
                handoffFallback: true,
                introMessage: '担当者におつなぎできなかったため、引き続きコールセンターでご用件を確認いたします。',
                streamToken: createStreamToken({ callSid })
            });
        }

        auditLog('handoff.dial.completed', {
            actor: 'twilio',
            target: callSid,
            metadata: {
                dialCallStatus,
                connected,
                whisperRejected,
                outcome: connected ? 'connected' : config.fallbackMode
            }
        });
        return sendTwiml(reply, responseTwiml);
    });

    fastify.post('/handoff/voicemail-complete', async (request, reply) => {
        if (!guard(request, reply)) return reply;
        const callSid = callSidOf(request);
        const duration = parseDuration(request.body?.RecordingDuration);

        // A caller who stayed silent never produces a usable recording, so the
        // recording-status notification will not fire. The team still needs to
        // know a transfer failed and who called.
        if (!duration) {
            const context = await contextStore.get(callSid).catch(() => null);
            const callerNumber = context?.callerNumber || request.body?.From || '';
            await safeEnqueue({
                kind: 'voicemail-empty',
                callId: callSid,
                subject: `【電話受付】転送不成立・留守電なし ${callSid}`,
                text: [
                    '転送先の担当者が対応できず、発信者は留守番電話に入りましたが、メッセージは録音されませんでした。',
                    '',
                    `通話ID: ${callSid || '未確認'}`,
                    `発信者番号（Twilio）: ${callerNumber || '非通知／取得不可'}`,
                    `転送理由: ${context?.reason || '未確認'}`,
                    `転送前のAI受付の要約: ${context?.whisperSummary || context?.summary || '未確認'}`
                ].join('\n')
            }, 'voicemail empty');
            await safeUpdate(callSid, { status: 'voicemail_empty' }, 'voicemail-empty');
        }
        auditLog('handoff.voicemail.completed', {
            actor: 'twilio',
            target: callSid,
            metadata: { durationSeconds: duration ?? 0 }
        });
        return sendTwiml(reply, buildVoicemailThanksTwiml());
    });

    fastify.post('/handoff/recording-status', async (request, reply) => {
        if (!guard(request, reply)) return reply;
        const callSid = callSidOf(request);
        const body = request.body || {};
        const recordingSid = String(body.RecordingSid || '');
        const recordingUrl = String(body.RecordingUrl || '');

        if (String(body.RecordingStatus || 'completed') !== 'completed') return reply.code(204).send();
        if (!isRecordingSid(recordingSid) || !parseTwilioRecordingUrl(recordingUrl)) {
            auditLog('handoff.voicemail.rejected', {
                actor: 'twilio',
                target: callSid,
                result: 'failure',
                metadata: { reason: 'invalid_recording_reference' }
            });
            return reply.code(400).send({ error: 'invalid_recording_reference' });
        }

        const context = await contextStore.get(callSid).catch(() => null);
        if (context?.voicemailRecordingSid === recordingSid) return reply.code(204).send();

        const durationSeconds = parseDuration(body.RecordingDuration);
        let transcript = '';
        let transcriptFailure = '';
        if (config.voicemailTranscribeEnabled && openAiApiKey && twilioAuthToken) {
            const recording = await fetchTwilioRecording({
                recordingUrl,
                authToken: twilioAuthToken,
                fetchImpl
            });
            if (recording.ok) {
                const result = await transcribeVoicemail({
                    audio: recording.audio,
                    apiKey: openAiApiKey,
                    model: transcriptionModel,
                    fetchImpl
                });
                if (result.ok) transcript = result.text;
                else transcriptFailure = `transcription_${result.reason}`;
            } else {
                transcriptFailure = `recording_${recording.reason}`;
            }
        } else {
            transcriptFailure = 'transcription_disabled';
        }

        const email = buildVoicemailEmail({
            callSid,
            callerNumber: context?.callerNumber || '',
            context: context || {},
            recordingSid,
            durationSeconds,
            recordingLink: getPublicUrl(
                request,
                `/api/admin/voicemails/${encodeURIComponent(recordingSid)}?call_sid=${encodeURIComponent(callSid)}`
            ),
            transcript,
            transcriptFailure
        });
        const notify = await safeEnqueue({
            kind: 'voicemail',
            callId: callSid,
            subject: email.subject,
            text: email.text
        }, 'voicemail');
        await safeUpdate(callSid, {
            status: 'voicemail_recorded',
            voicemailRecordingSid: recordingSid,
            voicemailRecordingUrl: recordingUrl,
            voicemailDurationSeconds: durationSeconds,
            voicemailTranscribed: Boolean(transcript),
            voicemailNotified: notify?.ok === true
        }, 'voicemail-recorded');
        auditLog('handoff.voicemail.recorded', {
            actor: 'twilio',
            target: callSid,
            metadata: {
                durationSeconds,
                transcribed: Boolean(transcript),
                notified: notify?.ok === true
            }
        });
        return reply.code(204).send();
    });

    fastify.get('/api/admin/voicemails/:recordingSid', {
        ...(adminPreHandler ? { preHandler: adminPreHandler } : {})
    }, async (request, reply) => {
        const recordingSid = String(request.params?.recordingSid || '');
        const callSid = String(request.query?.call_sid || '');
        if (!isRecordingSid(recordingSid) || !CALL_SID_PATTERN.test(callSid)) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        const context = await contextStore.get(callSid).catch(() => null);
        if (!context || context.voicemailRecordingSid !== recordingSid) {
            return reply.code(404).send({ error: 'voicemail_not_found' });
        }
        const recording = await fetchTwilioRecording({
            recordingUrl: context.voicemailRecordingUrl,
            authToken: twilioAuthToken,
            timeoutMs: 15000,
            fetchImpl
        });
        auditLog('admin.voicemail.accessed', {
            actor: request.adminAuth?.actor || 'admin',
            target: recordingSid,
            result: recording.ok ? 'success' : 'failure',
            metadata: { reason: recording.reason || '' }
        });
        if (!recording.ok) return reply.code(502).send({ error: 'recording_unavailable', reason: recording.reason });
        return reply.type('audio/mpeg').header('Cache-Control', 'private, no-store').send(recording.audio);
    });
}
