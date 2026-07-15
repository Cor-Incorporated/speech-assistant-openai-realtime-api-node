import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildComplexRealtimeInstructions,
    classifyRealtimeConversation,
    COMPLEX_REALTIME_MODEL,
    STANDARD_REALTIME_MODEL
} from '../lib/realtime-escalation.js';

test('standard, contract, and sales calls stay on realtime mini', () => {
    for (const text of [
        'システム開発を依頼したいので見積もりを相談したいです。',
        '採用支援サービスの営業提案です。',
        'イベント開催について相談したいです。'
    ]) {
        const result = classifyRealtimeConversation([{ role: 'user', text }]);
        assert.equal(result.targetModel, STANDARD_REALTIME_MODEL);
        assert.equal(result.tier, 'standard');
    }
});

test('payment disputes and complaints escalate to realtime 2.1 with human judgment allowed', () => {
    const result = classifyRealtimeConversation([{
        role: 'user',
        text: '業務委託費が1万円足りないので、確認と説明をお願いしたいです。'
    }]);

    assert.equal(result.targetModel, COMPLEX_REALTIME_MODEL);
    assert.equal(result.category, 'complaint');
    assert.equal(result.humanTransferAllowed, true);
    assert.match(buildComplexRealtimeInstructions(result.category), /苦情や支払いトラブルだけを理由に担当者へ転送してはいけません/);
});

test('harassment escalates for careful AI handling but never permits human transfer', () => {
    const result = classifyRealtimeConversation([{
        role: 'user',
        text: 'ふざけるな。何度言わせるんですか。責任者を出せ。'
    }]);

    assert.equal(result.targetModel, COMPLEX_REALTIME_MODEL);
    assert.equal(result.category, 'customer_harassment');
    assert.equal(result.humanTransferAllowed, false);
    assert.match(buildComplexRealtimeInstructions(result.category), /transfer_to_humanは使用しないでください/);
});
