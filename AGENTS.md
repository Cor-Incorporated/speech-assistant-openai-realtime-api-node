# Repository Guidelines

## プロジェクト構成

このリポジトリは、Twilio Voice / Media Streams と OpenAI Realtime API をつなぐ日本向け音声AI受付システムです。現時点の本体は `index.js` です。

- `index.js`: Fastifyサーバー、Twilio webhook、Media Streams WebSocket、OpenAI Realtime接続
- `lib/`: サーバーモジュール（通話ログ、管理APIルート、Realtimeモデル設定、入力ゲート、終話ワークフロー、セキュリティ）
- `client/`: React管理UI（Vite + Tailwind、`/app/` で配信）
- `test/`: `node --test` で実行するユニット/軽量結合テスト
- `scripts/`: ローカル検証用スクリプト
- `docs/`: ADR、実装計画、検証手順
- `.env.example`: 環境変数のテンプレート
- `.github/workflows/ci.yml`: 最小CI

## 開発コマンド

- `npm ci`: lockfileに基づいて依存関係をインストールします。
- `npm run start`: ローカルサーバーを起動します。
- `npm run check`: `index.js` の構文チェックを実行します。
- `npm run check:frontend`: 管理UI（`client/`）のTypeScript型チェックを実行します。
- `npm run build:frontend`: 管理UIをViteでビルドします。
- `npm test`: `npm run check` + `npm run check:frontend` + `npm run build:frontend` を実行した後、`node --test` で `test/` のテストを実行します。
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
