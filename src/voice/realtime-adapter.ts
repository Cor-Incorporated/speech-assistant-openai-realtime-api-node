// RealtimeAdapter — maps OpenAI Realtime wire events onto the VoiceEvent
// contract. Protocol parsing lives here, business decisions elsewhere: this
// adapter never decides routing, transfers, or call end.

import type {
    ToolCallEvent,
    VoiceEvent,
    VoiceProvider,
    VoiceSessionConfig,
    VoiceSessionPort,
    VoiceSessionStartResult
} from '../contracts/voice-events.js';

export const REALTIME_TOOL_NAMES = [
    'validate_callback_phone',
    'transfer_to_human',
    'finish_reception'
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const toolCallsFromResponseDone = (message: Record<string, unknown>): ToolCallEvent[] => {
    const response = isRecord(message.response) ? message.response : {};
    const output = Array.isArray(response.output) ? response.output : [];

    const calls: ToolCallEvent[] = [];
    for (const item of output) {
        if (!isRecord(item)) continue;
        if (item.type !== 'function_call' || typeof item.name !== 'string') continue;
        if (typeof item.call_id !== 'string' || !item.call_id) continue;
        calls.push({
            callId: item.call_id,
            name: item.name,
            rawArguments: typeof item.arguments === 'string' ? item.arguments : ''
        });
    }
    return calls;
};

/**
 * Translate one parsed Realtime JSON message into zero or more VoiceEvents.
 * Pure and total — unknown or non-essential messages map to an empty list so
 * forward compatibility is preserved (they are counted by the caller).
 */
export function realtimeMessageToVoiceEvents(message: unknown): VoiceEvent[] {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return [];
    }

    switch (message.type) {
        case 'session.created':
        case 'session.updated':
            return [{ type: 'session_ready', provider: 'realtime' }];

        case 'input_audio_buffer.speech_started':
            return [{ type: 'user_speech_started' }];
        case 'input_audio_buffer.speech_stopped':
            return [{ type: 'user_speech_stopped' }];

        case 'conversation.item.input_audio_transcription.completed': {
            const transcript = typeof message.transcript === 'string' ? message.transcript : '';
            return transcript ? [{ type: 'user_transcript_completed', text: transcript }] : [];
        }

        case 'response.output_audio.delta':
        case 'response.audio.delta': {
            const delta = typeof message.delta === 'string' ? message.delta : '';
            return delta ? [{ type: 'assistant_audio_delta', audioBase64: delta }] : [];
        }

        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta': {
            const delta = typeof message.delta === 'string' ? message.delta : '';
            return delta ? [{ type: 'assistant_transcript_delta', delta }] : [];
        }

        case 'response.done': {
            const events: VoiceEvent[] = [{ type: 'assistant_turn_completed' }];
            for (const call of toolCallsFromResponseDone(message)) {
                events.push({ type: 'tool_call', call });
            }
            return events;
        }

        case 'error': {
            const error = isRecord(message.error) ? message.error : {};
            const text = typeof error.message === 'string' ? error.message : 'realtime_error';
            return [{ type: 'provider_error', message: text, recoverable: false }];
        }

        default:
            return [];
    }
}

/**
 * Compat adapter. Today index.js owns the Realtime socket inline; this class
 * is the seam the orchestrator will drive once the session handling is moved
 * behind the port. It holds no business state.
 */
export class RealtimeAdapter implements VoiceSessionPort {
    readonly provider: VoiceProvider = 'realtime';
    private handler: (event: VoiceEvent) => void = () => {};

    onEvent(handler: (event: VoiceEvent) => void): void {
        this.handler = handler;
    }

    /** Feed one raw Realtime JSON message (already JSON.parsed). */
    dispatch(message: unknown): void {
        for (const event of realtimeMessageToVoiceEvents(message)) {
            this.handler(event);
        }
    }

    start(_config: VoiceSessionConfig): Promise<VoiceSessionStartResult> {
        // Socket lifecycle stays in index.js during the staged migration.
        return Promise.resolve({ ok: false, reason: 'realtime_adapter_not_wired', retryable: false });
    }

    sendAudio(_audioBase64: string): boolean {
        return false;
    }

    sendToolResult(_callId: string, _output: Record<string, unknown>): void {}

    requestResponse(_reason: string): void {}

    interrupt(): void {}

    close(_code?: number, _reason?: string): void {}
}
