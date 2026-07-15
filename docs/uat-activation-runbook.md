# UAT・本番切替実績と有効化手順

## 現在の公開先

| 系統 | URL | 状態 |
|---|---|---|
| 音声受付 | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app` | Cloud Run稼働、Twilio 050切替済み |
| 練習システム | `https://phone-training-system-myegwswlka-an.a.run.app` | Cloud Run稼働、同意・録音・解析経路実装済み |

## 現在ON/OFFの機能

- DTMFゲートウェイ: ON。`5#` は練習システム、入力なし・その他はAI受付。
- 携帯転送: OFF。実際の転送先番号が未登録のため。
- Resend通知: OFF。音声システム専用APIキーが未登録のため。
- Emotion Logic: Secretリソース作成済み、値未登録。初回UATは `dummyResponse=true` で実行する。

## 請求先・データ基盤

- 音声受付プロジェクト: `cor-jp-web`
- 練習システムプロジェクト: `cor-phone-training`
- 請求先: `0164E3-53438D-30C9F9`
- 音声Firestore: `speech-assistant-logs` / `asia-northeast1`
- 練習Firestore: `practice-sessions` / `asia-northeast1`
- 練習録音バケット: `gs://cor-phone-training-recordings`

## Emotion Logic有効化

RHS確認後、値をログへ表示しない方法でSecret Managerへ登録する。

```sh
gcloud secrets versions add emotion-logic-api-key \
  --project=cor-phone-training --data-file=-
gcloud secrets versions add emotion-logic-api-key-password \
  --project=cor-phone-training --data-file=-
```

登録後、Cloud Runへ固定バージョンを注入して再起動する。

```sh
gcloud run services update phone-training-system \
  --project=cor-phone-training --region=asia-northeast1 \
  --set-secrets=EMOTION_LOGIC_API_KEY=emotion-logic-api-key:1,EMOTION_LOGIC_API_KEY_PASSWORD=emotion-logic-api-key-password:1
```

まず `EMOTION_LOGIC_DUMMY_RESPONSE=true` のまま1通話で疎通確認し、その後RHS確認済みの範囲で実分析を1通話だけ行う。

## Resend通知有効化

Resendの同一アカウント・同一送信ドメイン上で音声システム専用sendingキーを発行し、次を実行する。

```sh
gcloud secrets versions add resend-api-key \
  --project=cor-jp-web --data-file=-
gcloud run services update speech-assistant-realtime \
  --project=cor-jp-web --region=asia-northeast1 \
  --set-secrets=RESEND_API_KEY=resend-api-key:1 \
  --update-env-vars=NOTIFY_EMAIL_ENABLED=true
```

## 携帯転送有効化

担当者のE.164番号を確認してから、番号をSecret Managerへ登録する。番号はリポジトリ・issue・ログへ書かない。

```sh
gcloud secrets versions add handoff-numbers \
  --project=cor-jp-web --data-file=-
gcloud run services update speech-assistant-realtime \
  --project=cor-jp-web --region=asia-northeast1 \
  --set-secrets=HANDOFF_NUMBERS=handoff-numbers:1,HANDOFF_CALLER_ID=handoff-caller-id:1 \
  --update-env-vars=HANDOFF_ENABLED=true
```

## UAT確認

```sh
curl -fsS https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/health
curl -fsS https://phone-training-system-myegwswlka-an.a.run.app/health
```

実通話では、通常着信、`5#`、同意 `1`、録音完了、Firestore結果保存を確認する。携帯転送をONにした後はWhisperで `1` を押す経路と、無応答時のResend通知を別々に確認する。
