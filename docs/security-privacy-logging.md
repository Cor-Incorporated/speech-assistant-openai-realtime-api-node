# セキュリティ・監査・プライバシー運用

## Twilio署名検証

`/incoming-call` はTwilio webhook署名を検証します。本番Cloud Runでは次を設定します。

```text
TWILIO_SIGNATURE_VALIDATION_ENABLED=true
TWILIO_WEBHOOK_URL=https://your-app.run.app/incoming-call
TWILIO_AUTH_TOKEN=<Secret Manager: twilio-auth-token>
```

`TWILIO_AUTH_TOKEN` はTwilio ConsoleのAccount Auth TokenをSecret Managerに保存します。Twilio CLIのAPI Key Secretでは署名検証できません。

## ログ方針

本番では次をデフォルトにします。

```text
LOG_TRANSCRIPTS=false
LOG_REALTIME_EVENTS=false
LOG_OPENAI_RESPONSES=false
```

Cloud Runログには全文文字起こし、電話番号、OpenAI応答本文を出しません。通話内容の正本は専用Firestore `your-firestore-database-id/callLogs` に保存し、Google Sheetsは運用ビューとして使います。

## 監査ログ

Cloud RunログにはJSON形式で監査イベントを出します。

```json
{
  "audit": {
    "actor": "twilio",
    "action": "call.started",
    "target": "CAxxxxxxxx",
    "result": "success",
    "timestamp": "2026-04-26T00:00:00.000Z"
  }
}
```

記録する主なイベント:

- `twilio.webhook.accepted`
- `twilio.webhook.rejected`
- `call.started`
- `call.completed`

電話番号は末尾4桁以外をマスクします。

## 保持期間

初期運用ではFirestoreとSheetsに保存します。正式運用前に次を決めます。

- 通話ログの保持期間
- 文字起こし削除の申請手順
- Sheets閲覧者と編集者
- BigQuery分析用データセットの保持期間

## 管理APIの権限境界

Basic認証の資格情報が一致しても、操作権限は `ADMIN_V2_SUBJECT_MAP` に登録した
subject/rolesから判断します。未登録のユーザーは `viewer` となり、旧API経由でも
権限を引き上げられません。権限表の正本は `src/admin/permissions.ts`、旧APIと
録音・通知APIの共通強制点は `lib/admin-access.js` です。backendのビルドがなく
権限表を読み込めない場合、旧APIは503で停止します。

| 操作 | 必要権限 | 標準ロール |
| --- | --- | --- |
| v2通話の伏字表示・件数 | `calls.read` | viewer / operator / supervisor / privacy_admin |
| 旧通話APIの氏名・電話番号・全文、録音再生 | `calls.read_pii` | operator / supervisor / privacy_admin |
| 旧通話APIの業務状態変更 | `calls.correct` | operator / supervisor |
| テスト・空通話の削除 | `calls.delete` | supervisor |
| 稼働中のモデル設定変更 | `runtime.edit` | supervisor |
| 既存通知の再送 | `notifications.retry` | operator / supervisor |

`calls.read_pii` のないv2閲覧者には、自由記述の要約・用件・変更理由、変更履歴の
新旧値、監査イベントのmetadata、引継ぎ案件の要約・解決メモを返しません。電話番号は末尾4桁だけを残します。
履歴経由で伏字前の氏名や電話番号を取得することもできません。

旧APIを含む管理APIの更新は、Origin/Refererがあれば同一hostであることを検査し、
本文がある場合は `application/json` を必須にします。認証成功だけで更新を許可する
旧経路は設けません。回帰確認は `node --test test/admin-access.test.js` で行います。
