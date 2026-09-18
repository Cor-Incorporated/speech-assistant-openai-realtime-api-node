// Real TypeSafe/Jev API verification — masked synthetic texts only.
//
// Usage:
//   node scripts/verify-jev.js [path-to-.env]
//
// Env: TYPESAFE_API_KEY or JEV_API_KEY (required), JEV_MODEL (default
// jev-1.13.0), JEV_ENDPOINT (default https://api.typesafe.ai/v1/systemone),
// JEV_DEADLINE_MS (default 2000 for this check).
//
// No real customer data is sent: the seed stays local, and every text here is
// hand-written synthetic Japanese. Phone/email masking runs inside
// JevClassifier before transport regardless.

import { readFileSync } from 'node:fs';
import {
    DEFAULT_JEV_QUESTIONS,
    JevClassifier
} from '../dist-backend/routing/jev-classifier.js';
import {
    JEV_DEFAULT_ENDPOINT,
    JevHttpTransport
} from '../dist-backend/routing/jev-http-transport.js';

const envPath = process.argv[2];
if (envPath) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (match && !line.trim().startsWith('#') && process.env[match[1]] === undefined) {
            process.env[match[1]] = match[2];
        }
    }
}

const apiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
if (!apiKey) {
    console.error('FAIL: TYPESAFE_API_KEY or JEV_API_KEY is required');
    process.exit(2);
}

const model = process.env.JEV_MODEL || 'jev-1.13.0';
const endpoint = process.env.JEV_ENDPOINT || JEV_DEFAULT_ENDPOINT;
const deadlineMs = Number(process.env.JEV_DEADLINE_MS || 2000);

const CASES = [
    { id: 'V-01', text: '契約の見積もりをお願いしたいのですが', expectedIntent: 'contract_request' },
    { id: 'V-02', text: '御社向けの新しいサービスをご提案させていただきたくお電話しました', expectedIntent: 'sales_offer' },
    { id: 'V-03', text: '今月の請求金額がおかしいので確認したい', expectedIntent: 'billing_complaint' },
    { id: 'V-04', text: '営業時間を教えてください', expectedIntent: 'general_inquiry' },
    { id: 'V-05', text: '担当者の方と直接お話ししたいのですが', expectedIntent: 'unknown_or_human_requested' }
];

const base = endpoint.replace(/\/systemone$/, '');
let failures = 0;

// 1. Auth + connectivity: GET /v1/models
console.log(`== step 1: GET ${base}/models ==`);
try {
    const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
        console.log(`FAIL: /v1/models -> ${res.status}`);
        failures++;
    } else {
        const body = await res.json();
        const names = (body.models ?? []).map((m) => m.name).join(', ');
        console.log(`models: ${names || '(none listed)'}`);
        console.log(`requested model "${model}" usable: ${(body.models ?? []).some((m) => m.name === model) ? 'listed' : 'not in list (versioned ids are still accepted)'}`);
    }
} catch (error) {
    console.log(`FAIL: /v1/models -> ${error.name}: ${error.message}`);
    failures++;
}

// 2. Classification through the real pipeline (masking + deadline + mapping)
console.log(`\n== step 2: classify (deadline=${deadlineMs}ms, model=${model}) ==`);
const classifier = new JevClassifier({
    model,
    deadlineMs,
    transport: new JevHttpTransport({ apiKey, questions: DEFAULT_JEV_QUESTIONS, endpoint })
});

const latencies = [];
for (const evalCase of CASES) {
    const started = performance.now();
    let decision;
    try {
        decision = await classifier.classify([{ role: 'user', text: evalCase.text }], 0);
    } catch (error) {
        console.log(`${evalCase.id} FAIL: threw ${error.name}: ${error.message}`);
        failures++;
        continue;
    }
    const ms = Math.round(performance.now() - started);
    latencies.push(ms);
    const intent = decision.kind === 'known' ? decision.intents.join(',') : `uncertain(${decision.reason})`;
    const risks = decision.kind === 'known' ? decision.risks.join(',') || '-' : '-';
    const human = decision.signals.humanRequested;
    console.log(`${evalCase.id} [${ms}ms] intent=${intent} risks=${risks} human=${human} expected=${evalCase.expectedIntent}`);
}

if (latencies.length > 0) {
    const max = Math.max(...latencies);
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    console.log(`\nlatency: avg=${avg}ms max=${max}ms (deadline=${deadlineMs}ms)`);
    if (max >= deadlineMs) {
        console.log('FAIL: a classification exceeded the deadline');
        failures++;
    }
}

// 3. Deadline path against the real network — a 1ms deadline must still return
console.log('\n== step 3: deadline=1ms must return uncertain/timeout fast ==');
{
    const tight = new JevClassifier({
        model,
        deadlineMs: 1,
        transport: new JevHttpTransport({ apiKey, questions: DEFAULT_JEV_QUESTIONS, endpoint })
    });
    const started = performance.now();
    const decision = await tight.classify([{ role: 'user', text: '営業時間を教えてください' }], 0);
    const ms = Math.round(performance.now() - started);
    const ok = decision.kind === 'uncertain' && ms < 3000;
    console.log(`[${ms}ms] kind=${decision.kind} reason=${decision.reason ?? '-'} -> ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failures++;
}

console.log(`\n== RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`} ==`);
process.exit(failures === 0 ? 0 : 1);
