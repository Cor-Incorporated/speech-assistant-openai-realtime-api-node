# Cor. Cloud Run Preview URL

## Migration Status (2026-07-15)

[ADR-0005](./adr/0005-gcp-project-migration-cor-jp-web.md) により、本サービスは `cor-jp-web` プロジェクトへの段階移行が決定済み（runbook: [gcp-migration-cor-jp-web.md](./gcp-migration-cor-jp-web.md)、Wave A1/A2）。

| 環境 | GCPプロジェクト | 状態 | URL |
| --- | --- | --- | --- |
| 現行 | `aipartner-426616` | 稼働中（下記参照） | 下記 Exact URLs の通り |
| 移行先 | `cor-jp-web` | 未構築 | `<未発行: Wave A1でデプロイ後に記入>` |

**注意**: 移行先URLはデプロイ前に推測で記入しない。Wave A2完了時に本docと `Readme.md` の実URLを更新する。

## Current Deployment

This repository is deployed by Cor.株式会社 to the following Google Cloud Run service.

| Item | Value |
| --- | --- |
| GCP project ID | `aipartner-426616` |
| GCP project name | `AIPartner` |
| Region | `asia-northeast1` |
| Cloud Run service | `speech-assistant-realtime` |
| Service URL | `https://speech-assistant-realtime-mggisi6odq-an.a.run.app` |

## Exact URLs

| Purpose | URL |
| --- | --- |
| Admin UI | `https://speech-assistant-realtime-mggisi6odq-an.a.run.app/app/` |
| Health check | `https://speech-assistant-realtime-mggisi6odq-an.a.run.app/health` |
| Twilio Voice webhook | `https://speech-assistant-realtime-mggisi6odq-an.a.run.app/incoming-call` |
| Twilio Media Streams WebSocket | `wss://speech-assistant-realtime-mggisi6odq-an.a.run.app/media-stream` |
| Admin API health | `https://speech-assistant-realtime-mggisi6odq-an.a.run.app/api/admin/health` |
| Admin runtime config | `https://speech-assistant-realtime-mggisi6odq-an.a.run.app/api/admin/runtime-config` |

## Access Notes

- `/app/` and `/api/admin/*` require HTTP Basic Auth.
- The admin password is intentionally not committed. Manage it via Google Secret Manager `admin-basic-password` and local handoff notes only.
- This is Cor.株式会社's preview/runtime environment. Delivery repositories and external handoff documents must use placeholders such as `https://<cloud-run-host>/app/`.
- The repository homepage is set to `https://speech-assistant-realtime-mggisi6odq-an.a.run.app/app/`.

## Verification Commands

```bash
gcloud run services describe speech-assistant-realtime \
  --project aipartner-426616 \
  --region asia-northeast1 \
  --format='value(status.latestReadyRevisionName,status.url)'

curl -fsS https://speech-assistant-realtime-mggisi6odq-an.a.run.app/health

curl -fsS -u "$ADMIN_BASIC_USER:$ADMIN_BASIC_PASSWORD" \
  https://speech-assistant-realtime-mggisi6odq-an.a.run.app/api/admin/health

MEDIA_STREAM_SMOKE_TIMEOUT_MS=30000 \
SMOKE_WS_URL=wss://speech-assistant-realtime-mggisi6odq-an.a.run.app/media-stream \
npm run smoke:media-stream
```
