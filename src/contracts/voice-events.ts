// Provider-agnostic voice events surfaced by a VoiceSessionPort.
// These are the application's own contracts — not Realtime or Live wire types.
// A "turn completed" event means generation finished; it never means the audio
// reached the caller's ear (that is PlaybackController's job via Twilio marks).

export type VoiceProvider = 'realtime' | 'live';

export interface ToolCallEvent {
    callId: string;
    name: string;
    /** Raw JSON string as emitted by the provider; validated before use. */
    rawArguments: string;
}

/**
 * Live delegation request. The payload is deliberately opaque — the delegation
 * event carries an ID and offset, not the task text or tool arguments. The
 * application reconstructs context from its own transcript timeline.
 */
export interface DelegationCreatedEvent {
    delegationId: string;
    offsetMs: number;
    target: 'client' | 'responses';
}

export type VoiceEvent =
    | { type: 'session_ready'; provider: VoiceProvider }
    | { type: 'user_speech_started' }
    | { type: 'user_speech_stopped' }
    | { type: 'user_transcript_delta'; delta: string }
    | { type: 'user_transcript_completed'; text: string }
    | { type: 'assistant_audio_delta'; audioBase64: string }
    | { type: 'assistant_transcript_delta'; delta: string }
    | { type: 'assistant_turn_completed' }
    | { type: 'tool_call'; call: ToolCallEvent }
    | { type: 'delegation_created'; delegation: DelegationCreatedEvent }
    | { type: 'provider_error'; message: string; recoverable: boolean }
    | { type: 'provider_closed'; code: number; reason: string };

export type VoiceSessionPhase =
    | 'connecting'
    | 'listening'
    | 'working'
    | 'speaking'
    | 'confirming'
    | 'closing_prepared'
    | 'closing_playing'
    | 'closing_played'
    | 'ended'
    | 'handoff_prepared'
    | 'handoff_starting'
    | 'handoff_connected'
    | 'handoff_failed';

export interface VoiceSessionConfig {
    model: string;
    voice: string;
    instructions: string;
    /** e.g. 'audio/pcmu' at 8000 for G.711 μ-law passthrough with Twilio. */
    inputAudioFormat: string;
    inputAudioRate: number;
    outputAudioFormat: string;
    outputAudioRate: number;
}

export type VoiceSessionStartResult =
    | { ok: true }
    | { ok: false; reason: string; retryable: boolean };

/**
 * Port between the telephony/playback layer and a voice provider session.
 * Implementations: RealtimeAdapter (compat, default), LiveAdapter (flagged).
 */
export interface VoiceSessionPort {
    readonly provider: VoiceProvider;
    start(config: VoiceSessionConfig): Promise<VoiceSessionStartResult>;
    /** Send one outbound audio chunk toward the provider (caller audio in). */
    sendAudio(audioBase64: string): boolean;
    sendToolResult(callId: string, output: Record<string, unknown>): void;
    /** Ask the provider to produce an assistant turn (delegated work done). */
    requestResponse(reason: string): void;
    /** Cancel in-progress generation and queued playback on barge-in. */
    interrupt(): void;
    close(code?: number, reason?: string): void;
    onEvent(handler: (event: VoiceEvent) => void): void;
}
