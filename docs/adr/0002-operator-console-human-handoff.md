# ADR 0002: オペレーターコンソールと人間への引き継ぎ

- ステータス: PoC対象外 (フェーズ2以降で再開)
- 日付: 2026-04-26 (初版) / 2026-05-10 (PoCスコープに合わせ改訂)
- 対象: React管理画面、通話監視、AIパスアップ、オペレーターWebRTC、Twilio Conference制御
- 関連: [ADR 0004 MVPスコープ凍結](./0004-mvp-scope-2026-05.md)

> **改訂メモ (2026-05-10):** PoC納期に合わせ、本ADRが扱う「オペレーターWebRTC通話参加」「Twilio Conference参加者制御」「リアルタイム通話状態配信 (SSE/WS)」はPoC対象外としました。PoCでは代わりに「再架電フラグ + 人間が後で架電」という非同期運用を採用します ([ADR 0004](./0004-mvp-scope-2026-05.md))。
>
> 一方、本ADRに含まれる「React管理画面の通話一覧」「設定 (instructions, voice, model 等) 編集」「監査ログ」のうち、PoCで必要となる最小サブセット (通話一覧 + システムプロンプト + Markdownナレッジ + 再架電フラグ) は ADR 0004 と [docs/mvp-scope-2026-05.md](../mvp-scope-2026-05.md) で改めて定義しています。
>
> 認証基盤の未決事項は [ADR 0005 Clerk採用](./0005-clerk-authentication.md) で決定しました。

## 背景

このシステムは完全自律の音声ボットではなく、日本のコールセンターでAIと人間が協調する前提です。AIが対応し、必要に応じて人間オペレーターへパスアップし、オペレーターが同じ画面から顧客通話へ参加できる必要があります。

現行コードにはフロントエンド、リアルタイム通話イベント、オペレーターID、通話制御がありません。Reactだけでは通話参加は実現できないため、Twilio Voice SDKとConference制御が必要です。

## 決定

React + TypeScriptでオペレーターコンソールを作り、Fastify backendが設定、ログ、Twilio token、Conference制御を提供します。オペレーターの音声参加にはTwilio Voice JavaScript SDKを使います。

AIは従来通りbackendからTwilio Media StreamsとOpenAI Realtime WebSocketへ接続します。オペレーターはブラウザからTwilioへWebRTC接続し、backendがConference参加者を制御します。

## 引き継ぎ状態

```text
ai_active
  -> escalation_requested
  -> operator_ringing
  -> operator_joined
  -> ai_muted_or_removed
  -> human_active
  -> call_completed
```

オペレーターが手動で介入する場合は、`ai_active` から `operator_ringing` へ直接遷移できます。

## コンソール機能

- 通話一覧: 状態、経過時間、顧客番号、AI状態、パスアップ状態
- 通話詳細: ユーザー/AI発話、文字起こし、タイムライン
- デバッグ: VAD、Realtimeイベント、割り込み、応答生成
- 設定: instructions、初回発話、voice、model、transcription、VAD profile
- ナレッジ: アップロード、インデックス状態、有効/無効、参照元確認
- 引き継ぎ: パスアップ確認、通話参加、AIミュート、AI退出、オペレーター切断、通話終了

## backend機能

- 設定、ナレッジ、通話記録、Twilio access tokenのREST API
- 通話状態と文字起こしのWebSocket/SSE配信
- Twilio webhook署名検証
- Conference参加者の追加、ミュート、保留、削除
- 設定変更と引き継ぎ操作の監査ログ

## セキュリティと個人情報

- 管理画面は認証必須にする。
- Twilio Voice tokenは短命かつオペレーターIDに紐づける。
- 本番ログで全文トランスクリプトや電話番号をデフォルト出力しない。
- ナレッジ文書にはサイズ制限、検証、削除、無効化を用意する。

## 未決事項

- ~~初期リリースの認証基盤を何にするか。~~ → [ADR 0005](./0005-clerk-authentication.md) でClerk (Free tier) に決定。
- 人間引き継ぎ後にAIを退出させるか、無音で聞かせ続けるか。 (フェーズ2で再検討)
- 顧客には聞こえないコーチングモードを必要とするか。 (フェーズ2で再検討)
- ~~設定、ナレッジ、通話履歴、監査ログの永続化先を何にするか。~~ → [ADR 0003](./0003-call-log-firestore-sheets.md) でFirestore `speech-assistant-logs` を正本、Sheetsを運用ビューに決定。MVP設定は同DBの `adminConfig` ドキュメントへ保存 ([ADR 0004](./0004-mvp-scope-2026-05.md))。

## 参考

- Twilio Voice JavaScript SDK: https://www.twilio.com/docs/voice/client/javascript
- Twilio Voice SDK reference components: https://www.twilio.com/docs/voice/sdks/javascript/reference-components
- Twilio Voice Conference: https://www.twilio.com/docs/voice/conference
