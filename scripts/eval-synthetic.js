// Synthetic seed evaluation runner.
// Usage: npm run build:backend && npm run eval:synthetic [-- --out <dir>]
// Prints a summary and writes JSON + Markdown reports. No external calls —
// the classifier runs fully locally and all side effects are mocked in tests.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEvalCases, runEval } from '../dist-backend/eval/synthetic-eval.js';

const args = process.argv.slice(2);
const outFlagIndex = args.indexOf('--out');
const outDir = outFlagIndex >= 0 ? args[outFlagIndex + 1] : 'docs/evaluation/results';
const seedPath = resolve('test/fixtures/synthetic-eval-seed.jsonl');

const cases = await loadEvalCases(seedPath);
const report = runEval(cases, seedPath);

const stamp = report.generatedAt.slice(0, 10);
await mkdir(outDir, { recursive: true });
const jsonPath = resolve(outDir, `synthetic-seed-${stamp}.json`);
const mdPath = resolve(outDir, `synthetic-seed-${stamp}.md`);

const md = [
    `# Synthetic seed evaluation — ${stamp}`,
    '',
    `source: ${report.source}`,
    `split: ${report.split}（設計seed。調整・校正・最終holdoutのデータは別途作成）`,
    '',
    `## 集計`,
    '',
    `- semanticケース: ${report.totals.semantic}`,
    `- fault_injectionケース: ${report.totals.fault}（ユニットテストで検査、coverage列参照）`,
    `- 現行rules出力が提案ラベルと集合一致: ${report.totals.semanticMatchingProposal} / ${report.totals.semantic}`,
    '',
    `## semantic結果（現行出力 | 提案ラベル | policy判定）`,
    '',
    '| id | name | 現行intents | 現行risks | 提案intents | 一致 | transfer:contract | transfer:general | escalation |',
    '|---|---|---|---|---|---|---|---|---|',
    ...report.semanticResults.map((result) =>
        `| ${result.id} | ${result.name} | ${result.currentIntents.join('+')} | ${result.currentRisks.join('+') || '-'} | ${result.proposedIntents.join('+')} | ${result.matchesProposal ? '✓' : '✗'} | ${result.policy.contract} | ${result.policy.general} | ${result.policy.escalation} |`
    ),
    '',
    `## faultケース → テストカバレッジ`,
    '',
    '| id | name | coverage |',
    '|---|---|---|',
    ...report.faultResults.map((result) => `| ${result.id} | ${result.name} | ${result.coverage} |`),
    '',
    '## 注意',
    '',
    ...report.notes.map((note) => `- ${note}`)
].join('\n');

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(mdPath, `${md}\n`);

const mismatches = report.semanticResults.filter((result) => !result.matchesProposal);
console.log(`semantic: ${report.totals.semantic} cases, proposal一致 ${report.totals.semanticMatchingProposal}, 差分 ${mismatches.length}`);
for (const result of mismatches) {
    console.log(`  ${result.id} ${result.name}: 現行=${result.currentIntents.join('+')} 提案=${result.proposedIntents.join('+')}`);
}
console.log(`fault: ${report.totals.fault} cases → ユニットテストで検査`);
console.log(`wrote ${jsonPath}`);
console.log(`wrote ${mdPath}`);
