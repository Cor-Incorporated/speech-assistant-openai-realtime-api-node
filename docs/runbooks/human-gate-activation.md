# 人間転送・留守電の有効化と実機確認

対応ADR: [ADR-0010](../adr/0010-human-gate-voicemail-fallback.md)。

## 現在の設定と受入条件

2026-11-07の実環境確認では、転送とメール通知は既に有効だった。マージによる自動デプロイで新しい留守電経路が有効になる。

- 転送先はユーザー承認済みの担当者番号。`handoff-numbers:2` の値を読み戻し、指定番号との一致を確認済み。番号自体はリポジトリへ記載しない。
- 緊急の人間対応が必要な通話を転送する。非緊急の見積・開発相談、営業、一般案内はAIが受付し、通話後にメール通知する。複雑な相談は高精度AIで整理し、人間判断が必要な場合だけ転送する。
- 担当者には要約を読み上げ、1で接続、2・無入力・切断・不在等で受付側留守電へ進む。
- 転送開始は人間の接続成功ではない。最終callbackまで「対応済み」にしない。
- 留守電は `completed` / `absent` を正とし、録音あり・なしの通知を1通送る。actionの録音時間はtrim前なので最終判定に使用しない。
- 通知先はGitHub Variablesが正。実環境TOは `cloudia@cor-jp.com`、CCは `company@cor-jp.com,nagisa.terada@cor-jp.com`。廃止先 `k.isayama@cor-jp.com` は保存済み通知の再送時も除外する。
- `LIVE_VOICE=harema` を実APIの音声入出力・委譲で確認済み。電話越しの聴感は人間の受入確認で行う。

## デプロイ

1. PRのCI、秘密情報スキャン、H5 Admissionを確認する。
2. PR経由で `develop` へマージする。Deploy Cloud Runがclean checkoutからデプロイする。ローカルの `.worktrees` を含むrootから `--source .` を実行しない。
3. Actionsのcheckout SHA、Cloud Runのrevision・image・traffic 100%を照合する。
4. `HANDOFF_NUMBERS=handoff-numbers:2`、`HANDOFF_FALLBACK_MODE=voicemail`、`LIVE_VOICE=harema`、通知設定のreadbackを行う。秘密値はログに出さない。
5. Twilio着信Webhookと日本宛て発信許可、Resend送信ドメインを確認する。

```bash
gcloud run services describe speech-assistant-realtime --project cor-jp-web --region asia-northeast1 --format='value(status.latestReadyRevisionName)'
```

本番はTwilio署名検証を有効にしている。`smoke:local` はローカル署名無効環境向けであり、そのまま本番へ向けない。本番では署名付き `/incoming-call` のTwiML、署名なし403、認証付きMedia Streams音声出力を別々に確認する。

## 通知失敗の扱い

- 録音callbackは `#rc=2&rp=ct,rt,5xx` を指定し、短期の503・接続失敗を再試行する。fragmentはTwilio署名の対象外。
- 録音取得2秒、文字起こし5秒、メール送信3秒を上限とする。文字起こしが失敗しても再生リンクと失敗理由を通知する。
- Firestore outboxの固定IDと送信権、ResendのIdempotency-Keyで重複を抑える。通知失敗を送信済みにしない。
- 再試行回数を超える長期障害では `mailOutbox` のfailedを管理APIから再試行する。受理済みと配信済みは別の状態として確認する。

## 実機確認

夜間の自動確認はユーザーが許可した番号だけに発信し、各通話に時間上限を設定する。人間の応答が必要な項目は指定の待機時間後に実施する。

| # | シナリオ | 期待結果 |
|---|---|---|
| H-1 | 至急の納品障害、担当者が1を押す | 要約後に双方が会話できる。最終結果が接続済みになる |
| H-2 | 同上、担当者が2を押す | 受付側留守電へ進み、録音・文字起こし・メール1通 |
| H-3 | 同上、担当者が応答しない | 受付側留守電へ進み、録音・通知 |
| H-4 | 担当者が無入力または切断 | 留守電へ進む。AI受付へ戻らない |
| H-5 | 緊急性のない開発見積 | 人間への発信なし。AI受付後にメール1通 |
| H-6 | 営業・資料請求 | 人間への発信なし。AIが受付・終了しメール通知 |
| H-7 | 留守電の最終状態がabsent | 録音なし通知1通 |
| H-8 | 生命・身体の危険 | 会社担当者への転送ではなく110/119案内 |
| H-9 | 通知の再生リンク | 未認証拒否、管理者認証後に録音を取得できる |

テスト通話のCall SID、転送子レッグ、録音SID、通知provider IDを照合する。番号・通話全文・録音はリポジトリへコミットしない。

## ロールバック

`HANDOFF_FALLBACK_MODE=ai_reception` で従来のAI復帰、`HANDOFF_ENABLED=false` で転送停止。GitHub Variableを更新して再デプロイする。緊急時はCloud Runのtrafficを直前revisionへ戻す。手動env変更は次回デプロイに上書きされる。

## 一次資料

- [Twilio Record](https://www.twilio.com/docs/voice/twiml/record): completed/absentとtrim前のaction時間
- [Webhook接続設定](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides): 再試行・署名・15秒上限
- [GPT-Live音声設定](https://developers.openai.com/api/docs/guides/live-conversations): 日本語音声harema
