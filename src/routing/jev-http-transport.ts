// Real Jev transport — POST https://api.typesafe.ai/v1/systemone.
// Wire format per the TypeSafe API reference (verified 2026-09-18):
//   request:  {state, model, questions: {id: {type, instructions, criteria}}}
//   response: {model, answers: {id: noul|choice|score answer}, usage}
//   errors:   401 / 422 / 429 / 529 with a JSON body
// This transport never sleeps and never retries — a 429/529 surfaces
// immediately so the audio path is never blocked (FAULT-005). The caller's
// AbortSignal is passed straight to fetch; a deadline abort rejects with the
// signal's TimeoutError, which JevClassifier maps to 'timeout'.

import {
    DEFAULT_JEV_QUESTIONS,
    type JevQuestionSet,
    type JevRawResponse,
    type JevRequest,
    type JevTransport
} from './jev-classifier.js';

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export class JevHttpError extends Error {
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'JevHttpError';
    }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JevHttpTransportOptions {
    apiKey: string;
    /** Defaults to DEFAULT_JEV_QUESTIONS. */
    questions?: JevQuestionSet;
    endpoint?: string;
    /** Injectable for tests — production uses global fetch. */
    fetchImpl?: FetchLike;
}

/** Typed question definitions keyed by the caller-chosen question ids. */
export function buildSystemOneQuestions(questionSet: JevQuestionSet): Record<string, unknown> {
    return {
        [questionSet.intentChoiceId]: {
            type: 'choice',
            instructions: 'この発信者の主たる用件を次の選択肢から1つだけ選んでください',
            criteria: {
                contract_request: '契約・見積もり・導入に関する相談',
                existing_support: '既存サービスの障害・保守・操作方法に関する問い合わせ',
                billing_complaint: '料金・請求・支払いへの不満や確認',
                sales_offer: '商品・サービスの営業・勧誘・提案',
                recruitment: '求職・採用応募・人材紹介に関する連絡',
                partnership_media: '提携・取材・イベントなどの事業提案',
                general_inquiry: '営業時間・所在地・基本的な会社情報への問い合わせ',
                unknown: '上記のいずれにも確実に分類できない'
            }
        },
        [questionSet.riskNoulIds.lifeSafetyEmergency]: {
            type: 'noul',
            instructions: '生命・身体の安全に関わる緊急事態が述べられている'
        },
        [questionSet.riskNoulIds.callerAggression]: {
            type: 'noul',
            instructions: '発信者が暴言・威嚇・攻撃的な態度を取っている'
        },
        [questionSet.riskNoulIds.thirdPartyThreat]: {
            type: 'noul',
            instructions: '第三者からの脅迫・危害が報告されている'
        },
        [questionSet.riskNoulIds.urgency]: {
            type: 'noul',
            instructions: '緊急性・時間制約が明示されている'
        },
        [questionSet.humanRequestedId]: {
            type: 'noul',
            instructions: '発信者が担当者・人間のオペレーターとの通話を明示的に求めている'
        }
    };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export class JevHttpTransport implements JevTransport {
    private readonly endpoint: string;
    private readonly fetchImpl: FetchLike;
    private readonly wireQuestions: Record<string, unknown>;

    constructor(private readonly options: JevHttpTransportOptions) {
        if (!options.apiKey) {
            throw new Error('JevHttpTransport requires an apiKey');
        }
        this.endpoint = options.endpoint ?? JEV_DEFAULT_ENDPOINT;
        this.fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
        this.wireQuestions = buildSystemOneQuestions(options.questions ?? DEFAULT_JEV_QUESTIONS);
    }

    async classify(request: JevRequest, signal: AbortSignal): Promise<JevRawResponse> {
        const response = await this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.options.apiKey}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                state: request.text,
                model: request.model,
                questions: this.wireQuestions
            }),
            signal
        });

        if (!response.ok) {
            // Fast-fail on every non-2xx — including 429/529. Retries are the
            // caller's policy decision, never an in-line sleep here.
            throw new JevHttpError(response.status, `jev_http_${response.status}`);
        }

        const body: unknown = await response.json();
        if (!isRecord(body) || !isRecord(body.answers)) {
            throw new Error('jev_response_malformed');
        }

        return this.mapAnswers(body.answers);
    }

    /** Wire answers → JevRawResponse. Field-level validation stays with
     *  JevClassifier.toDecision — this layer only re-keys the payload. */
    private mapAnswers(answers: Record<string, unknown>): JevRawResponse {
        const raw: JevRawResponse = {};
        const ids = this.options.questions ?? DEFAULT_JEV_QUESTIONS;

        const intentAnswer = answers[ids.intentChoiceId];
        if (isRecord(intentAnswer) && intentAnswer.type === 'choice') {
            if (typeof intentAnswer.choice === 'string') {
                raw.intent = intentAnswer.choice;
            }
            if (isRecord(intentAnswer.probabilities)) {
                raw.intentProbabilities = intentAnswer.probabilities as Record<string, number>;
            }
        }

        const risks: Record<string, number> = {};
        type RiskKey = 'life_safety_emergency' | 'caller_aggression' | 'third_party_threat' | 'urgency';
        const riskPairs: Array<[string, RiskKey]> = [
            [ids.riskNoulIds.lifeSafetyEmergency, 'life_safety_emergency'],
            [ids.riskNoulIds.callerAggression, 'caller_aggression'],
            [ids.riskNoulIds.thirdPartyThreat, 'third_party_threat'],
            [ids.riskNoulIds.urgency, 'urgency']
        ];
        for (const [answerId, flag] of riskPairs) {
            const answer = answers[answerId];
            if (isRecord(answer) && answer.type === 'noul' && typeof answer.noul === 'number') {
                risks[flag] = answer.noul;
            }
        }
        if (Object.keys(risks).length > 0) raw.risks = risks;

        const human = answers[ids.humanRequestedId];
        if (isRecord(human) && human.type === 'noul' && typeof human.noul === 'number') {
            raw.humanRequested = human.noul;
        }

        return raw;
    }
}
