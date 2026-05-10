# Third Party Licenses

本リポジトリは以下のOSSライブラリに依存しています。これらは全て、Cor.株式会社が外部受託案件の検討を開始した境界日 (2026-04-08) 以前から公開・利用可能な公知のソフトウェアです。

## ベース実装

- **OpenAI Realtime API サンプル実装** (MIT License)
  - URL: https://github.com/openai/openai-realtime-api-beta
  - 派生開始日: 2024-10-14 (本リポジトリ初期コミット日)

## 直接依存 (`dependencies`)

`package.json` の `dependencies` フィールドから抽出した直接依存のOSSライブラリ一覧です。各ライブラリのライセンス全文は、それぞれのパッケージに同梱の `LICENSE` ファイルおよび `package.json` の `license` フィールドを参照してください。

- **@fastify/formbody** ^8.0.0 — License: 各パッケージのpackage.json/LICENSEを参照 (Fastify エコシステムは一般に MIT License で公開)
  - npm: https://www.npmjs.com/package/@fastify/formbody
- **@fastify/websocket** ^11.0.0 — License: 各パッケージのpackage.json/LICENSEを参照 (Fastify エコシステムは一般に MIT License で公開)
  - npm: https://www.npmjs.com/package/@fastify/websocket
- **@google-cloud/firestore** ^8.5.0 — License: 各パッケージのpackage.json/LICENSEを参照 (Google Cloud Client Libraries は一般に Apache License 2.0 で公開)
  - npm: https://www.npmjs.com/package/@google-cloud/firestore
- **dotenv** ^16.4.5 — License: 各パッケージのpackage.json/LICENSEを参照 (BSD-2-Clause で公開)
  - npm: https://www.npmjs.com/package/dotenv
- **fastify** ^5.0.0 — License: 各パッケージのpackage.json/LICENSEを参照 (MIT License で公開)
  - npm: https://www.npmjs.com/package/fastify
- **googleapis** ^171.4.0 — License: 各パッケージのpackage.json/LICENSEを参照 (Google API Client Libraries は一般に Apache License 2.0 で公開)
  - npm: https://www.npmjs.com/package/googleapis
- **ws** ^8.18.0 — License: 各パッケージのpackage.json/LICENSEを参照 (MIT License で公開)
  - npm: https://www.npmjs.com/package/ws

## ランタイム

- **Node.js** 22+ (MIT-style License) — https://nodejs.org/

## 重要事項

これらのOSSは全て、Cor.株式会社が外部受託案件の検討を開始した日 (2026-04-08) より前から公開されている公知のソフトウェアです。本リポジトリの Cor.独自実装は、これらOSSの組み合わせ・統合・拡張に該当します。

外部受託検討前から公知のOSSであるため、利用に関し第三者との秘密保持契約 (NDA) の制約を受けません。

## ライセンステキストの保管

各OSSのライセンス全文は、配布物・本番デプロイメント時に同梱します。本リポジトリでは概要のみ記載しています。
