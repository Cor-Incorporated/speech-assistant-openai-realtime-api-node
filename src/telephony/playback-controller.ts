// PlaybackController — tracks what the caller actually heard.
//
// Twilio Media Streams answers `mark` messages for audio that was played AND
// for audio flushed by a `clear` — a mark alone never proves the caller heard
// the message to the end. We therefore track a playback epoch: each `clear`
// invalidates every outstanding mark of the outgoing epoch, and a mark that
// arrives late for a cleared epoch is recorded as 'cleared', never 'played'.

export type PlaybackDisposition = 'played' | 'cleared' | 'unknown';

export interface PlaybackReceipt {
    epoch: number;
    marker: string;
    disposition: PlaybackDisposition;
}

type MarkStatus = 'pending' | 'played' | 'cleared';

interface MarkRecord {
    epoch: number;
    status: MarkStatus;
}

export type ClosingPlaybackStatus = 'played' | 'cleared' | 'waiting' | 'unknown';

export class PlaybackController {
    private epoch = 0;
    private bytesInEpoch = 0;
    private readonly marks = new Map<string, MarkRecord>();
    /** Marks invalidated by a clear — a late echo stays 'cleared' forever. */
    private readonly invalidatedMarks = new Set<string>();

    get playbackEpoch(): number {
        return this.epoch;
    }

    /** Outbound μ-law bytes queued in the current epoch. */
    enqueueAudio(byteLength: number): void {
        this.bytesInEpoch += byteLength;
    }

    /** Register a marker sent to Twilio in the current epoch. */
    sendMark(marker: string): void {
        this.marks.set(marker, { epoch: this.epoch, status: 'pending' });
    }

    /**
     * A clear was sent to Twilio: pending marks of this epoch are voided and
     * the epoch advances. Any of those marks arriving later must not flip
     * back to 'played'.
     */
    clear(): number {
        for (const [name, record] of this.marks) {
            if (record.status === 'pending' && record.epoch === this.epoch) {
                record.status = 'cleared';
                this.invalidatedMarks.add(name);
            }
        }
        this.epoch += 1;
        this.bytesInEpoch = 0;
        return this.epoch;
    }

    /** A mark message arrived back from Twilio. */
    onMark(marker: string): PlaybackReceipt {
        if (this.invalidatedMarks.has(marker)) {
            const record = this.marks.get(marker);
            return { epoch: record?.epoch ?? this.epoch, marker, disposition: 'cleared' };
        }

        const record = this.marks.get(marker);
        if (!record) {
            return { epoch: this.epoch, marker, disposition: 'unknown' };
        }
        if (record.epoch !== this.epoch || record.status === 'cleared') {
            return { epoch: record.epoch, marker, disposition: 'cleared' };
        }
        if (record.status === 'played') {
            return { epoch: record.epoch, marker, disposition: 'played' };
        }

        record.status = 'played';
        return { epoch: record.epoch, marker, disposition: 'played' };
    }

    /**
     * For the end-of-call marker: did the closing audio provably reach the
     * caller? 'waiting' means no verdict yet — hangup stays pending; 'cleared'
     * or 'unknown' means it did not / cannot be confirmed.
     */
    closingPlaybackStatus(marker: string): ClosingPlaybackStatus {
        const record = this.marks.get(marker);
        if (!record) return 'unknown';
        if (this.invalidatedMarks.has(marker) || record.epoch !== this.epoch) return 'cleared';
        return record.status === 'played' ? 'played' : 'waiting';
    }
}
