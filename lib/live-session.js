// GPT-Live (wss://api.openai.com/v1/live/sessions) session helpers.
// The Live protocol is separate from the Realtime API: the voice model handles
// speech while business reasoning and tool selection run in a delegated
// Responses backend. This module owns wire-format concerns only; call-flow
// decisions stay in index.js.

export const LIVE_WS_URL = 'wss://api.openai.com/v1/live/sessions';

export const LIVE_AUDIO_PCMU = 'audio/pcmu';
export const LIVE_AUDIO_PCM = 'audio/pcm';

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_SEG_UEND = [0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF, 0x3FFF, 0x7FFF];

// G.711 μ-law codec. Needed when the Live session runs on linear PCM while
// Twilio Media Streams stay on μ-law 8 kHz.
export function mulawDecodeSample(uValue) {
    const u = ~uValue & 0xFF;
    let t = ((u & 0x0F) << 3) + MULAW_BIAS;
    t <<= (u & 0x70) >> 4;
    return (u & 0x80) ? (MULAW_BIAS - t) : (t - MULAW_BIAS);
}

export function mulawEncodeSample(sample) {
    let s = sample;
    let mask;
    if (s < 0) {
        s = MULAW_BIAS - s;
        mask = 0x7F;
    } else {
        s += MULAW_BIAS;
        mask = 0xFF;
    }
    if (s > MULAW_CLIP + MULAW_BIAS) s = MULAW_CLIP + MULAW_BIAS;

    let segment = 0;
    while (segment < 8 && s > MULAW_SEG_UEND[segment]) segment += 1;
    if (segment >= 8) return 0x7F ^ mask;

    const uVal = (segment << 4) | ((s >> (segment + 3)) & 0x0F);
    return uVal ^ mask;
}

export function mulawToPcm16(mulawBuffer) {
    const pcm = Buffer.alloc(mulawBuffer.length * 2);
    for (let i = 0; i < mulawBuffer.length; i += 1) {
        pcm.writeInt16LE(mulawDecodeSample(mulawBuffer[i]), i * 2);
    }
    return pcm;
}

export function pcm16ToMulaw(pcmBuffer) {
    const mulaw = Buffer.alloc(Math.floor(pcmBuffer.length / 2));
    for (let i = 0; i < mulaw.length; i += 1) {
        mulaw[i] = mulawEncodeSample(pcmBuffer.readInt16LE(i * 2));
    }
    return mulaw;
}

export function buildLiveSessionStart({
    model,
    voice,
    audioFormatType,
    audioRate,
    instructions,
    delegationResponses,
    eventId = 'session_start_1'
}) {
    const session = {
        model,
        instructions,
        audio: {
            format: { type: audioFormatType, rate: audioRate },
            output: { voice }
        }
    };
    if (delegationResponses) {
        session.delegation = {
            type: 'responses',
            responses: delegationResponses
        };
    }
    return { type: 'session.start', event_id: eventId, session };
}

// Normalizes a Live wire event into the kinds index.js acts on. Unknown types
// return 'other' so new Live events never break the dispatch.
export function classifyLiveEvent(event) {
    const type = event?.type || '';
    switch (type) {
        case 'session.started':
            return { kind: 'started', session: event.session };
        case 'session.updated':
            return { kind: 'updated', session: event.session };
        case 'session.closed':
            return { kind: 'closed', usage: event.usage };
        case 'session.output_audio.delta':
            return { kind: 'audio_delta', delta: event.delta };
        case 'session.input_transcript.delta':
            return { kind: 'input_transcript_delta', delta: event.delta, startMs: event.start_ms, endMs: event.end_ms };
        case 'session.output_transcript.delta':
            return { kind: 'output_transcript_delta', delta: event.delta, startMs: event.start_ms, endMs: event.end_ms };
        case 'session.delegation.created': {
            // Observed wire shape: {delegation: {id, response_id, target}}.
            const delegation = event.delegation || {};
            return {
                kind: 'delegation_created',
                delegationId: delegation.id || event.delegation_id || '',
                target: delegation.target || '',
                responseId: delegation.response_id || ''
            };
        }
        case 'response.event':
            return { kind: 'response_event', delegationId: event.delegation_id || '', nested: event.event || {} };
        case 'session.instructions.appended':
        case 'session.thinking.appended':
        case 'session.commentary.appended':
            return { kind: 'append_ack', type, clientEventId: event.client_event_id || '' };
        case 'error':
            return { kind: 'error', error: event.error || event };
        default:
            return { kind: 'other', type };
    }
}

