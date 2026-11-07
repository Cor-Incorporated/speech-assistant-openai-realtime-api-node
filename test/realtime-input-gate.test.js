import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildRealtimeInputGateConfig,
    evaluateRealtimeInputTranscript
} from '../lib/realtime-input-gate.js';

test('realtime input gate rejects low-signal transcripts seen in noisy calls', () => {
    const config = buildRealtimeInputGateConfig();

    for (const transcript of ['Itimut', 'Hi.', 'Bボタン。', 'Ete.', 'Sure.', '。', 'Teithio.', 'Kau.']) {
        const result = evaluateRealtimeInputTranscript(transcript, config);
        assert.equal(result.accepted, false, transcript);
    }
});

test('realtime input gate accepts meaningful Japanese, phone digits, and configured terms', () => {
    const config = buildRealtimeInputGateConfig({
        REALTIME_INPUT_GATE_ALLOWED_TERMS: 'PC,Wi-Fi'
    });

    for (const transcript of [
        'めちゃ壊れた。',
        'いや、パソコンが壊れたんで対応したいんですけど。',
        '織部安兵衛でお願いします。',
        '98765311',
        '明日',
        'PC'
    ]) {
        const result = evaluateRealtimeInputTranscript(transcript, config);
        assert.equal(result.accepted, true, transcript);
    }
});

test('realtime input gate requires boundaries around allowed Latin terms', () => {
    const config = buildRealtimeInputGateConfig({});
    for (const transcript of ['password', 'machine', 'Macaroni', 'rpc', 'Swordfish', 'some_word']) {
        assert.equal(evaluateRealtimeInputTranscript(transcript, config).accepted, false, transcript);
    }
    for (const transcript of ['PC', 'pc?', 'Wi-Fi', 'a Mac', 'Word.', 'PCが']) {
        assert.equal(evaluateRealtimeInputTranscript(transcript, config).accepted, true, transcript);
    }
    const literalConfig = buildRealtimeInputGateConfig({ REALTIME_INPUT_GATE_ALLOWED_TERMS: 'C++' });
    assert.equal(evaluateRealtimeInputTranscript('C++', literalConfig).accepted, true);
    assert.equal(evaluateRealtimeInputTranscript('ABC++', literalConfig).accepted, false);
});

test('realtime input gate can be disabled by environment', () => {
    const config = buildRealtimeInputGateConfig({
        REALTIME_INPUT_GATE_ENABLED: 'false'
    });

    const result = evaluateRealtimeInputTranscript('Hi.', config);
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'gate_disabled');
});
