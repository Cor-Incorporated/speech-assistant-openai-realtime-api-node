# GCP移行runbook: aipartner-426616 → cor-jp-web

対応ADR: [ADR-0005](./adr/0005-gcp-project-migration-cor-jp-web.md) ／ 対応Wave: A1（新環境構築）、A2（切替と旧環境停止）

現行環境の実URL・実値は [cor-cloud-run-preview.md](./cor-cloud-run-preview.md) を参照。**移行先の新URLはデプロイするまで記入しない**（A2完了時に同docを更新する）。

## 前提

- 移行先GCP project: `cor-jp-web`（既存サービスは `cloudia-vertex-gateway` のみ）
- Region: `asia-northeast1`（現行と同じ）
- Cloud Run service名: `speech-assistant-realtime`（現行と同じ名前で作成）
- 実行者は `cor-jp-web` のオーナー/編集者権限を持つアカウントで `gcloud auth login` 済みであること

## Wave A1: 新環境構築

### 1. APIの有効化

cor-jp-webでは2026-07-15時点でFirestore API等が未有効。以下を有効化する。

```bash
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  sheets.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project cor-jp-web
```

### 2. Secret Managerへの移送

現行プロジェクトのSecretと同名で作成する（値は現行Secret Managerまたは運用者の手元から。**リポジトリ・チャット・docに値を書かない**）。

| Secret名 | 用途 | 備考 |
|---|---|---|
| `openai-api-key` | OpenAI API | 既存 |
| `twilio-auth-token` | Twilio署名検証 | 既存 |
| `admin-basic-password` | 管理UI Basic認証 | 既存 |
| `resend-api-key` | Resendメール通知 | Wave D1で追加（[ADR-0007](./adr/0007-notification-unification-resend.md)） |

```bash
# 例（値は対話入力やファイルからにし、シェル履歴に残さない）
gcloud secrets create openai-api-key --project cor-jp-web --replication-policy automatic
gcloud secrets versions add openai-api-key --project cor-jp-web --data-file=-
```

### 3. Firestoreデータベース作成

通話ログ用DBを新規作成する（現行と同様に専用DB、region=asia-northeast1）。DB IDは運用者が決定し、`CALL_LOG_FIRESTORE_DATABASE_ID` 環境変数に設定する。

```bash
gcloud firestore databases create \
  --project cor-jp-web \
  --database <CALL_LOG_DB_ID> \
  --location asia-northeast1 \
  --type firestore-native
```

過去ログの移行は必須ではない（旧DBは監視期間中参照可能。必要になったらエクスポート/インポートで移す）。Google Sheets運用ビューは同じスプレッドシートを継続利用できる（サービスアカウントへの共有設定を新プロジェクトのSAに付け替える）。

### 4. デプロイ

[cloud-run-deployment.md](./cloud-run-deployment.md) の手順を `--project cor-jp-web` に読み替えて実行する。環境変数は `.env.example` を基準に、少なくとも以下を新環境向けに設定する。

- `GOOGLE_CLOUD_PROJECT=cor-jp-web`
- `CALL_LOG_FIRESTORE_DATABASE_ID=<CALL_LOG_DB_ID>`
- `TWILIO_WEBHOOK_URL=<新Cloud Run URL>/incoming-call`（URL確定後）

### 5. 疎通確認（A1完了条件）

```bash
curl -fsS https://<新Cloud Run URL>/health

curl -fsS -u "$ADMIN_BASIC_USER:$ADMIN_BASIC_PASSWORD" \
  https://<新Cloud Run URL>/api/admin/health

MEDIA_STREAM_SMOKE_TIMEOUT_MS=30000 \
SMOKE_WS_URL=wss://<新Cloud Run URL>/media-stream \
npm run smoke:media-stream
```

管理UI（`/app/`）でランタイム設定・通話一覧が表示されることも確認する。

## Wave A2: Twilio webhook切替と旧環境停止

### 1. 切替前チェック

- A1の疎通確認がすべて成功している
- 新環境のFirestoreに疎通テストログが記録されている
- `TWILIO_SIGNATURE_VALIDATION_ENABLED=true` の場合、`TWILIO_WEBHOOK_URL` が新URLになっている（署名検証はURL完全一致が前提）

### 2. webhook切替

Twilio Console → Phone Numbers → 対象の050番号 → Voice Configuration の「A call comes in」を新URLの `/incoming-call` へ変更して保存する。

### 3. 実着信確認

050番号へ実際に発信し、AI応答・通話ログ記録（新Firestore）・Sheets追記を確認する。

### 4. 監視期間と旧環境停止

- 監視期間（目安: 2〜3営業日）は旧環境を**停止せず残す**（ロールバック先）。
- 問題なければ旧サービスを停止する。削除は別途判断。

```bash
# 旧環境の停止（トラフィックを受けないようにする）
gcloud run services update speech-assistant-realtime \
  --project aipartner-426616 --region asia-northeast1 \
  --min-instances 0 --max-instances 0
```

### 5. ドキュメント更新（A2完了条件に含む）

- [cor-cloud-run-preview.md](./cor-cloud-run-preview.md) の実URL・プロジェクトIDを新環境の値へ更新
- `Readme.md` のCloud Run Preview URLを更新
- GitHubリポジトリのhomepage設定を更新

## ロールバック

切替後に問題が発生した場合:

1. Twilio webhookを旧URL（cor-cloud-run-preview.mdに記録済み）へ戻す（即時復旧）
2. 新環境のログ（Cloud Run logs / Firestore）で原因を調査
3. 修正後に再度切替

## 注意

- WebSocket長時間接続のため `--timeout 3600`、`--min-instances 1`（コールドスタート回避）は現行設定を踏襲する。
- Dockerビルドは Apple Silicon から行う場合 `--platform linux/amd64` を明示する（`--source .` のCloud Buildなら不要）。
