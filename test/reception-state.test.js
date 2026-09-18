import assert from 'node:assert/strict';
import test from 'node:test';
import { ReceptionStateMachine } from '../dist-backend/domain/reception-state.js';

test('format_valid alone does not satisfy a confirmation-required finish (FAULT-012)', () => {
    const state = new ReceptionStateMachine();

    state.beginCapture('callback_phone', '090...');
    state.markFormatValid('callback_phone', '09012345678');

    assert.equal(state.contact('callback_phone').status, 'format_valid');
    assert.equal(state.canFinishWith('callback_phone', true), false);
});

test('confirmation requires a pending question — bare "はい" is not approval', () => {
    const state = new ReceptionStateMachine();
    state.beginCapture('callback_phone', '090...');
    state.markFormatValid('callback_phone', '09012345678');

    // No confirmation requested yet — confirm() must not succeed.
    assert.equal(state.confirm('callback_phone'), null);
    assert.equal(state.contact('callback_phone').status, 'format_valid');

    const pending = state.requestConfirmation('callback_phone');
    assert.ok(pending);

    const confirmed = state.confirm('callback_phone');
    assert.equal(confirmed?.status, 'caller_confirmed');
    assert.equal(state.canFinishWith('callback_phone', true), true);
});

test('correction after confirmation destroys the confirmation (JA-027)', () => {
    const state = new ReceptionStateMachine();
    state.beginCapture('callback_phone', '090...');
    state.markFormatValid('callback_phone', '09012345678');
    state.requestConfirmation('callback_phone');
    state.confirm('callback_phone');
    assert.equal(state.contact('callback_phone').status, 'caller_confirmed');

    // Caller says "すみません、最後の数字が違います" — the slot reopens.
    state.correct('callback_phone', '0901234');

    const contact = state.contact('callback_phone');
    assert.equal(contact.status, 'capturing');
    assert.equal(state.canFinishWith('callback_phone', true), false);
});

test('correction between question and answer invalidates the pending confirmation', () => {
    const state = new ReceptionStateMachine();
    state.beginCapture('callback_phone', '090...');
    state.markFormatValid('callback_phone', '09012345678');
    state.requestConfirmation('callback_phone');

    state.recordFragment('callback_phone', '09012340');
    state.markFormatValid('callback_phone', '09012340000');

    // The "はい" now refers to a stale pending question — must not confirm.
    assert.equal(state.confirm('callback_phone'), null);
});

test('declined contact is recorded, not backfilled (JA-029)', () => {
    const state = new ReceptionStateMachine();

    state.markRefused('callback_phone');

    assert.equal(state.contact('callback_phone').status, 'refused');
    assert.equal(state.canFinishWith('callback_phone', true), false);
});

test('context revision tracks every contact mutation', () => {
    const state = new ReceptionStateMachine();
    const r0 = state.revision;

    state.beginCapture('callback_phone', '090');
    state.recordFragment('callback_phone', '0901234');
    state.markFormatValid('callback_phone', '09012345678');
    state.requestConfirmation('callback_phone');
    state.confirm('callback_phone');
    state.noteContextChanged();

    assert.ok(state.revision > r0);
});
