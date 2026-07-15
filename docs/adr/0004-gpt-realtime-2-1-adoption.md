# ADR 0004: gpt-realtime-2.1 の採用方針

- ステータス: 提案中（ベンチマーク実測後に「採用」へ更新する）
- 日付: 2026-07-15
- 対象: Realtimeモデル選択（`lib/realtime-models.js`）、管理UIのモデル切替、ベンチマーク運用

## 背景

現在の既定Realtimeモデルは `gpt-realtime-2`（`reasoning.effort=low`）である（[Realtimeモデル選定メモ](../realtime-model-selection.md)）。OpenAIは改良版の `gpt-realtime-2.1` を公開しており、公式モデルページでは以下の改善が挙げられている。

- 英数字（alphanumeric）の認識精度向上
- 無音・ノイズへの対応改善
- 割り込み（interruption）時の振る舞い改善

これらはいずれも電話受付での主要な失敗モード（電話番号・予約番号の聞き取り、保留音・環境音での誤発話、顧客の割り込み）に直結する。料金は `gpt-realtime-2` と同額（音声 入力$32／出力$64 per 1Mトークン、テキスト 入力$4／出力$24 per 1Mトークン）であり、コスト面の移行障壁はない。

## 決定

1. `gpt-realtime-2.1` を `lib/realtime-models.js` の `REALTIME_MODEL_OPTIONS` に追加する（`supportsReasoning: true`）。この時点では既定モデルは `gpt-realtime-2` のまま維持する。
2. 既存のベンチマーク手順（`npm run benchmark:realtime-models`、[ベンチマーク運用](../realtime-model-benchmarks/README.md)）で `gpt-realtime-2` と `gpt-realtime-2.1` を実測比較し、結果を `docs/realtime-model-benchmarks/` に記録する。
3. 以下の昇格判定基準をすべて満たした場合、`DEFAULT_REALTIME_MODEL` を `gpt-realtime-2.1` へ昇格し、本ADRのステータスを「採用」へ更新する。
   - 初回応答までのレイテンシが `gpt-realtime-2` と同等以下
   - 日本語の聞き取り・entity capture（氏名・電話番号・日時）が同等以上
   - tool call（電話番号検証、finish_reception）の成功率が同等以上

## 実装上の注意

- `shouldSetRealtimeReasoning` は `startsWith('gpt-realtime-2')` のprefix一致であるため、`gpt-realtime-2.1` にも自動的に `reasoning.effort` が送信される。これは意図した挙動だが、モデル追加時にテストで明示的に固定すること。
- プロンプトは単純移植せず、[Realtimeモデル選定メモ](../realtime-model-selection.md)の移行時注意（復唱確認・状態管理の再整理）に従う。

## ロールバック

Firestore `runtimeSettings/admin`（管理UIのモデル切替）または `REALTIME_MODEL` 環境変数で、いつでも `gpt-realtime-2` へ戻せる。既存機構をそのまま使い、新しい仕組みは追加しない。

## 影響

- 関連issue: モデル選択肢追加（Wave B1）、ベンチ実測と昇格（Wave B2）
- 関連doc: [realtime-model-selection.md](../realtime-model-selection.md)、[realtime-model-research-report.md](../realtime-model-research-report.md)

## 参考

- https://developers.openai.com/api/docs/models/gpt-realtime-2.1
