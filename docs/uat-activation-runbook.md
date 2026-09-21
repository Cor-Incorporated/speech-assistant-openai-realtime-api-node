# UAT・本番切替実績と有効化手順

## 現在の公開先

| 系統 | URL | 状態 |
|---|---|---|
| 音声受付 | `https://speech-assistant-realtime-qvghygsdwq-an.a.run.app` | Cloud Run稼働、Twilio 050切替済み |
| 練習システム | `https://phone-training-system-myegwswlka-an.a.run.app` | Cloud Run稼働、同意・録音・解析経路実装済み |

## 現在ON/OFFの機能（2026-09-20時点）

- DTMFゲートウェイ: ON。`5#` は練習システム、入力なし・その他はAI受付。
- 携帯転送: **ON**。`handoff-numbers`シークレットに `contract`/`general` 宛先を登録済み。転送テストは実番号が鳴るため事前に受け手を用意する。
- Resend通知: **ON**（`NOTIFY_EMAIL_ENABLED=true`）。
- 音声プロバイダ: **GPT-Live**（`VOICE_PROVIDER=live`、Realtimeへは `LIVE_FALLBACK_TO_REALTIME=true` で自動復帰）。
- ルーティング: `ROUTING_PROVIDER=jev_shadow`（Jevはshadow専用・判定権限なし）。
- Media Streams認証: **ON**（`TWILIO_STREAM_AUTH_ENABLED=true`）。詳細は `docs/media-stream-authentication.md`。
- admin v2コンソール: ON（`/app/#v2`、`ADMIN_V2_SUBJECT_MAP`でroles付与済み）。
- 知識DB: seed投入・release公開済み（`rel_20260919004348_9b492cc4`、公開52件）。draft/internalは音声応答に出ない。
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
# stdinへ実番号をJSONで入力する（値はログ・履歴へ出さない）。
# {"contract":"+81...","general":"+81..."}
gcloud secrets versions add handoff-numbers \
  --project=cor-jp-web --data-file=-
gcloud run services update speech-assistant-realtime \
  --project=cor-jp-web --region=asia-northeast1 \
  --set-secrets=HANDOFF_NUMBERS=handoff-numbers:1,HANDOFF_CALLER_ID=handoff-caller-id:1 \
  --update-env-vars=HANDOFF_ENABLED=true
```

## UAT確認

```sh
curl -fsS -o /dev/null -w "%{http_code}\n" https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/
curl -fsS -o /dev/null -w "%{http_code}\n" https://phone-training-system-myegwswlka-an.a.run.app/
```

※ `/health` / `/healthz` はルート未定義のため `404` を返す。稼働確認は `/` の `200` を使う。

実通話では、通常着信、`5#`、同意 `1`、録音完了、Firestore結果保存を確認する。シナリオ一式・タイミング基準・転送先の実番号はテスト担当向け配布物 `ai-reception-scenario-test-2026-09-18.md`（リポジトリ外の配布ファイル）を参照する。実番号はリポジトリ・issue・ログへ書かない。

追加で確認する項目:

- Media Streams: `TWILIO_STREAM_AUTH_ENABLED=true` ではトークン無しのWS接続は4408/4403で拒否される。実通話のTwiMLでは `wss://<host>/media-stream/<token>` のパス埋込み + `<Parameter name="stream_token">` が出ること（署名付き `/gateway/route` で確認可能）。
- 無音上限: tool実行中の応答が10秒（`LIVE_TOOL_WATCHDOG_MS`）停滞すると「確認して折り返します」系の案内、さらに無応答なら終話ワークフロー。長時間の無音があれば障害報告。
- 携帯転送: Whisperで `1` を押す経路と、無応答時の復帰案内・Resend通知を別々に確認する。
