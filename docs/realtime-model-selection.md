# Realtimeモデル選定メモ

## 結論

UAT・通常運用の既定は `gpt-realtime-2.1-mini` とし、受付・予約・問い合わせ振り分けのような通常フローでは `reasoning.effort=low`、音声は `coral` を使う。`gpt-realtime-2.1` と `gpt-realtime-2` は比較・ロールバック用に残す（[ADR-0004](./adr/0004-gpt-realtime-2-1-adoption.md)）。

`gpt-realtime-2.1-mini` はRealtime音声入出力とfunction callingに対応する低遅延・低コスト向けモデルとして、通常の電話受付に採用する。モデルページの仕様と接続結果はUATで継続確認する。

理由は、OpenAI公式情報で `gpt-realtime-2` が Realtime 音声向けの推論モデルとして位置づけられ、`gpt-realtime-1.5` より長いコンテキスト、設定可能な reasoning effort、強い指示追従、複雑な音声エージェントでのより信頼できる tool use を示しているため。

## OpenAI公式情報に基づく判断材料

- OpenAIの発表では、`gpt-realtime-2` は GPT-5級の推論を持つ初の音声モデルとして説明され、会話を進めながら推論、tool call、訂正・割り込み対応を行う用途を想定している。
- 公式ドキュメントでは、`gpt-realtime-2` でコンテキスト窓が 32K から 128K に拡張され、専門用語・固有名詞・医療用語などの保持、tone/delivery制御、回復動作、tool call、reasoning effort調整が移行時の重要論点として挙げられている。
- モデルページでは、`gpt-realtime-2` は 128,000 context window、32,000 max output tokens、reasoning token support、configurable reasoning effort、より信頼できる tool use を持つモデルとして記載されている。
- `gpt-realtime-1.5` は引き続き音声エージェント・カスタマーサポート向けの音声入出力モデルで、32,000 context window、4,096 max output tokens、function calling対応を持つ。
- Realtime prompting guide は、`gpt-realtime-2` への移行時に prompt を単純移植せず、最新のRealtime prompting guidanceに沿って再構成し、`reasoning.effort` は `low` から始め、深い計画が必要な場合だけ上げることを推奨している。

参照URL:

- https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/
- https://developers.openai.com/api/docs/models/gpt-realtime-2
- https://developers.openai.com/api/docs/guides/realtime-models-prompting
- https://developers.openai.com/api/docs/models/gpt-realtime-1.5

## 受付ワークフローで `gpt-realtime-2` を優先する条件

以下のどれかを満たす場合は `gpt-realtime-2` + `reasoning.effort=low` を第一候補にする。

- 氏名、会社名、予約日時、症状、問い合わせ分類など、会話中のentity capture精度が重要。
- 予約確認、有人引き継ぎ、FAQ検索、CRM参照など、tool selectionの誤りが受付品質に直結する。
- 通話が長くなり、前半で聞いた情報、訂正履歴、確認済み/未確認の状態を保つ必要がある。
- ユーザーの言い直し、割り込み、曖昧な依頼を自然に回復しながら処理したい。
- 会社名、サービス名、専門語、固有名詞の聞き取り・保持が重要。

通常の受付では `reasoning.effort=low` を標準にする。遅延とトークン使用量を抑えつつ、entity capture、tool selection、長めの状態管理を改善できる可能性があるため。`medium` 以上は、複数条件の業務判断、長い規約照合、複雑な例外処理が実測で必要になった場合だけ検討する。

## `gpt-realtime-1.5` を維持する条件

以下の場合は `gpt-realtime-1.5` を維持してよい。

- 既存プロンプト、音声品質、tool call、レイテンシ、コストが本番SLOを満たしており、変更リスクを取りたくない。
- 通話が短く、長い会話状態や複雑なtool selectionが不要。
- `gpt-realtime-2` への移行テストで、実運用に近い受付ケースの成功率、遅延、途中復帰、固有名詞確認が改善しない。
- `reasoning.effort` 追加やprompt再構成をまだ検証できていない。

## gpt-realtime-2.1について（2026-07-15追記）

`gpt-realtime-2.1` は `gpt-realtime-2` の改良版で、公式モデルページでは英数字認識、無音・ノイズ処理、割り込み時の振る舞いの改善が挙げられている。いずれも電話受付の主要な失敗モード（番号聞き取り・環境音誤反応・顧客の割り込み）に直結する改善である。

- 料金は `gpt-realtime-2` と同額（音声 入力$32／出力$64 per 1Mトークン、テキスト 入力$4／出力$24 per 1Mトークン）。
- reasoning effort設定・tool useは引き続きサポートされる。
- 接続ベンチマークでは`gpt-realtime-2.1`と`gpt-realtime-2`が各3/3成功し、`session.updated`中央値は2.1が862ms、2が869msだった。音声品質、日本語entity capture、tool call成功率は実通話UATで継続評価する。
- 実装注意: `lib/realtime-models.js` の `shouldSetRealtimeReasoning` は `startsWith('gpt-realtime-2')` のprefix一致のため、`gpt-realtime-2.1` にも自動的に `reasoning.effort` が送信される。選択肢追加時はテストでこの挙動を固定する。

参照URL:

- https://developers.openai.com/api/docs/models/gpt-realtime-2.1

## 移行時の注意

`gpt-realtime-2` へ切り替えるだけで終わらせず、promptを受付業務の状態、確認ルール、tool使用条件、有人引き継ぎ条件に分けて再整理する。特に電話番号、予約番号、日時、氏名、会社名は、聞き取った値を復唱して確認してからtool callに使う。

移行判断は、公式情報だけでなく、このリポジトリの汎用ベンチマーク結果で確認する。WellAI固有のプロンプト、通話 transcript、顧客データ、電話番号、NDA由来の文言は比較資料に含めない。

詳細な研究判断、`gpt-realtime-1.5` が優れる条件、`gpt-realtime-2` が優れる条件、今後の評価設計は [Realtimeモデル比較研究報告書](./realtime-model-research-report.md) を参照する。
