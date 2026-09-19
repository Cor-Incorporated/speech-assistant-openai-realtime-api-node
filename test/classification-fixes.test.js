import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isCustomerHarassmentCall,
    isEmergencyCall,
    isHandoffCallConnected,
    isNonHandoffBusinessCall,
    isSalesBusinessCall,
    isServiceOutageCall,
    isThirdPartyThreatCall,
    shouldAutoHandoffGeneral
} from '../lib/handoff.js';

const turns = (...texts) => texts.map((text) => ({ role: 'user', text }));

describe('F04 — classification boundary fixes', () => {
    it('does not flag order numbers containing 110/119 as emergency', () => {
        assert.equal(isEmergencyCall(turns('注文番号1103の件で確認したいのですが')), false);
        assert.equal(isEmergencyCall(turns('ID番号11902について')), false);
        // Real emergency numbers still match.
        assert.equal(isEmergencyCall(turns('今すぐ110番に電話してください')), true);
        assert.equal(isEmergencyCall(turns('119番を呼んでください')), true);
    });

    it('negated urgency does not trigger the urgent handoff path', () => {
        assert.equal(shouldAutoHandoffGeneral(turns('急ぎではありませんが、見積の件で確認です')), false);
        assert.equal(shouldAutoHandoffGeneral(turns('至急ではないので大丈夫です')), false);
        // Affirmative urgency still matches.
        assert.equal(shouldAutoHandoffGeneral(turns('至急対応をお願いします')), true);
    });

    it('a service outage report is not sales and not non-handoff business', () => {
        const outage = turns('弊社のシステムが止まっているんですが、至急確認してほしい');
        assert.equal(isServiceOutageCall(outage), true);
        assert.equal(isSalesBusinessCall(outage), false);
        assert.equal(isNonHandoffBusinessCall(outage), false);
        // A genuine pitch still classifies as sales.
        assert.equal(isSalesBusinessCall(turns('弊社の新しいシステムをご紹介したくお電話しました')), true);
    });

    it('a third-party threat report is a victim, not caller harassment', () => {
        const victim = turns('第三者から脅迫されていて相談したいのですが');
        assert.equal(isThirdPartyThreatCall(victim), true);
        assert.equal(isCustomerHarassmentCall(victim), false);
        // A caller who is themselves aggressive still counts as harassment.
        assert.equal(isCustomerHarassmentCall(turns('お前らふざけるな、責任者を出せ')), true);
    });
});

describe('F06 — human acknowledgment, not notification', () => {
    it('dial completion alone is never "connected"', () => {
        assert.equal(isHandoffCallConnected('completed', null), false);
        assert.equal(isHandoffCallConnected('completed', {}), false);
        assert.equal(isHandoffCallConnected('completed', { status: 'whisper_started' }), false);
        assert.equal(isHandoffCallConnected('completed', { status: 'whisper_rejected' }), false);
        // Only an explicit whisper acceptance proves a human took over.
        assert.equal(isHandoffCallConnected('completed', { whisperAccepted: true }), true);
    });
});
