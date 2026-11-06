// Twilio final outcomes can arrive before or after the Media Stream closes.
// Always reread shared context; the v2 projector preserves terminal states
// and merges a later extraction using repository version checks.
export function createHandoffOutcomeHandler({ contextStore, notificationOutbox, projectCall }) {
    return async (callSid) => {
        const context = await contextStore.get(callSid);
        if (!context) return;
        const connected = context.status === 'connected' && context.whisperAccepted === true;
        const voicemail = ['voicemail_empty', 'voicemail_recorded'].includes(context.status);
        if (!connected && !voicemail) return;

        let notified = context.voicemailNotified === true || context.handoffNotified === true;
        if (connected) {
            // Stable kind/callId is the outbox's durable idempotency identity.
            let result;
            try {
                result = await notificationOutbox.enqueue({
                    kind: 'handoff-connected', callId: callSid,
                    subject: `【電話受付】担当者への接続成立 ${callSid}`,
                    text: [
                        '担当者が1を押して応答を承諾し、転送通話が終了しました。',
                        `通話ID: ${callSid}`,
                        `発信者番号（Twilio）: ${context.callerNumber || '非通知／取得不可'}`,
                        `要約: ${context.whisperSummary || context.summary || '未確認'}`,
                        `転送理由: ${context.reason || '未確認'}`
                    ].join('\n')
                });
            } catch (error) {
                console.error('Failed to notify connected handoff:', error.message);
            }
            notified ||= result?.ok === true;
            if (notified) await contextStore.update(callSid, { handoffNotified: true }).catch((error) => {
                console.error('Failed to save handoff notification status:', error.message);
            });
        }
        return projectCall({
            callId: callSid, transportState: 'ended',
            startedAt: context.createdAt || null, endedAt: new Date().toISOString(),
            durationSeconds: null, fromNumberMasked: context.from || null, toNumberMasked: context.to || null,
            callbackRequired: !connected, outcome: connected ? 'transferred' : 'failed',
            severity: { urgency: 'high', importance: 'high', humanRequested: true },
            handoff: {
                requested: true, destination: context.destination || null,
                outcome: connected ? 'connected' : context.whisperAccepted === false ? 'rejected'
                    : context.dialCallStatus === 'failed' ? 'failed' : 'timeout',
                reason: context.reason || null
            },
            notificationSent: notified
        });
    };
}
