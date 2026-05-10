# Cloud Runデプロイ手順

## 目的

ローカル検証済みのNode/Fastify + Twilio Media Streams + OpenAI Realtime構成を、Google Cloud Run上で常時起動できる最小基盤として動かします。

## 前提

- GCP project: `your-gcp-project-id`
- Cloud Run region: `asia-northeast1`
- Cloud Run service: `speech-assistant-realtime`
- Secret Manager secret: `openai-api-key`
- Secret Manager secret: `twilio-auth-token`
- Secret Manager secret: `admin-basic-password`
- GitHub repository: `Cor-Incorporated/speech-assistant-openai-realtime-api-node`

## 手動デプロイ

```bash
gcloud run deploy speech-assistant-realtime \
  --project your-gcp-project-id \
  --region asia-northeast1 \
  --source . \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 5 \
  --concurrency 20 \
  --timeout 3600 \
  --cpu 1 \
  --memory 512Mi \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest,TWILIO_AUTH_TOKEN=twilio-auth-token:latest,ADMIN_BASIC_PASSWORD=admin-basic-password:latest \
  --set-env-vars REALTIME_MODEL=gpt-realtime-2,REALTIME_REASONING_EFFORT=low,TRANSCRIPTION_MODEL=gpt-4o-transcribe,EXTRACTION_MODEL=gpt-5.4-mini,EXTRACTION_ENABLED=true,VOICE=marin,AUDIO_FORMAT=audio/pcmu,AUDIO_NOISE_REDUCTION=near_field,VAD_TYPE=server_vad,VAD_THRESHOLD=0.65,VAD_PREFIX_PADDING_MS=300,VAD_SILENCE_DURATION_MS=700,VAD_EAGERNESS=low,LOG_TRANSCRIPTS=false,LOG_REALTIME_EVENTS=false,LOG_OPENAI_RESPONSES=false,TWILIO_SIGNATURE_VALIDATION_ENABLED=true,TWILIO_WEBHOOK_URL=https://your-app.run.app/incoming-call,GOOGLE_CLOUD_PROJECT=your-gcp-project-id,CALL_LOG_FIRESTORE_ENABLED=true,CALL_LOG_FIRESTORE_DATABASE_ID=your-firestore-database-id,CALL_LOG_FIRESTORE_COLLECTION=callLogs,CALL_LOG_SHEETS_ENABLED=true,GOOGLE_SHEETS_SPREADSHEET_ID=your-spreadsheet-id,ADMIN_BASIC_USER=admin
```

## CI/CD

`.github/workflows/deploy-cloud-run.yml` は `develop` へのpush時、または手動実行時にCloud Runへデプロイします。

認証はGitHub Actions OIDC + Google Cloud Workload Identity Federationを使います。長期のGCPサービスアカウントキーはGitHubへ保存しません。

`ADMIN_BASIC_USER` はGitHub Repository Variable、`ADMIN_BASIC_PASSWORD` はGoogle Cloud Secret Manager `admin-basic-password` で管理します。GitHub Secretに管理UIパスワードを保存しない構成です。

## Twilio設定

Cloud Runデプロイ後、サービスURLが次のように得られます。

```bash
gcloud run services describe speech-assistant-realtime \
  --project your-gcp-project-id \
  --region asia-northeast1 \
  --format='value(status.url)'
```

一時検証ではTwilio番号のVoice URLを次の形式にします。

```text
https://<cloud-run-url>/incoming-call
```

本番の050番号恒久切替は、Cloud Run上で `/health`、`/incoming-call`、実通話、ログ、署名検証を確認してから行います。

## 管理UI

管理UIは `https://<cloud-run-url>/app/` で配信します。`/app` と `/api/admin/*` はHTTP Basic認証で保護されます。外部提供用のリポジトリや資料にはCor.検証環境の実URLを記載せず、`https://<cloud-run-host>/app/` のようなプレースホルダーを使います。

## 通話ログ

通話ログは既存Firebaseのdefault databaseではなく、専用Firestore named database `your-firestore-database-id` の `callLogs` に保存します。Google Sheets `your-spreadsheet-id` は運用ビューとして通話終了時に1行追記します。

Cloud Run実行サービスアカウント `<service-account>@<project>.iam.gserviceaccount.com` を、対象スプレッドシートの編集者として共有してください。

## 注意点

- `--min-instances 1` により常時待機します。費用が発生するため、不要になったら0へ戻します。
- Cloud RunのWebSocketはリクエストtimeoutの影響を受けます。現時点では `3600` 秒に設定します。
- Twilio webhook署名検証には、Twilio ConsoleのAccount Auth TokenをSecret Manager `twilio-auth-token` に保存する必要があります。
