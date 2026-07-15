import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { buildRealtimeInputGateConfig } from '../lib/realtime-input-gate.js';
import {
    appendCallbackPhoneValidationInstructions,
    buildValidateCallbackPhoneTool
} from '../lib/phone-number-validation.js';
import {
    appendCallEndInstructions,
    buildCallEndConfig,
    buildFinishReceptionTool
} from '../lib/realtime-call-end.js';

dotenv.config();

const {
    OPENAI_API_KEY,
    REALTIME_BENCHMARK_MODELS = 'gpt-realtime-2.1,gpt-realtime-2',
    REALTIME_BENCHMARK_ITERATIONS = '3',
    REALTIME_BENCHMARK_TIMEOUT_MS = '15000',
    REALTIME_REASONING_EFFORT = 'low',
    TRANSCRIPTION_MODEL = 'gpt-4o-transcribe',
    VOICE = 'marin',
    AUDIO_FORMAT = 'audio/pcmu',
    AUDIO_NOISE_REDUCTION = 'near_field',
    VAD_TYPE = 'server_vad',
    VAD_THRESHOLD = '0.65',
    VAD_PREFIX_PADDING_MS = '300',
    VAD_SILENCE_DURATION_MS = '700',
    VAD_EAGERNESS = 'low',
    VAD_CREATE_RESPONSE = 'true',
    VAD_INTERRUPT_RESPONSE = 'true',
    REALTIME_INPUT_GATE_ENABLED = 'true',
    REALTIME_INPUT_GATE_MIN_JAPANESE_CHARS = '2',
    REALTIME_INPUT_GATE_MIN_DIGITS = '4',
    REALTIME_INPUT_GATE_ALLOWED_TERMS = '',
    CALL_END_WORKFLOW_ENABLED = 'true',
    CALL_END_HANGUP_ENABLED = 'true',
    CALL_END_FINAL_PHRASE = '',
    CALL_END_MARK_TIMEOUT_MS = '5000',
    CALL_END_GRACE_MS = '800',
    REALTIME_BENCHMARK_WRITE_LOG = 'true'
} = process.env;

if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is required.');
    process.exit(1);
}

const models = REALTIME_BENCHMARK_MODELS
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
const iterations = Number(REALTIME_BENCHMARK_ITERATIONS);
const timeoutMs = Number(REALTIME_BENCHMARK_TIMEOUT_MS);
const shouldWriteLog = REALTIME_BENCHMARK_WRITE_LOG !== 'false';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

if (models.length === 0) {
    console.error('REALTIME_BENCHMARK_MODELS must include at least one model.');
    process.exit(1);
}

if (!Number.isInteger(iterations) || iterations < 1) {
    console.error('REALTIME_BENCHMARK_ITERATIONS must be a positive integer.');
    process.exit(1);
}

if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    console.error('REALTIME_BENCHMARK_TIMEOUT_MS must be a positive number.');
    process.exit(1);
}

