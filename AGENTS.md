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

## Cursor Cloud specific instructions

- Node.js 22 と `npm ci` を使う。CI の Node バージョンと同じ。
- `npm run build:frontend` がないと `/app/` は 404 になる。`npm run build:backend` がないと `/app/#v2` と `/api/admin/v2/*` は登録されない。
- `OPENAI_API_KEY` が空だと `index.js` は起動時に終了する。`/`, `/health`, `/incoming-call`, 管理UIの確認には実キーは不要で、空でないプレースホルダで起動できる。有効なキーが必要なのは `npm run check:realtime` だけ。
- ローカル確認用の既定は `PORT=5050`、`ADMIN_BASIC_USER=admin`、`ADMIN_BASIC_PASSWORD=change-me`、`TWILIO_SIGNATURE_VALIDATION_ENABLED=false`、`TWILIO_STREAM_AUTH_ENABLED=false`、`VOICE_PROVIDER=realtime`。Firestore、Sheets、メール通知は無効。`/app/` は Basic 認証。
- コード上の `TWILIO_STREAM_AUTH_ENABLED` 既定は `true`。未設定のまま起動すると Media Streams に署名トークンが必要になる。
- Cloud Agent の起動時は、上記の既定で `npm run start` を前面で動かす。`http://127.0.0.1:5050/health` が既に応答している場合は再起動しない。
- 起動確認は `npm run smoke:local`。`npm test` は構文・型チェックと両ビルドを含み、無音ウォッチドッグのテストで数分かかる。
