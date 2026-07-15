# Resend通知設計: Firestore Outboxによるメール通知

対応ADR: [ADR-0007](./adr/0007-notification-unification-resend.md) ／ 対応Wave: D1

## ゴール

音声問い合わせ（通話）の内容が、テキスト問い合わせ（Cloudia）と同じ宛先へ、同等の信頼性でメール通知される。

## 参照アーキテクチャ: Cloudia（cor-contact-chat）

corsweb2024リポジトリの `workers/contact-chat`（Cloudflare Worker）が既にResend通知を実装している。設計上引き継ぐべき性質:

- **Outboxパターン**: 送信要求を永続化（D1）してからQueue経由で非同期送信。API受付（`accepted`）と配信の区別、`delivery_status`（queued → sending → accepted / failed）管理
- **fail closed**: `RESEND_API_KEY` 未設定時は503を返し、問い合わせをサイレントに握り潰さない
- **PII最小化**: Queue payloadにPIIを載せない（IDのみ）
- 宛先: `cloudia@cor-jp.com`（運用値。環境変数で管理）

D1/QueuesはCloudflare Workerランタイム固有のため流用せず、本システムでは**Firestore**で同型を実装する。

## 本システムでの設計

### Outboxコレクション

Firestore（通話ログと同じDB）に `mailOutbox` コレクションを追加する。

```text
mailOutbox/{outboxId}:
  kind: 'call-summary' | 'handoff-fallback'
  callId: <対応する通話>
  to / cc / from: 運用値（環境変数から）
  subject, bodyRef または本文フィールド
  status: 'queued' | 'sending' | 'accepted' | 'failed'
  attempts, lastError, providerMessageId
  createdAt, updatedAt
```

### 送信ワーカー

Cloud Runの単一サービス構成を維持するため、まずはアプリ内の軽量ワーカー（通話終了時に即時送信を試み、失敗したらoutboxに`queued`で残して定期リトライ）で実装する。Cloud Tasks/Scheduler の導入はスケール要件が出てから検討する（実装issueで判断を記録する）。

### 送信契機

| 契機 | kind | 本文 |
|---|---|---|
| 通話終了（正常終話） | `call-summary` | 通話サマリ: 日時、用件（`extractCallDetails` の抽出結果）、折り返し番号、通話時間、管理UIへのリンク |
| Handoff不応答フォールバック（[handoff-phase1-pstn-transfer.md](./handoff-phase1-pstn-transfer.md) Wave C3） | `handoff-fallback` | 「担当者不応答。折り返しが必要」+ サマリ |

疎通確認通話（`CA_SMOKE` プレフィクス）は送信対象から除外する（既存のsmokeログ除外方針と整合）。

### 環境変数・Secret

| 名前 | 種別 | 説明 |
|---|---|---|
| `NOTIFY_EMAIL_ENABLED` | env（既定 `false`） | 機能フラグ |
| `NOTIFY_EMAIL_TO` / `NOTIFY_EMAIL_CC` / `NOTIFY_EMAIL_FROM` | env | 宛先運用値。Cloudia側と揃える |
| `resend-api-key` | Secret Manager | Resend APIキー。Cloudia側と同一キー共有か別発行かは実装時にResendダッシュボードで確認して決定 |

### 信頼性・プライバシー

- `RESEND_API_KEY` 未設定かつ `NOTIFY_EMAIL_ENABLED=true` の場合、起動時に警告し、outboxには`failed`を残す（通話自体は止めない。受付システムの「どの部品が落ちても通話は完了する」原則に従う）
- メール本文には折り返し電話番号等のPIIが含まれる。outboxドキュメントの保持期間を決め、本番ログには本文を出力しない（`maskPhone` 方針維持）
- Resendの`accepted`はAPI受付を意味し最終配信の保証ではない。配信イベントWebhook連携は将来課題（Cloudia側と同判断）

## テスト方針

- `node --test`: outbox状態遷移、リトライ、fail closed、smoke除外のユニットテスト（Resend APIはフェイク注入）
- 手動: テスト通話→メール到達確認（結果をPR本文へ記録）
