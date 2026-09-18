// Contact capture state machine.
// Format validity ("the digits parse as a Japanese phone number") and caller
// confirmation ("the caller said yes to this specific value at this revision")
// are separate facts. A correction always destroys the confirmation.

export type ContactSlotKind = 'callback_phone' | 'caller_name';

export type ContactState =
    | { status: 'missing' }
    | { status: 'refused'; revision: number }
    | { status: 'capturing'; slotRef: string; revision: number }
    | { status: 'format_valid'; slotRef: string; revision: number }
    | { status: 'caller_confirmed'; slotRef: string; revision: number; confirmationRef: string };

export interface PendingConfirmation {
    ref: string;
    slot: ContactSlotKind;
    revision: number;
}

export interface ReceptionStateSnapshot {
    contacts: Record<ContactSlotKind, ContactState>;
    contextRevision: number;
    pendingConfirmation: PendingConfirmation | null;
}

let confirmationCounter = 0;

/**
 * Tracks contact slots (callback phone, caller name) and the conversation's
 * context revision. All revision changes flow through this machine so stale
 * decisions can be detected by comparing revisions.
 */
export class ReceptionStateMachine {
    private contacts: Record<ContactSlotKind, ContactState> = {
        callback_phone: { status: 'missing' },
        caller_name: { status: 'missing' }
    };
    private contextRevision = 0;
    private pendingConfirmation: PendingConfirmation | null = null;

    get revision(): number {
        return this.contextRevision;
    }

    contact(slot: ContactSlotKind): ContactState {
        return this.contacts[slot];
    }

    snapshot(): ReceptionStateSnapshot {
        return {
            contacts: { ...this.contacts },
            contextRevision: this.contextRevision,
            pendingConfirmation: this.pendingConfirmation ? { ...this.pendingConfirmation } : null
        };
    }

    /** Caller changed intent or corrected content — bump the context revision. */
    noteContextChanged(): number {
        this.contextRevision += 1;
        this.pendingConfirmation = null;
        return this.contextRevision;
    }

    /** A first fragment for an empty slot starts capturing. */
    beginCapture(slot: ContactSlotKind, slotRef: string): ContactState {
        this.contextRevision += 1;
        this.contacts[slot] = {
            status: 'capturing',
            slotRef,
            revision: this.contextRevision
        };
        return this.contacts[slot];
    }

    /**
     * More digits/text arrived for a slot already capturing or previously
     * validated — the value is fluid again and any confirmation is void.
     */
    recordFragment(slot: ContactSlotKind, slotRef: string): ContactState {
        this.contextRevision += 1;
        this.pendingConfirmation = null;
        this.contacts[slot] = {
            status: 'capturing',
            slotRef,
            revision: this.contextRevision
        };
        return this.contacts[slot];
    }

    /** Format validation succeeded — the shape is right, not yet confirmed. */
    markFormatValid(slot: ContactSlotKind, slotRef: string): ContactState {
        this.contextRevision += 1;
        this.contacts[slot] = {
            status: 'format_valid',
            slotRef,
            revision: this.contextRevision
        };
        return this.contacts[slot];
    }

    /**
     * The caller explicitly declined to give this slot. Refusal is a
     * policy-level fact, not an invitation to invent or backfill a value.
     */
    markRefused(slot: ContactSlotKind): ContactState {
        this.contextRevision += 1;
        this.pendingConfirmation = null;
        this.contacts[slot] = { status: 'refused', revision: this.contextRevision };
        return this.contacts[slot];
    }

    /**
     * The assistant asked "is this correct?" for a slot at a revision.
     * Confirmation only counts against this pending request — a bare "はい"
     * with no pending question is not approval of anything.
     */
    requestConfirmation(slot: ContactSlotKind): PendingConfirmation | null {
        const state = this.contacts[slot];
        if (state.status !== 'format_valid') {
            return null;
        }
        confirmationCounter += 1;
        this.pendingConfirmation = {
            ref: `confirm_${confirmationCounter}`,
            slot,
            revision: state.revision
        };
        return this.pendingConfirmation;
    }

    /**
     * Caller affirmed the pending confirmation. Fails when there is no pending
     * request, when it targets another slot, or when the slot's revision moved
     * on (correction arrived between question and answer).
     */
    confirm(slot: ContactSlotKind): ContactState | null {
        const pending = this.pendingConfirmation;
        const state = this.contacts[slot];
        if (
            !pending
            || pending.slot !== slot
            || state.status !== 'format_valid'
            || state.revision !== pending.revision
        ) {
            return null;
        }
        this.contacts[slot] = {
            status: 'caller_confirmed',
            slotRef: state.slotRef,
            revision: state.revision,
            confirmationRef: pending.ref
        };
        this.pendingConfirmation = null;
        return this.contacts[slot];
    }

    /** Any correction — explicit or new fragment — returns the slot to capturing. */
    correct(slot: ContactSlotKind, slotRef: string): ContactState {
        return this.recordFragment(slot, slotRef);
    }

    /**
     * May the reception finish on the basis of this slot?
     * `requireConfirmed` mirrors the current policy for callback-required
     * finishes: format validity alone is not enough (FAULT-012).
     */
    canFinishWith(slot: ContactSlotKind, requireConfirmed: boolean): boolean {
        const state = this.contacts[slot];
        if (state.status === 'caller_confirmed') return true;
        if (!requireConfirmed) return state.status !== 'missing';
        return false;
    }
}
