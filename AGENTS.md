# Repository Guidelines

## プロジェクト構成

このリポジトリは、Twilio Voice / Media Streams と OpenAI Realtime API をつなぐ日本向け音声AI受付システムです。現時点の本体は `index.js` です。

- `index.js`: Fastifyサーバー、Twilio webhook、Media Streams WebSocket、OpenAI Realtime接続
- `lib/`: 通話ログSink (Firestore + Sheets) とTwilio署名検証/監査ログのユーティリティ
- `scripts/`: ローカル検証用スクリプト
- `docs/`: ADR、実装計画、検証手順
  - `docs/mvp-scope-2026-05.md`: PoC MVPスコープ (現行進行中フェーズ)
  - `docs/adr/0004-mvp-scope-2026-05.md`: MVPスコープ凍結ADR
  - `docs/adr/0005-clerk-authentication.md`: 管理画面認証 (Clerk採用)
- `.env.example`: 環境変数のテンプレート
- `.github/workflows/ci.yml`: 最小CI

## 進行中フェーズ

PoC MVP (2026年5月中旬納期) に向け、以下を実装します。詳細は [docs/mvp-scope-2026-05.md](./docs/mvp-scope-2026-05.md) と [docs/next-implementation-plan.md](./docs/next-implementation-plan.md) を参照してください。

- React + Clerkの最低限の管理画面
- 通話履歴一覧 (Firestore直読み)
- 再架電フラグ
- AI設定 (システムプロンプト + Markdownナレッジ直書き)
- backend認証付き設定API + 通話開始時の動的設定ロード

PoC対象外 (フェーズ2以降): Twilio Voice SDKソフトフォン、Conference引き継ぎ、ベクトルRAG、PDF対応、backend TypeScript化、リアルタイム通話イベントストリーム。

## 開発コマンド

- `npm ci`: lockfileに基づいて依存関係をインストールします。
- `npm run start`: ローカルサーバーを起動します。
- `npm run check`: `index.js` の構文チェックを実行します。
- `npm test`: 現時点では `npm run check` を実行します。
- `npm run check:realtime`: OpenAI Realtimeへ接続し、GA形式の `session.update` を検証します。
- `npm run smoke:local`: `/`, `/healthz`, `/incoming-call` を検証します。
- `npm run smoke:media-stream`: Twilio Media Streams互換のWebSocket検証を行います。

## コーディング規約

JavaScriptはESMで書きます。インデントは既存コードに合わせて4スペースを使います。設定値、モデル名、VAD値、音声設定はコード直書きではなく環境変数へ寄せてください。

## テスト方針

最低限、変更前後で `npm test` を通してください。RealtimeやTwilio経路を触る場合は、`check:realtime`、`smoke:local`、`smoke:media-stream` の結果もPR本文へ記録します。

## ブランチ運用

- `main`: 本番安定版
- `develop`: 開発統合先
- `feature/*`: 新機能
- `fix/*`: 修正
- `docs/*`: ドキュメント変更

`main` と `develop` は保護されています。PR経由で変更してください。

## セキュリティ

`.env`、APIキー、Twilio Auth Token、通話録音、全文トランスクリプト、電話番号をコミットしないでください。本番ログでは個人情報を最小化し、必要な場合だけ明示的に有効化します。
