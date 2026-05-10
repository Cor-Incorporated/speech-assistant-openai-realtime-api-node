# 次フェーズ実装計画 (PoC MVP / 2026-05)

## 現状

050番号はCloud Run上の日本語AI受付に接続済みです。通話ログは専用Firestore `speech-assistant-logs/callLogs` に保存され、Google Sheetsへ運用ビューとして追記されます。Sheetsの時刻は日本時間表示、電話番号は文字列扱い、エージェント発話の重複記録は修正済みです。Twilio webhook署名検証、プライバシーログ無効化、JSON監査ログも導入済みです。

## ゴール (PoC納期: 2026年5月中旬)

[ADR 0004 MVPスコープ凍結](./adr/0004-mvp-scope-2026-05.md) と [docs/mvp-scope-2026-05.md](./mvp-scope-2026-05.md) で定めた次の状態をPoC期間内に実現する。

- 認証されたオペレーターがClerk経由でログインできる。
- 管理画面で通話一覧 (電話番号、日時、要約、再架電フラグ) を確認できる。
- 管理画面でシステムプロンプトとMarkdownナレッジを編集して保存できる。
- 編集した設定が次回通話以降のAI応答に反映される。
- 既存の署名検証・プライバシーログ無効化・監査ログは引き続き機能する。

## Wave 2B-1: 設定スキーマと動的SYSTEM_MESSAGEロード

対象Issue: 新規 (本PRで起票)

- Firestore `speech-assistant-logs/adminConfig/current` を作成。
- `systemPrompt`, `knowledgeMarkdown`, `firstMessage`, `updatedAt`, `updatedBy` を持つ。
- backend起動時 + 通話開始時にフェッチし、Realtimeセッションへ反映。
- フェッチ失敗時はコードのデフォルト値へフォールバックし、監査ログに記録。

完了条件:

- `adminConfig/current` を更新すると、次回着信のAI応答に反映される。
- フェッチ失敗時もbackendは起動・応答する。

## Wave 2B-2: 再架電フラグ

対象Issue: 新規 (本PRで起票) / 既存 #15 を縮小して再利用

- `EXTRACTION_ENABLED=true` の通話要約に `needsCallback`, `callbackReason` を追加。
- Firestore `callLogs` とSheetsに列追加。
- 抽出が無効/失敗時は `needsCallback=null` で書き込む。

完了条件:

- 通話終了後、Firestore/Sheets/管理画面で再架電フラグが見える。

## Wave 2B-3: backend 管理API + Clerk認証

対象Issue: 新規 (本PRで起票) / 既存 #2 を縮小

- Clerk JWT検証 (`@clerk/backend` の `verifyToken`)。
- `GET /admin/config`, `PUT /admin/config`, `GET /admin/calls`。
- 監査ログに actor / action / target を残す。

完了条件:

- 認証なしで401。
- 認証済みでJSONを取得・更新できる。
- 設定更新が `adminConfig/current` に反映される。

## Wave 2B-4: React + Clerk 管理画面

対象Issue: 新規 (本PRで起票) / 既存 #12 を縮小

- `frontend/` にVite + React + TypeScript + Clerk SPAを構築。
- ルート: `/sign-in`, `/calls`, `/settings`。
- 通話一覧: 日時, 電話番号 (末尾4桁マスク), 要約, 再架電フラグ。
- AI設定: システムプロンプト + Markdownナレッジ + 初回発話の編集。

完了条件:

- Clerkで認証されたユーザーのみ画面を開ける。
- 通話一覧が表示され、再架電フラグでフィルタできる。
- 設定変更が次回通話に反映される。

## Wave 2B-5: PoCデプロイと結合テスト

- frontendはVercel (推奨) または既存Cloud Runへのstatic serveのいずれかで配信する (Wave 2B-4で決定)。
- 結合テスト:
  1. 認証なしで `/admin/calls` → 401。
  2. ログイン後 `/calls` で履歴表示。
  3. `/settings` で設定変更。
  4. 050番号へ実着信し、変更後のシステムプロンプトでAIが応答。
  5. 通話終了後、再架電フラグがFirestore + Sheets + 管理画面に反映。

## PoC対象外 (フェーズ2以降)

- backend TypeScript化 (#6)
- 通話状態リアルタイムイベントストリーム (#11)
- Twilio Voice SDKソフトフォン (#13) / Conference (#17) / AIリアルタイム引き継ぎ (#15)
- ベクトルRAG / チャンク化 / 検索インデックス (#14, #29)
- PDF/PowerPoint対応 (#30)
- ノードベースのコールフロー構築UI / CRM/SFA / Slack/Teams連携

凍結理由と再開タイミングは [ADR 0004](./adr/0004-mvp-scope-2026-05.md) を参照。

## 推奨順序

1. Wave 2B-1: 設定スキーマと動的SYSTEM_MESSAGEロード
2. Wave 2B-2: 再架電フラグ
3. Wave 2B-3: backend管理API + Clerk検証
4. Wave 2B-4: React + Clerk SPA
5. Wave 2B-5: PoCデプロイと結合テスト
