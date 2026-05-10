# Realtimeモデルベンチマーク手順

## 目的

`gpt-realtime-1.5` と `gpt-realtime-2` を、受付ワークフローに使う前提で比較する。現時点の `scripts/benchmark-realtime-models.js` は接続、`session.update` 受理、エラー率、そこまでの所要時間だけを測る低リスクな疎通ベンチマークであり、顧客音声や会話 transcript は使わない。

entity capture、tool selection、長い会話状態、訂正・割り込みからの復帰は、別途、架空データだけを使う合成会話ベンチマークで評価する。

このディレクトリの汎用ベンチマークコード、合成ケース、集計ログは Cor の一般的な技術検証資産として扱う。公開OpenAIドキュメント/ブログと、Cor の汎用ベンチマークコード/ログは WellAI confidential ではない。

## NDA境界

含めてよいもの:

- OpenAIの公開ドキュメント/ブログに書かれた一般情報。
- Cor が作成した汎用ベンチマークコード。
- 架空の会社名、架空の氏名、架空の電話番号風ダミー値を使った合成ケース。
- モデル名、reasoning effort、成功/失敗、遅延、tool選択結果などの集計ログ。

含めてはいけないもの:

- WellAIの実プロンプト、システムメッセージ、会話設計、業務ルール。
- 実通話 transcript、録音、要約、全文ログ。
- 顧客固有データ、会社名、店舗名、患者/利用者/担当者情報。
- 実電話番号、メールアドレス、予約番号、問い合わせID。
- NDAミーティング、NDA資料、顧客ヒアリングから派生した文言。

迷った場合は含めない。必要なら、同じ評価意図を保ったまま架空データで作り直す。

## 実行手順

1. `.env` またはシェル環境に `OPENAI_API_KEY` を設定する。
2. 比較対象を明示して実行する。

```sh
OPENAI_API_KEY=sk-... \
REALTIME_BENCHMARK_MODELS=gpt-realtime-1.5,gpt-realtime-2 \
REALTIME_REASONING_EFFORT=low \
npm run benchmark:realtime-models
```

3. 結果には、モデル別の成功率、接続時間、`session.updated` までの時間、エラー内容を残す。
4. PR本文には、実行日時、コマンド、比較対象モデル、`gpt-realtime-2` の `reasoning.effort`、要約結果だけを書く。APIキー、実データ、全文transcriptは書かない。

## 許可する環境変数

ベンチマークで使ってよい環境変数は以下に限定する。

- `OPENAI_API_KEY`: OpenAI APIキー。ログに出力しない。
- `REALTIME_BENCHMARK_MODELS`: 比較するモデルのカンマ区切り。例: `gpt-realtime-1.5,gpt-realtime-2`。
- `REALTIME_REASONING_EFFORT`: `gpt-realtime-2` で使う reasoning effort。通常は `low`。
- `REALTIME_BENCHMARK_ITERATIONS`: 各モデルの繰り返し回数。
- `REALTIME_BENCHMARK_TIMEOUT_MS`: 1ケースあたりのタイムアウト。
- `REALTIME_BENCHMARK_WRITE_LOG`: `false` の場合、Markdownログを書き出さない。
- `TRANSCRIPTION_MODEL`: 入力音声文字起こしモデル。
- `VOICE`: 出力音声。
- `AUDIO_FORMAT`: 入出力音声フォーマット。
- `AUDIO_NOISE_REDUCTION`: 入力ノイズリダクション設定。無効化する場合は `null`。
- `VAD_TYPE`: VAD種別。
- `VAD_THRESHOLD`: `server_vad` のしきい値。
- `VAD_PREFIX_PADDING_MS`: `server_vad` のprefix padding。
- `VAD_SILENCE_DURATION_MS`: `server_vad` のsilence duration。
- `VAD_EAGERNESS`: `semantic_vad` のeagerness。

この一覧にない環境変数で、顧客名、電話番号、実プロンプト、transcript、NDA由来テキストを渡してはいけない。

## 今回の接続ベンチマークの評価観点

- Connection: Realtime WebSocketへ接続できたか。
- Session update: GA形状の `session.update` が受理されたか。
- Latency: 接続完了と `session.updated` までの所要時間。
- Error rate: モデル別の失敗率とエラー内容。

## 次段階の合成会話ベンチマーク評価観点

- Entity capture: 氏名、電話番号風ダミー値、予約日時、問い合わせ種別を正しく確認できたか。
- Tool selection: FAQ参照、予約照会、有人引き継ぎなどの架空toolを適切に選べたか。
- Long state: 前半で得た情報、訂正、確認済み状態を後半まで保持したか。
- Recovery: 言い直し、聞き間違い、割り込み、曖昧な依頼から自然に復帰したか。
- Latency: 受付として許容できる応答遅延か。

## 判定ルール

接続ベンチマークで `gpt-realtime-2` + `reasoning.effort=low` が安定して `session.updated` まで到達し、遅延が許容範囲なら移行テスト候補にする。

最終判断は、次段階の合成会話ベンチマークで entity capture、tool selection、long state のいずれかに明確な改善があり、遅延が許容範囲であることを確認してから行う。改善が見えない、または遅延・コスト・prompt再構成リスクが大きい場合は `gpt-realtime-1.5` を維持する。

参照URL:

- https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/
- https://developers.openai.com/api/docs/models/gpt-realtime-2
- https://developers.openai.com/api/docs/guides/realtime-models-prompting
- https://developers.openai.com/api/docs/models/gpt-realtime-1.5
