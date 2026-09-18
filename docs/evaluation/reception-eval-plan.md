# 受付ルーティング評価計画

- 日付: 2026-09-18
- 対象: `test/fixtures/synthetic-eval-seed.jsonl`（48件: semantic 36 + fault_injection 12）

## 前提

`synthetic_eval_seed.jsonl` は**設計用の合成素材**であり、`proposed_expectations` は承認済みgoldラベルではない。現行出力と提案の差分は「現行の限界」「提案の誤り」のどちらでもありうるため、不一致をそのままpolicy変更の根拠にしない。

## データ分割

| 区分 | 用途 | 内容 |
|---|---|---|
| 調整用 | policy・分類ルールの設計参照 | semantic全件の現行 vs 提案の差分一覧 |
| 校正用 | fault注入12件 | ユニットテストで検査（下表 coverage） |
| 最終holdout | 将来の実音声・実ログデータ | **未収集**。本seedはholdoutではない |

実日本語音声の実測がないため、Jev/Liveの精度・速度・品質改善は現時点で断定しない。

## 実行方法

```bash
npm run build:backend && node scripts/eval-synthetic.js
```

出力: `docs/evaluation/results/synthetic-seed-2026-09-18.{json,md}`

レポートの3列は分離して読む:
- `currentIntents/currentRisks`: 現行regex分類の実出力
- `proposedIntents`: seedの提案ラベル（未承認）
- `policy`: 転送が配備されている前提での `evaluateTransferRequest` 評価面（`EVAL_SURFACE_FLAGS`）

## faultケース → テスト対応表

| ID | 検査箇所 |
|---|---|
| FAULT-001 | `test/playback-controller.test.js` |
| FAULT-002 | `test/reception-state.test.js` + playback |
| FAULT-003 | `test/routing-coordinator.test.js` |
| FAULT-004 | `test/routing-coordinator.test.js` + `test/jev-classifier.test.js` |
| FAULT-005 | `test/jev-classifier.test.js` + coordinator |
| FAULT-006 | `test/tool-arguments.test.js` |
| FAULT-007 | `test/tool-arguments.test.js` + `test/routing-policy.test.js` + `test/action-gate.test.js` |
| FAULT-008 | `test/action-ledger.test.js` + `test/action-gate.test.js` |
| FAULT-009 | `test/action-ledger.test.js` |
| FAULT-010 | `test/live-adapter.test.js` |
| FAULT-011 | `test/voice-events.test.js` |
| FAULT-012 | `test/reception-state.test.js` + `test/action-gate.test.js` |

## 既知の差分（2026-09-18時点の観測）

semantic 36件中 24件一致、12件差分。主な傾向:
- 現行regexが `unknown` を返すケースに提案ラベルがある（JA-004/009/010/018/035/036等）→ 分類カバレッジ不足の可能性
- JA-022（用件訂正）: 現行 `contract_request` vs 提案 `existing_support` — 訂正コンテキストの扱いが論点
- JA-023（「はい」単独）: 現行 `unknown` vs 提案 `billing_complaint` — 裸の承諾からintentを捏造しない設計を優先

差分は人間が確認し、policy変更は別途合意のうえ実施する。

## Jev採否の評価ゲート

1. Jev実API仕様の確認（BLOCKED）
2. shadow modeで `RoutingCoordinator` 経由の現行並走比較（同一contextRevisionで両者のdecisionを記録）
3. 実音声holdoutでの精度・レイテンシ実測
4. deadline内応答率・uncertain率・fallback発動率の観測

3まで完了するまでは採否判断を保留する。現時点の推奨は**不採用寄り（証拠不足）**。
