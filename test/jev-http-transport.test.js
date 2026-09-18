import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildSystemOneQuestions,
    JevHttpTransport
} from '../dist-backend/routing/jev-http-transport.js';
import { DEFAULT_JEV_QUESTIONS } from '../dist-backend/routing/jev-classifier.js';

const request = {
    model: 'jev-1.13.0',
    questionVersion: 'jev-questions-0.1',
    contextRevision: 0,
    text: '営業時間を教えてください'
};

const okResponse = (body) => ({
    ok: true,
    status: 200,
    json: async () => body
});

const realWireAnswer = {
    model: 'jev-1.13.0',
    answers: {
        primary_intent: {
            type: 'choice',
            choice: 'general_inquiry',
            probabilities: { general_inquiry: 0.9, unknown: 0.1 },
            confidence: 0.8
        },
        risk_life_safety_emergency: { type: 'noul', noul: 0.01 },
        risk_caller_aggression: { type: 'noul', noul: 0.02 },
        risk_third_party_threat: { type: 'noul', noul: 0.0 },
        risk_urgency: { type: 'noul', noul: 0.1 },
        signal_human_requested: { type: 'noul', noul: 0.0 }
    },
    usage: { input_tokens: 100, output_tokens: 40 }
};

test('request body matches the systemone wire format', async () => {
    let captured;
    const transport = new JevHttpTransport({
        apiKey: 'test-key',
        questions: DEFAULT_JEV_QUESTIONS,
        fetchImpl: async (url, init) => {
            captured = { url, init };
            return okResponse(realWireAnswer);
        }
    });

    await transport.classify(request, AbortSignal.timeout(1000));

    assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'jev-1.13.0');
    assert.equal(body.state, '営業時間を教えてください');
    assert.equal(body.questions.primary_intent.type, 'choice');
    assert.equal(body.questions.risk_urgency.type, 'noul');
    assert.equal(typeof captured.init.signal.aborted, 'boolean');
});

test('choice + noul answers map to JevRawResponse', async () => {
    const transport = new JevHttpTransport({
        apiKey: 'k',
        questions: DEFAULT_JEV_QUESTIONS,
        fetchImpl: async () => okResponse(realWireAnswer)
    });
    const raw = await transport.classify(request, AbortSignal.timeout(1000));

    assert.equal(raw.intent, 'general_inquiry');
    assert.equal(raw.intentProbabilities.general_inquiry, 0.9);
    assert.equal(raw.risks.life_safety_emergency, 0.01);
    assert.equal(raw.risks.urgency, 0.1);
    assert.equal(raw.humanRequested, 0.0);
});

test('429 / 529 / 4xx fail fast with the status, never a sleep', async () => {
    for (const status of [401, 422, 429, 529]) {
        let calls = 0;
        const transport = new JevHttpTransport({
            apiKey: 'k',
            questions: DEFAULT_JEV_QUESTIONS,
            fetchImpl: async () => {
                calls++;
                return { ok: false, status, json: async () => ({}) };
            }
        });
        const started = Date.now();
        await assert.rejects(
            transport.classify(request, AbortSignal.timeout(2000)),
            (error) => error.name === 'JevHttpError' && error.status === status
        );
        assert.ok(Date.now() - started < 500, `${status} must not sleep`);
        assert.equal(calls, 1, `${status} must not retry`);
    }
});

test('malformed 200 bodies are rejected, not coerced', async () => {
    const transport = new JevHttpTransport({
        apiKey: 'k',
        questions: DEFAULT_JEV_QUESTIONS,
        fetchImpl: async () => okResponse({ unexpected: true })
    });
    await assert.rejects(
        transport.classify(request, AbortSignal.timeout(1000)),
        /jev_response_malformed/
    );
});

test('abort propagates to fetch as the caller signal', async () => {
    let seen;
    const transport = new JevHttpTransport({
        apiKey: 'k',
        questions: DEFAULT_JEV_QUESTIONS,
        fetchImpl: (_url, init) => {
            seen = init.signal;
            return new Promise((_resolve, reject) => {
                seen.addEventListener('abort', () => reject(seen.reason));
            });
        }
    });
    const controller = new AbortController();
    const pending = transport.classify(request, controller.signal);
    controller.abort(new Error('caller_cancel'));
    await assert.rejects(pending, /caller_cancel/);
});

test('question builder covers every taxonomy option including unknown', () => {
    const questions = buildSystemOneQuestions(DEFAULT_JEV_QUESTIONS);
    const criteria = questions.primary_intent.criteria;
    for (const intent of [
        'contract_request', 'existing_support', 'billing_complaint',
        'sales_offer', 'recruitment', 'partnership_media',
        'general_inquiry', 'unknown'
    ]) {
        assert.ok(criteria[intent], intent);
    }
});
