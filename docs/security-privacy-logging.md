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

