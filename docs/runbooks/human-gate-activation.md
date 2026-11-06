# 人間ゲート 有効化・実機確認 Runbook

対応ADR: [ADR-0010](../adr/0010-human-gate-voicemail-fallback.md)

実装とテストは完了済みです。本番有効化と実機確認は、Cloud/Twilio/Resendの認証情報と担当者の応答が必要なため人間が行います。

## 0. 前提

- 転送先: `+817085611659`（07085611659）。リポジトリへは書かず、Secret Managerだけに置く。
- 通知先: `NOTIFY_EMAIL_TO`（既定 `cloudia@cor-jp.com`）、`NOTIFY_EMAIL_CC`（既定 `company@cor-jp.com`）。`k.isayama@cor-jp.com` は廃止済みで、コード側で常に除外される。
- デプロイは `develop` へのマージで `.github/workflows/deploy-cloud-run.yml` が実行する（`gcloud run services update` での直接変更は次回デプロイで上書きされる）。

## 1. 有効化手順（デプロイ前）

1. 転送先をSecret Managerへ登録する。1つの番号を渡せば `contract`（受託）・`general`（緊急）の両方がその番号へ行く。

   ```bash
   printf '%s' '+817085611659' | gcloud secrets versions add handoff-numbers --project cor-jp-web --data-file=-
   gcloud secrets versions list handoff-numbers --project cor-jp-web
   ```

   ワークフローはSecretを `handoff-numbers:1` のようにバージョン固定で参照している。追加したバージョン番号（例: 2）に合わせて `deploy-cloud-run.yml` の `handoff-numbers:1` を更新する（このPRに含めるか、追加PRにする）。現在のバージョン1の転送先が `+817085611659` と異なる場合は、この更新が必須。
2. `handoff-caller-id` に発信者ID（着信に使うTwilio番号、E.164）が入っていることを確認する。
3. `resend-api-key` が存在し、`NOTIFY_EMAIL_FROM` のドメインがResendで検証済みであることを確認する。
4. GitHub Repository Variablesを設定する。

   ```bash
   gh variable set HANDOFF_ENABLED --body true -R Cor-Incorporated/speech-assistant-openai-realtime-api-node
   gh variable set NOTIFY_EMAIL_ENABLED --body true -R Cor-Incorporated/speech-assistant-openai-realtime-api-node
   # 通知CCに廃止済みアドレスが残っていないか確認（残っていてもコードが除外する）
   gh variable list -R Cor-Incorporated/speech-assistant-openai-realtime-api-node | grep -i NOTIFY
   ```

5. PRをレビュー後 `develop` へマージし、Deploy Cloud Runの成功を確認する。
6. Twilio Console: 着信番号のVoice URLが `https://<cloud-run-url>/incoming-call` であること、Voice Geographic Permissionsで日本（発信先 +81）が許可されていることを確認する。

## 2. デプロイ後の機械的確認

```bash
SMOKE_BASE_URL=https://<cloud-run-url> npm run smoke:local
gcloud run services describe speech-assistant-realtime --project cor-jp-web --region asia-northeast1 \
  --format='value(status.latestReadyRevisionName)'
# HANDOFF_* / VOICEMAIL_* / NOTIFY_EMAIL_* が反映されていること
gcloud run services describe speech-assistant-realtime --project cor-jp-web --region asia-northeast1 \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep -E "HANDOFF|VOICEMAIL|NOTIFY"
```

`/handoff/whisper` へ署名なしでPOSTすると403になること（署名検証が有効）も確認する。

## 3. 人間による実機確認（担当者が応答できる時間に実施）

発信者用の電話から着信番号へ発信して確認する。結果は [テスト報告](../reports/2026-11-07-human-gate-callcenter-report.md) の表へ記入する。

| # | 発信者の発話 | 担当者の操作 | 期待結果 |
|---|---|---|---|
| H-1 | 「御社に納品してもらった画面が動かないので、至急見てほしいです」 | 着信に出て、要約を聞き、1を押す | 要約（用件・緊急）が読み上げられ、押下後に発信者と会話できる |
| H-2 | 同上 | 着信に出て、要約を聞き、2を押す | 発信者が留守番電話案内に入り、録音できる。数十秒以内に「留守電あり（要折り返し）」メールが届き、文字起こしと発信者番号がある |
| H-3 | 同上 | 着信に出ない（20秒以上鳴らす） | 発信者が留守番電話案内に入り、H-2と同じメールが届く |
| H-4 | 同上 | 着信に出て、何も押さず切る | H-3と同じ |
| H-5 | 「新しい予約システムの開発の見積もりをお願いしたい」（急ぎとは言わない） | H-1と同様 | AIが受付後に担当者へ転送を依頼し、H-1と同じ流れ |
| H-6 | 「弊社の広告サービスのご案内です」 | （着信なし） | 担当者の電話は鳴らない。AIが受付を終え、通話後に要約メールが届く |
| H-7 | 「営業時間を教えてください」「資料を送ってほしい」 | （着信なし） | 担当者の電話は鳴らない。AIが対応・受付を終え、メールが届く |
| H-8 | 「火事です」 | （着信なし） | 転送されず、110/119の案内になる |
| H-9 | （H-2の留守電のあと）メール内の再生リンクを開く | — | 管理画面のBasic認証後に録音が再生できる |

通知メールの宛先に `k.isayama@cor-jp.com` が含まれていないことも、届いたメールのヘッダで確認する。

## 4. ロールバック

- 留守電を止めて従来のAI受付復帰へ戻す: `gh variable set HANDOFF_FALLBACK_MODE --body ai_reception` → `gh workflow run deploy-cloud-run.yml`
- 転送自体を止める: `gh variable set HANDOFF_ENABLED --body false` → 再デプロイ（AIが受付を完結しメール通知する）
- 直前リビジョンへ戻す: `gcloud run services update-traffic speech-assistant-realtime --to-revisions <旧リビジョン>=100 --region asia-northeast1`

## 5. 費用の目安

- 留守電の文字起こし: 1通あたり数円以下（`gpt-4o-transcribe`、最大120秒）。
- 転送要約: 1回あたり1円未満の見込み。
- Twilioの転送レッグ（日本の携帯宛）と録音保管は、通話量に応じて従量課金。今回の確認通話数回の範囲では数ドル以内。
- Cloud Runは `min-instances=0` のまま。
