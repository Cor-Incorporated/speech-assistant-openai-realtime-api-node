import { isComplaintCall, isComplexSupportCall, isCustomerHarassmentCall } from './handoff.js';

export const STANDARD_REALTIME_MODEL = 'gpt-realtime-2.1-mini';
export const COMPLEX_REALTIME_MODEL = 'gpt-realtime-2.1';

export function classifyRealtimeConversation(turns = []) {
    if (isCustomerHarassmentCall(turns)) {
        return {
            tier: 'complex_complaint',
            category: 'customer_harassment',
            targetModel: COMPLEX_REALTIME_MODEL,
            humanTransferAllowed: false
        };
    }

    if (isComplexSupportCall(turns)) {
        return {
            tier: 'complex_complaint',
            category: 'complex_support',
            targetModel: COMPLEX_REALTIME_MODEL,
            humanTransferAllowed: true
        };
    }

    if (isComplaintCall(turns)) {
        return {
            tier: 'complex_complaint',
            category: 'complaint',
            targetModel: COMPLEX_REALTIME_MODEL,
            humanTransferAllowed: true
        };
    }

    return {
        tier: 'standard',
        category: 'standard',
        targetModel: STANDARD_REALTIME_MODEL,
        humanTransferAllowed: false
    };
}

export function buildComplexRealtimeInstructions(category) {
    if (category === 'customer_harassment') {
        return [
            'これは顧客対応上の高リスクな発言を含む通話です。人間への自動転送は行わず、AIコールセンターとして対応を継続してください。',
            '暴言・脅迫・威圧には反論せず、短く受け止めたうえで、落ち着いた言葉で対応可能な範囲を示してください。',
            '危害を示す発言や攻撃的な発言が続く場合は、必要事項を最小限確認し、これ以上の対応が難しいことを丁寧に伝えて終話してください。transfer_to_humanは使用しないでください。'
        ].join('\n');
    }

    return [
        'これは苦情・クレーム・支払いトラブル・契約紛争・法務相談・情報セキュリティ事故など、判断の精度が必要な相談です。AI受付を継続し、事実関係、相手の希望、緊急性を一つずつ確認してください。',
        '苦情や支払いトラブルだけを理由に担当者へ転送してはいけません。人間による判断・謝罪・補償判断・事実確認が必要か、または発信者が明確に担当者対応を求めているかを整理してください。法務・個人情報・セキュリティに関する相談は、事実を断定せず、必要に応じてgeneralへ転送してください。',
        '人間の判断が必要だと判断した場合だけtransfer_to_humanをdestination="general"で使用してください。発信者には内部の分類や判断理由を説明しないでください。'
    ].join('\n');
}
