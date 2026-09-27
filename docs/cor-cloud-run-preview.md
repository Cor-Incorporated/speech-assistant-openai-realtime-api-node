# Cor. Cloud Run Preview URL

## Migration Status (2026-09-27)

[ADR-0005](./adr/0005-gcp-project-migration-cor-jp-web.md) の移行は完了した。本サービスの正本は `cor-jp-web` プロジェクト（runbook: [gcp-migration-cor-jp-web.md](./gcp-migration-cor-jp-web.md)）。

| 環境 | GCPプロジェクト | 状態 | URL |
| --- | --- | --- | --- |
| 現行 | `cor-jp-web` | 稼働中 | 下記 Exact URLs の通り |
| 旧 | `aipartner-426616` | 2026-09-27 にプロジェクトごと削除（`gcloud projects undelete aipartner-426616` で 2026-10-27 まで復元可） | 使用しない（旧URL `https://speech-assistant-realtime-mggisi6odq-an.a.run.app`） |

2026-09-27 時点の実測:

- `cor-jp-web` の Cloud Run リビジョンは 48 個。初版 `speech-assistant-realtime-00001-2hq` が 2026-07-15、最新 `speech-assistant-realtime-00048-xtf` が 2026-09-22
- Twilio からの `/incoming-call`（POST）は、直近30日のログで `cor-jp-web` に 8 件（2026-09-18〜2026-09-21、すべて 200）
- 旧 `aipartner-426616` の `speech-assistant-realtime` へのリクエストは、削除前 7 日間（2026-09-20〜27）で 0 件

## Current Deployment

This repository is deployed by Cor.株式会社 to the following Google Cloud Run service.

| Item | Value |
| --- | --- |
| GCP project ID | `cor-jp-web` |
| GCP project name | `cor-jp-web` |
| Region | `asia-northeast1` |
| Cloud Run service | `speech-assistant-realtime` |
| Service URL | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app` |
| Alternate URL | `https://speech-assistant-realtime-821571105160.asia-northeast1.run.app`（Cloud Run の決定論URL。Twilio には使わない） |
| Runtime service account | `speech-assistant-runtime@cor-jp-web.iam.gserviceaccount.com` |
| Min instances | `1` |

## Exact URLs

| Purpose | URL |
| --- | --- |
| Admin UI | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/app/` |
| Health check | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/health` |
| Twilio Voice webhook | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/incoming-call` |
| Twilio Media Streams WebSocket | `wss://speech-assistant-realtime-qvghygsdwq-an.a.run.app/media-stream` |
| Admin API health | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/api/admin/health` |
| Admin runtime config | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/api/admin/runtime-config` |

## Twilio Settings

- `TWILIO_SIGNATURE_VALIDATION_ENABLED=true` のため、Twilio 電話番号の Voice webhook（A call comes in / HTTP POST）は Cloud Run の環境変数 `TWILIO_WEBHOOK_URL`（`https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/incoming-call`）と一字一句同じ URL にする。Alternate URL に向けると署名検証で拒否される。
- Media Streams の `wss://` URL は Twilio コンソールでは設定しない。アプリが着信リクエストの `Host` ヘッダー（Twilio が叩いたホスト）を TwiML の `<Stream>` に入れて返す（`index.js` の `buildMediaStreamTwimlWithParams({ host: request.headers.host })` → `lib/twiml.js`）。そのため Voice webhook を上記 URL にすれば、Media Streams も同じホストになる。
- Twilio の認証トークンは Secret Manager の `twilio-auth-token`（`cor-jp-web`）で管理する。

## Access Notes

- `/app/` and `/api/admin/*` require HTTP Basic Auth.
- The admin password is intentionally not committed. Manage it via Google Secret Manager `admin-basic-password` (project `cor-jp-web`) and local handoff notes only.
- This is Cor.株式会社's preview/runtime environment. Delivery repositories and external handoff documents must use placeholders such as `https://<cloud-run-host>/app/`.
- The repository homepage is set to `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/app/`.

## Verification Commands

```bash
gcloud run services describe speech-assistant-realtime \
  --project cor-jp-web \
  --region asia-northeast1 \
  --format='value(status.latestReadyRevisionName,status.url)'

curl -fsS https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/health

curl -fsS -u "$ADMIN_BASIC_USER:$ADMIN_BASIC_PASSWORD" \
  https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/api/admin/health

MEDIA_STREAM_SMOKE_TIMEOUT_MS=30000 \
SMOKE_WS_URL=wss://speech-assistant-realtime-qvghygsdwq-an.a.run.app/media-stream \
npm run smoke:media-stream
```
