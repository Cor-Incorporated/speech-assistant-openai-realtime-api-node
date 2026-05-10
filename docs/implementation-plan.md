# 実装計画

この文書は、2026年版プロダクション移行ADRをGitHub issueと実装Waveへ落とし込むための計画です。2026年4月26日時点で、ローカル検証、Cloud Run移行、050番号切替、Firestore/Sheets通話ログは完了しています。

## 原則

- 電話AI本線はTwilio Media StreamsとOpenAI Realtime WebSocketでサーバー側に置く。
- Cloud Runの `develop` 自動デプロイを開発環境の基準にする。
- 通話ログの正本は専用Firestore `your-firestore-database-id` に置き、Sheetsは運用ビューとして扱う。
- Reactは監視、設定、ナレッジ、引き継ぎのために使う。
- 人間オペレーターの通話参加にはTwilio Voice SDKのWebRTCを使う。
- モデル、VAD、音声、電話番号、ナレッジは設定として扱う。

## 現在完了している範囲

- #3/#16 Cloud Run基盤、Secret Manager、CI/CD
- #4/#18 Twilio番号 `<twilio-phone-number>` のCloud Run切替
- #5/#7 OpenAI Realtime GA形状、`gpt-realtime-1.5`、`gpt-4o-transcribe`
- #8/#9 ローカル/Cloud Run/Twilio Media Streams検証
- 通話ログ: Firestore `your-firestore-database-id/callLogs` とGoogle Sheetsへの追記
- Sheets時刻のJST表示、電話番号の文字列化、エージェント発話重複排除

## 継続中のIssue

- #19 ログ、監査、プライバシー制御、BigQuery分析連携
- #1/#10 VAD/ノイズ低減プロファイルの実通話評価
- #6 TypeScript化とbackend分割
- #12 Reactオペレーターコンソール
- #11 Realtimeイベントストリーム
- #14 ナレッジ/RAG投入と検索
- #30 React UIからのMarkdown/PDFナレッジCRUD
- #29 ナレッジ取り込み、チャンク化、検索インデックス
- #13/#15/#17 WebRTCソフトフォン、AIパスアップ、Twilio Conference制御

## 次の推奨Wave

### Wave 2: 安全性と運用ログの完成

- Twilio webhook署名検証を追加する。
- Firestore通話ログのPII方針、保持期間、アクセス権を定義する。
- Sheets運用ビューを実通話向けに整える。
- BigQuery連携の前提スキーマを決める。

### Wave 3: React管理画面

- 通話一覧、通話詳細、文字起こし、要約、折り返し要否を表示する。
- Firestore `callLogs` を読み取り、Sheetsに依存しない管理ビューを作る。
- assistant初回発話、システム指示、VADプロファイルをUIから確認できるようにする。

### Wave 4: 設定・ナレッジ・RAG

- React UIからMarkdown/PDFのナレッジを追加、編集、削除できるようにする。
- 会社情報、営業時間、受付範囲、FAQを投入できるようにする。
- PDFからテキストを抽出し、Markdown本文と同じ取り込みパイプラインに流す。
- ナレッジをチャンク化し、検索インデックスへ反映する。
- AI応答が参照したナレッジを通話ログに残す。
- ナレッジ更新を管理UIから運用できるようにする。

### Wave 5: 人間への引き継ぎ

- AIがパスアップ判定を出す。
- React画面でオペレーターに通知する。
- Twilio Voice SDKでブラウザから通話へ参加する。
- Twilio ConferenceでAIのミュート/退出を制御する。
