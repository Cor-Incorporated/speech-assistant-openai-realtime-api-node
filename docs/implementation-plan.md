# 実装計画

この文書は、2026年版プロダクション移行をPoC MVP (2026年5月中旬納期) へ収束させた実装計画です。本ADR階層では、フルスコープが [ADR 0001](./adr/0001-2026-production-modernization.md)、PoC凍結が [ADR 0004](./adr/0004-mvp-scope-2026-05.md) に分かれます。本ドキュメントはPoCで実際に動かす計画です。

## 原則

- 電話AI本線はTwilio Media StreamsとOpenAI Realtime WebSocketでサーバー側に置く。
- Cloud Runの `develop` 自動デプロイを開発環境の基準にする。
- 通話ログの正本は専用Firestore `speech-assistant-logs` に置き、Sheetsは運用ビューとして扱う。
- ReactはPoC期間中、認証 + 通話履歴 + AI設定の3点に限定する。
- 人間オペレーターのリアルタイム通話参加 (Voice SDK / Conference) は **PoCでは実装しない**。
- 設定 (システムプロンプト, Markdownナレッジ) は管理UIから更新でき、次回通話以降のRealtimeセッションへ反映する。

## 完了している範囲 (Wave 1 + Wave 2A)

- #3/#16 Cloud Run基盤、Secret Manager、CI/CD
- #4/#18 050番号 `+815017929351` のCloud Run切替
- #5/#7 OpenAI Realtime GA形状、`gpt-realtime-1.5`、`gpt-4o-transcribe`
- #8/#9 ローカル/Cloud Run/Twilio Media Streams検証
- 通話ログ: Firestore `speech-assistant-logs/callLogs` とGoogle Sheetsへの追記 ([ADR 0003](./adr/0003-call-log-firestore-sheets.md))
- Sheets時刻のJST表示、電話番号の文字列化、エージェント発話重複排除
- #19 Twilio webhook署名検証 + プライバシーログ無効化 + 監査ログ ([docs/security-privacy-logging.md](./security-privacy-logging.md))

## PoC MVPで実装する範囲 (Wave 2B / 2026-05)

実装順は次の通り。

### Step 1. 設定スキーマと動的SYSTEM_MESSAGEロード (backend)

- Firestore `speech-assistant-logs/adminConfig/current` に次のフィールドを保存する。
  - `systemPrompt`: string
  - `knowledgeMarkdown`: string
  - `firstMessage`: string
  - `updatedAt`, `updatedBy`
- `index.js` の `SYSTEM_MESSAGE` ハードコードをFirestoreフェッチに置き換え (起動時 + 通話開始時)。
- フェッチ失敗時はコード内デフォルトへフォールバックし、監査ログに `config.fetch.failed` を出す。

### Step 2. 再架電フラグ

- 既存の通話ログ抽出ロジック (`EXTRACTION_ENABLED`) で `needsCallback: boolean` と `callbackReason: string` を抽出する。
- Firestore `callLogs` ドキュメントとSheetsに列を追加する。
- 抽出が無効/失敗の場合は `needsCallback=null` で書き込む (要確認扱い)。

### Step 3. backend管理API

- `GET /admin/config`: 現在の設定を返す。
- `PUT /admin/config`: 設定を更新する (Clerk JWT検証済み)。
- `GET /admin/calls?limit=&cursor=`: 通話履歴を返す (新しい順、ページング付き)。
- すべて Clerk JWT検証 (`@clerk/backend` の `verifyToken`) を経由する。
- 監査ログに `actor`, `action=admin.config.updated|admin.calls.read`, `target=adminConfig|callLogs` を出す。

### Step 4. React + Clerk管理画面

- `frontend/` にVite + React + TypeScript + ClerkでSPAを作成する ([ADR 0005](./adr/0005-clerk-authentication.md))。
- ルート: `/sign-in`, `/calls` (一覧), `/settings` (AI設定)。
- 通話一覧: 日時, 電話番号 (末尾4桁マスク), 要約, 再架電フラグ, リンク。
- AI設定: システムプロンプト, Markdownナレッジ, 初回発話の編集と保存。
- backend APIへは Clerk JWTをBearerで送信。

### Step 5. PoC受け入れテスト

- 050番号への着信でAI受付が応答し、Firestore + SheetsにcallLog + 再架電フラグが書き込まれる。
- 認証なしで `/admin/calls` が401を返す。
- ログイン後、UIから設定を編集→保存→再架電→反映を確認する。
- ログイン後、UIから通話履歴 (再架電フラグ含む) を確認できる。

## PoC対象外 (フェーズ2以降)

| 項目 | Issue | 備考 |
| --- | --- | --- |
| backend TypeScript化 | #6 | ESM JSのままで運用 |
| 通話状態リアルタイムイベントストリーム (SSE/WS) | #11 | 通話後のFirestoreログのみ |
| Twilio Voice SDK ソフトフォン | #13 | PoCでは導入しない |
| AIパスアップ通知 | #15 | 再架電フラグで代替 |
| Twilio Conference参加者制御 | #17 | PoCでは導入しない |
| ベクトルRAG / チャンク化 / 検索インデックス | #14, #29 | Markdown全文をプロンプト同梱で代替 |
| PDF/PowerPoint対応 | #30 | フェーズ2 |
| ノードベースのコールフロー構築UI | (今後想定) | フェーズ2、システムプロンプトで代替 |
| CRM/SFA・Slack/Teams連携 | (今後想定) | フェーズ3以降 |

詳細は [ADR 0004](./adr/0004-mvp-scope-2026-05.md) と [docs/mvp-scope-2026-05.md](./mvp-scope-2026-05.md) を参照。

## ロールアウトと検証

1. `frontend/` を新規追加し、Cloud Runの既存サービスはbackendのみ提供する (frontendはVercel等の静的ホスティング、または同Cloud Runでstatic serveのいずれかをStep 4で決定)。
2. Clerkは検証用テナントを作成し、Free tierで運用する。
3. PoCデプロイ後、5月中旬の結合テストで上記受け入れ条件を一括検証する。
