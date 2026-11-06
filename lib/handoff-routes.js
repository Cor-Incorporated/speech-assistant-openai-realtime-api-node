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
    onHandoffOutcome = async () => {},
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
            return await contextStore.update(callSid, patch);
        } catch (error) {
            console.error(`Failed to update handoff context (${label}):`, error.message);
            return false;
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
    const reportOutcome = async (callSid, patch) => {
        try {
            await onHandoffOutcome(callSid, patch);
        } catch (error) {
            console.error('Failed to project handoff outcome:', error.message);
            auditLog('handoff.outcome.failed', { actor: 'system', target: callSid, result: 'failure' });
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
        // Twilio retries only connection failures by default. The fragment is
        // a delivery override (not part of the URL used for signature checks).
        recordingStatusUrl: `${getPublicUrl(request, `/handoff/recording-status?call_sid=${encodeURIComponent(callSid)}`)}#rc=2&rp=ct,rt,5xx`,
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
        // A delayed retry must not restart recording or regress a terminal
        // result after the recording callback has already completed it.
        if (['connected', 'voicemail_recorded', 'voicemail_empty'].includes(context?.status)) {
            await reportOutcome(callSid, { status: context.status, voicemailNotified: context.voicemailNotified === true });
            return sendTwiml(reply, buildDialStatusTwiml({ connected: true }));
        }
        const whisperRejected = context?.status === 'whisper_rejected';
        const dialCallStatus = request.body?.DialCallStatus || '';
        const connected = isHandoffCallConnected(dialCallStatus, context);
        let responseTwiml;

        if (connected) {
            const persisted = await safeUpdate(callSid, { status: 'connected', dialCallStatus: 'completed' }, 'connected');
            if (persisted) {
                await reportOutcome(callSid, { status: persisted.status, dialCallStatus: persisted.dialCallStatus });
            }
            responseTwiml = buildDialStatusTwiml({ connected: true });
        } else if (config.fallbackMode === 'voicemail') {
            const persisted = await safeUpdate(callSid, {
                status: 'voicemail_started',
                dialCallStatus,
                callerNumber: String(request.body?.From || context?.callerNumber || '')
            }, 'voicemail-start');
            if (persisted) await reportOutcome(callSid, { status: persisted.status, dialCallStatus: persisted.dialCallStatus });
            responseTwiml = ['connected', 'voicemail_recorded', 'voicemail_empty'].includes(persisted?.status)
                ? buildDialStatusTwiml({ connected: true })
                : buildVoicemailResponse(request, callSid);
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

        // action runs before silence trimming completes. Only the terminal
        // recording callback (completed/absent) decides which email to send.
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
        const recordingStatus = String(body.RecordingStatus || 'completed');
        const absent = recordingStatus === 'absent';
        const parsedRecording = parseTwilioRecordingUrl(recordingUrl);

        if (!['completed', 'absent'].includes(recordingStatus)) return reply.code(204).send();
        if (!CALL_SID_PATTERN.test(callSid) || !isRecordingSid(recordingSid)
            || (!absent && (!parsedRecording || parsedRecording.recordingSid !== recordingSid))
            || (body.CallSid && body.CallSid !== callSid)
            || (parsedRecording && body.AccountSid && parsedRecording.accountSid !== body.AccountSid)) {
            auditLog('handoff.voicemail.rejected', {
                actor: 'twilio',
                target: callSid,
                result: 'failure',
                metadata: { reason: 'invalid_recording_reference' }
            });
            return reply.code(400).send({ error: 'invalid_recording_reference' });
        }

        let context;
        try {
            context = await contextStore.get(callSid);
        } catch {
            return reply.code(503).send({ error: 'handoff_context_unavailable' });
        }
        if (!context) return reply.code(503).send({ error: 'handoff_context_unavailable' });
        if (context.voicemailRecordingSid === recordingSid && context.voicemailNotified === true) {
            await reportOutcome(callSid, { status: context.status, voicemailNotified: true });
            return reply.code(204).send();
        }

        const durationSeconds = parseDuration(body.RecordingDuration);
        const status = absent ? 'voicemail_empty' : 'voicemail_recorded';
        const recordingPatch = {
            status,
            voicemailRecordingSid: recordingSid,
            voicemailRecordingStatus: recordingStatus,
            voicemailRecordingUrl: absent ? '' : recordingUrl,
            voicemailDurationSeconds: durationSeconds
        };
        try {
            // The recipient may open the email immediately. Make its playback
            // link durable before any notification can be accepted.
            await contextStore.update(callSid, recordingPatch);
        } catch {
            return reply.code(503).send({ error: 'voicemail_metadata_unavailable' });
        }
        let transcript = '';
        let transcriptFailure = '';
        if (!absent && config.voicemailTranscribeEnabled && openAiApiKey && twilioAuthToken) {
            const recording = await fetchTwilioRecording({
                recordingUrl,
                authToken: twilioAuthToken,
                timeoutMs: 2000,
                fetchImpl
            });
            if (recording.ok) {
                const result = await transcribeVoicemail({
                    audio: recording.audio,
                    apiKey: openAiApiKey,
                    model: transcriptionModel,
                    timeoutMs: 5000,
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

        const email = absent ? {
            subject: `【電話受付】転送不成立・留守電なし ${callSid}`,
            text: [
                '転送先の担当者が対応できず、発信者は留守番電話に入りましたが、メッセージは録音されませんでした。',
                '',
                `通話ID: ${callSid}`,
                `発信者番号（Twilio）: ${context.callerNumber || '非通知／取得不可'}`,
                `転送理由: ${context.reason || '未確認'}`,
                `転送前のAI受付の要約: ${context.whisperSummary || context.summary || '未確認'}`
            ].join('\n')
        } : buildVoicemailEmail({
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
            text: email.text,
            timeoutMs: 3000
        }, 'voicemail');
        const outcome = { status, voicemailRecordingSid: recordingSid, voicemailNotified: notify?.ok === true };
        try {
            await contextStore.update(callSid, {
                voicemailTranscribed: Boolean(transcript),
                // A slower concurrent attempt must not overwrite a successful
                // delivery with false. The outbox owns delivery idempotency.
                ...(notify?.ok === true ? { voicemailNotified: true } : {})
            });
        } catch {
            return reply.code(503).send({ error: 'voicemail_result_unavailable' });
        }
        await reportOutcome(callSid, outcome);
        auditLog('handoff.voicemail.recorded', {
            actor: 'twilio',
            target: callSid,
            metadata: {
                durationSeconds,
                recordingStatus,
                transcribed: Boolean(transcript),
                notified: notify?.ok === true
            }
        });
        if (notify?.ok !== true) return reply.code(503).send({ error: 'voicemail_notification_pending' });
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
