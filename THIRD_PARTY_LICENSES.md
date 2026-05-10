# Third Party Licenses

本リポジトリは以下のOSSライブラリに依存しています。公開リポジトリで扱うため、ベース実装、利用先API、直接依存を分けて記録します。

## ベース実装

- **Twilio公式サンプル `speech-assistant-openai-realtime-api-node`** (MIT License, Copyright (c) 2024 Twilio Inc.)
  - URL: https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node
  - 派生開始日: 2024-10-14 (本リポジトリ初期コミット日)
  - ライセンス全文: 本リポジトリ `LICENSE` ファイル参照 (Twilio Inc. の MIT 表示を保持)

## 利用先 API

本実装はランタイムで以下の外部 API を呼び出します。これらは依存ライブラリではなく、ネットワーク経由で利用するサービスです。

- **OpenAI Realtime API** — WebSocket 経由で音声応答を取得 (https://platform.openai.com/docs/)
- **Twilio Voice / Media Streams** — 電話回線とメディアストリーム (https://www.twilio.com/docs/voice/media-streams)
- **Google Cloud Firestore / Sheets API** — 通話ログ永続化 (オプション機能、env で有効化)

## 直接依存 (`dependencies`)

`package.json` の `dependencies` フィールドから抽出した直接依存のOSSライブラリ一覧です。各ライブラリの公開ライセンス (npm registry の `license` フィールド準拠) を併記します。ライセンス全文は、それぞれのパッケージに同梱の `LICENSE` ファイルを参照してください。

- **@fastify/formbody** ^8.0.0 — MIT License
  - npm: https://www.npmjs.com/package/@fastify/formbody
- **@fastify/websocket** ^11.0.0 — MIT License
  - npm: https://www.npmjs.com/package/@fastify/websocket
- **@google-cloud/firestore** ^8.5.0 — Apache License 2.0
  - npm: https://www.npmjs.com/package/@google-cloud/firestore
- **dotenv** ^16.4.5 — BSD-2-Clause License
  - npm: https://www.npmjs.com/package/dotenv
- **fastify** ^5.0.0 — MIT License
  - npm: https://www.npmjs.com/package/fastify
- **googleapis** ^171.4.0 — Apache License 2.0
  - npm: https://www.npmjs.com/package/googleapis
- **ws** ^8.18.0 — MIT License
  - npm: https://www.npmjs.com/package/ws

## ランタイム

- **Node.js** 18+ (MIT License) — https://nodejs.org/

## 重要事項

本リポジトリには、ベース実装、利用先API、直接依存ライブラリ、Cor.管理下の汎用変更を記録します。デプロイ先ごとのシステムプロンプト、運用識別子、顧客固有設定は公開リポジトリに含めません。

## ライセンステキストの保管

各OSSのライセンス全文は、配布物・本番デプロイメント時に同梱します。本リポジトリでは概要のみ記載しています。