const redactSecrets = (value = '') => String(value)
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(new RegExp(OPENAI_API_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED_OPENAI_API_KEY]');

const markdownCell = (value) => redactSecrets(value)
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .trim();

const inputGateConfig = buildRealtimeInputGateConfig({
    REALTIME_INPUT_GATE_ENABLED,
    REALTIME_INPUT_GATE_MIN_JAPANESE_CHARS,
    REALTIME_INPUT_GATE_MIN_DIGITS,
    REALTIME_INPUT_GATE_ALLOWED_TERMS
});
const shouldCreateResponseFromVad = !inputGateConfig.enabled && VAD_CREATE_RESPONSE === 'true';
const shouldInterruptResponse = VAD_INTERRUPT_RESPONSE === 'true';
const callEndConfig = buildCallEndConfig({
    CALL_END_WORKFLOW_ENABLED,
    CALL_END_HANGUP_ENABLED,
    CALL_END_FINAL_PHRASE,
    CALL_END_MARK_TIMEOUT_MS,
    CALL_END_GRACE_MS
});
const finishReceptionTool = buildFinishReceptionTool(callEndConfig);
const validateCallbackPhoneTool = buildValidateCallbackPhoneTool();

const buildTurnDetectionConfig = () => {
    if (VAD_TYPE === 'semantic_vad') {
        return {
            type: VAD_TYPE,
            eagerness: VAD_EAGERNESS,
            create_response: shouldCreateResponseFromVad,
            interrupt_response: shouldInterruptResponse
        };
    }

    return {
        type: VAD_TYPE,
        threshold: Number(VAD_THRESHOLD),
        prefix_padding_ms: Number(VAD_PREFIX_PADDING_MS),
        silence_duration_ms: Number(VAD_SILENCE_DURATION_MS),
        create_response: shouldCreateResponseFromVad,
        interrupt_response: shouldInterruptResponse
    };
};

const isRealtime2Model = (model) => model === 'gpt-realtime-2'
    || model.startsWith('gpt-realtime-2.')
    || model.startsWith('gpt-realtime-2-');

const buildSessionUpdate = (model) => {
    const session = {
        type: 'realtime',
        model,
        instructions: appendCallEndInstructions(
            appendCallbackPhoneValidationInstructions('Realtime connectivity benchmark. Keep responses brief.'),
            callEndConfig
        ),
        audio: {
            input: {
                format: { type: AUDIO_FORMAT },
                noise_reduction: AUDIO_NOISE_REDUCTION === 'null' ? null : { type: AUDIO_NOISE_REDUCTION },
                transcription: { model: TRANSCRIPTION_MODEL },
                turn_detection: buildTurnDetectionConfig()
            },
            output: {
                format: { type: AUDIO_FORMAT },
                voice: VOICE
            }
        }
    };

    session.tools = [
        validateCallbackPhoneTool,
        ...(finishReceptionTool ? [finishReceptionTool] : [])
    ];
    if (session.tools.length > 0) {
        session.tool_choice = 'auto';
    }

    if (isRealtime2Model(model)) {
        session.reasoning = { effort: REALTIME_REASONING_EFFORT };
    }

    return {
        type: 'session.update',
        session
    };
};

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

const benchmarkOnce = ({ model, iteration }) => new Promise((resolve) => {
    const startedAt = nowMs();
    let connectMs = null;
    let settled = false;
    let ws;

    const finish = (result) => {
        if (settled) return;

        settled = true;
        clearTimeout(timeout);

        if (ws?.readyState === WebSocket.OPEN) {
            ws.close();
        } else if (ws?.readyState === WebSocket.CONNECTING) {
            ws.terminate();
        }

        resolve({
            model,
            iteration,
            connectMs,
            sessionUpdatedMs: null,
            status: 'failed',
            error: '',
            ...result
        });
    };

    const timeout = setTimeout(() => {
        finish({
            status: 'timeout',
            error: `Timed out after ${timeoutMs}ms`
        });
    }, timeoutMs);

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    ws = new WebSocket(url, {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`
        }
    });

    ws.on('open', () => {
        connectMs = nowMs() - startedAt;
        ws.send(JSON.stringify(buildSessionUpdate(model)));
    });

    ws.on('message', (data) => {
        let event;

        try {
            event = JSON.parse(data);
        } catch (error) {
            finish({
                error: `Invalid JSON event: ${error.message}`
            });
            return;
        }

        if (event.type === 'session.updated') {
            finish({
                status: 'ok',
                sessionUpdatedMs: nowMs() - startedAt
            });
            return;
        }

        if (event.type === 'error') {
            const errorType = event.error?.type || 'unknown_error';
            const errorCode = event.error?.code || 'unknown_code';
            const errorMessage = redactSecrets(event.error?.message || 'No message returned');
            finish({
                error: `${errorType} (${errorCode}): ${errorMessage}`
            });
        }
    });

    ws.on('error', (error) => {
        finish({
            error: `WebSocket error: ${redactSecrets(error.message)}`
        });
    });

    ws.on('close', (code) => {
        if (!settled) {
            finish({
                error: `WebSocket closed before session.updated with code ${code}`
            });
        }
    });
});

const median = (values) => {
    const sorted = values
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);

    if (sorted.length === 0) return null;

    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
        : sorted[middle];
};

const summarizeModel = (results, model) => {
    const modelResults = results.filter((result) => result.model === model);
    const successfulResults = modelResults.filter((result) => result.status === 'ok');

    return {
        model,
        ok: successfulResults.length,
        total: modelResults.length,
        connectMedianMs: median(successfulResults.map((result) => result.connectMs)),
        sessionUpdatedMedianMs: median(successfulResults.map((result) => result.sessionUpdatedMs))
    };
};

const timingValue = (value) => Number.isFinite(value) ? `${value}` : '';

const buildMarkdown = (results) => {
    const lines = [
        '# Realtime Model Connectivity Benchmark',
        '',
        `- Date: ${new Date().toISOString()}`,
        `- Iterations per model: ${iterations}`,
        `- Timeout per attempt: ${timeoutMs}ms`,
        '- No customer audio, transcripts, or prompts were used.',
        '- Log contains only timings, status, and errors with secrets redacted.',
        '',
        '## Summary',
        '',
        '| Model | OK | Connect median ms | Session updated median ms |',
        '| --- | ---: | ---: | ---: |',
        ...models.map((model) => {
            const summary = summarizeModel(results, model);
            return [
                markdownCell(summary.model),
                `${summary.ok}/${summary.total}`,
                timingValue(summary.connectMedianMs),
                timingValue(summary.sessionUpdatedMedianMs)
            ].join(' | ');
        }).map((line) => `| ${line} |`),
        '',
        '## Attempts',
        '',
        '| Model | Iteration | Status | Connect ms | Session updated ms | Error |',
        '| --- | ---: | --- | ---: | ---: | --- |',
        ...results.map((result) => `| ${[
            markdownCell(result.model),
            result.iteration,
            markdownCell(result.status),
            timingValue(result.connectMs),
            timingValue(result.sessionUpdatedMs),
            markdownCell(result.error)
        ].join(' | ')} |`)
    ];

    return `${lines.join('\n')}\n`;
};

const localDate = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const main = async () => {
    const results = [];

    for (const model of models) {
        for (let iteration = 1; iteration <= iterations; iteration += 1) {
            results.push(await benchmarkOnce({ model, iteration }));
        }
    }

    const markdown = buildMarkdown(results);
    process.stdout.write(markdown);

    if (shouldWriteLog) {
        const logDir = path.join(repoRoot, 'docs', 'realtime-model-benchmarks');
        const logPath = path.join(logDir, `${localDate()}-local.md`);
        await mkdir(logDir, { recursive: true });
        await appendFile(logPath, markdown, 'utf8');
        process.stdout.write(`\nLog written: ${path.relative(repoRoot, logPath)}\n`);
    }

    if (results.some((result) => result.status !== 'ok')) {
        process.exitCode = 1;
    }
};

main().catch((error) => {
    console.error(`Benchmark failed: ${redactSecrets(error.message)}`);
    process.exit(1);
});