// Tracks delegated Responses work across `response.event` envelopes.
// Live forwards lifecycle snapshots with an empty `response.output`; completed
// function calls must be collected from `response.output_item.done`. Those
// nested events carry no response_id — the envelope `delegation_id` scopes them.
export function createLiveDelegationTracker() {
    const pending = new Map();

    return {
        observeResponseEvent(delegationId, nested) {
            const nestedType = nested?.type || '';
            if (!delegationId) return null;
            if (!pending.has(delegationId)) {
                pending.set(delegationId, { responseId: '', calls: [] });
            }
            const entry = pending.get(delegationId);

            if (nestedType === 'response.created') {
                entry.responseId = nested.response?.id || entry.responseId;
                return null;
            }

            if (nestedType === 'response.output_item.done' && nested.item?.type === 'function_call') {
                entry.calls.push({
                    type: 'function_call',
                    call_id: nested.item.call_id || '',
                    name: nested.item.name || '',
                    arguments: nested.item.arguments || ''
                });
                return null;
            }

            if (['response.completed', 'response.failed', 'response.incomplete'].includes(nestedType)) {
                pending.delete(delegationId);
                return {
                    delegationId,
                    responseId: entry.responseId || nested.response?.id || '',
                    status: nestedType,
                    calls: entry.calls
                };
            }
            return null;
        },
        pendingCount() {
            return pending.size;
        }
    };
}

// Live function calls carry call_id/name/arguments identical to Realtime output
// items; wrap them in the `response.done` shape handleRealtimeToolCalls expects.
export function toRealtimeDoneEvent(functionCalls) {
    return {
        type: 'response.done',
        response: { output: functionCalls }
    };
}

// handleRealtimeToolCalls emits Realtime `conversation.item.create` envelopes;
// Live expects the bare item through `response.item.create`.
export function toLiveToolResultItem(outputItem) {
    if (outputItem?.type !== 'conversation.item.create' || !outputItem.item) return null;
    return outputItem.item;
}

export function liveAudioAppend(audioBase64) {
    return { type: 'session.input_audio.append', audio: audioBase64 };
}

export function liveItemCreate(item, eventId) {
    return { type: 'response.item.create', event_id: eventId, item };
}

export function liveResponseCreate(eventId) {
    return { type: 'response.create', event_id: eventId };
}

export function liveCommentaryAppend(content, eventId) {
    return { type: 'session.commentary.append', event_id: eventId, delegation_id: null, content };
}

export function liveSessionClose(eventId) {
    return { type: 'session.close', event_id: eventId };
}

// Converts Twilio μ-law payloads to the configured Live input format, and Live
// output audio back to μ-law for Twilio. Passthrough when formats match.
export function createLiveAudioCodec({ inputFormatType, inputRate }) {
    const passthrough = inputFormatType === LIVE_AUDIO_PCMU && inputRate === 8000;
    return {
        passthrough,
        encodeInput(twilioPayloadBase64) {
            const mulaw = Buffer.from(twilioPayloadBase64, 'base64');
            if (passthrough) return twilioPayloadBase64;
            return mulawToPcm16(mulaw).toString('base64');
        },
        decodeOutput(liveDeltaBase64) {
            if (passthrough) return liveDeltaBase64;
            return pcm16ToMulaw(Buffer.from(liveDeltaBase64, 'base64')).toString('base64');
        }
    };
}
