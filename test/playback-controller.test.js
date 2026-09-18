import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackController } from '../dist-backend/telephony/playback-controller.js';

test('mark arriving after clear is cleared, never played (FAULT-001)', () => {
    const controller = new PlaybackController();

    // Closing audio queued in epoch N, mark sent, then a clear (barge-in)
    // flushes the buffer — Twilio still echoes the mark back.
    controller.enqueueAudio(160);
    controller.sendMark('end_call_1');
    controller.clear();

    const receipt = controller.onMark('end_call_1');
    assert.equal(receipt.disposition, 'cleared');
    assert.equal(controller.closingPlaybackStatus('end_call_1'), 'cleared');
});

test('mark played in the same epoch confirms playback', () => {
    const controller = new PlaybackController();
    controller.enqueueAudio(160);
    controller.sendMark('end_call_2');

    const receipt = controller.onMark('end_call_2');
    assert.equal(receipt.disposition, 'played');
    assert.equal(controller.closingPlaybackStatus('end_call_2'), 'played');
});

test('late mark for an old epoch does not flip to played', () => {
    const controller = new PlaybackController();
    controller.sendMark('closing_1');
    controller.clear();
    controller.clear();

    const receipt = controller.onMark('closing_1');
    assert.equal(receipt.disposition, 'cleared');
    assert.equal(controller.closingPlaybackStatus('closing_1'), 'cleared');
});

test('marks we never sent are unknown', () => {
    const controller = new PlaybackController();
    const receipt = controller.onMark('stray_mark');
    assert.equal(receipt.disposition, 'unknown');
    assert.equal(controller.closingPlaybackStatus('stray_mark'), 'unknown');
});

test('pending mark reports waiting — hangup stays pending', () => {
    const controller = new PlaybackController();
    controller.sendMark('end_call_3');
    assert.equal(controller.closingPlaybackStatus('end_call_3'), 'waiting');
});

test('a new mark after clear can be played independently', () => {
    const controller = new PlaybackController();
    controller.sendMark('cleared_mark');
    controller.clear();

    controller.enqueueAudio(160);
    controller.sendMark('fresh_mark');
    assert.equal(controller.onMark('fresh_mark').disposition, 'played');
    assert.equal(controller.onMark('cleared_mark').disposition, 'cleared');
});
