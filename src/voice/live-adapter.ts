// LiveAdapter — GPT-Live voice session behind an experiment flag.
// Real API connectivity is NOT verified yet, so the adapter validates its
// configuration, exposes the wire contract it will speak, and reports a
// structured 'unavailable' instead of pretending to connect. Event names are
// kept as constants pending verification against the official Live docs —
// do not assume Realtime event names carry over.

import type {
    VoiceEvent,
    VoiceProvider,
    VoiceSessionConfig,
    VoiceSessionPort,
    VoiceSessionStartResult
} from '../contracts/voice-events.js';

/** Live wire event names as documented for the client-delegation profile. */
export const LIVE_EVENTS = {
    inputAudioAppend: 'session.input_audio.append',
    outputAudioDelta: 'session.output_audio.delta',
    delegationCreated: 'session.delegation.created',
    commentaryAppend: 'session.commentary.append'
} as const;

export interface LiveAdapterOptions {
    enabled: boolean;
    model: string;
}

export type LiveStartFailure =
    | 'live_disabled'
    | 'live_model_unconfigured'
    | 'live_api_not_verified';

export class LiveAdapter implements VoiceSessionPort {
    readonly provider: VoiceProvider = 'live';
    private handler: (event: VoiceEvent) => void = () => {};

    constructor(private readonly options: LiveAdapterOptions) {}

    onEvent(handler: (event: VoiceEvent) => void): void {
        this.handler = handler;
    }

    /** The μ-law passthrough contract shared with Twilio Media Streams. */
    describeAudioContract(): { format: string; rateHz: number } {
        return { format: 'audio/pcmu', rateHz: 8000 };
    }

    /**
     * Validate the requested session config against the Live contract.
     * Returns the failure reason or null when the config is acceptable.
     */
    validateConfig(config: VoiceSessionConfig): LiveStartFailure | null {
        if (!this.options.enabled) return 'live_disabled';
        if (!this.options.model || this.options.model !== config.model) {
            return 'live_model_unconfigured';
        }
        return null;
    }

    start(config: VoiceSessionConfig): Promise<VoiceSessionStartResult> {
        const failure = this.validateConfig(config);
        if (failure) {
            return Promise.resolve({ ok: false, reason: failure, retryable: failure === 'live_model_unconfigured' });
        }
        // BLOCKED: real API verification outstanding — never fake a session.
        return Promise.resolve({ ok: false, reason: 'live_api_not_verified', retryable: false });
    }

    sendAudio(_audioBase64: string): boolean {
        return false;
    }

    sendToolResult(_callId: string, _output: Record<string, unknown>): void {}

    requestResponse(_reason: string): void {}

    interrupt(): void {}

    close(_code?: number, _reason?: string): void {}
}
