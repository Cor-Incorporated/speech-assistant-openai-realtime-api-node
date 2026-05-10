# ADR 0001: 2026年版プロダクション移行

- ステータス: Wave 1-2A 採用済み / Wave 2B以降は [ADR 0004](./0004-mvp-scope-2026-05.md) によりPoC対象外
- 日付: 2026-04-26 (初版) / 2026-05-10 (PoCスコープに合わせ改訂)
- 対象: OpenAI Realtime、Twilio電話連携、React管理画面、人間への引き継ぎ、Cloud Run、050番号

> **改訂メモ (2026-05-10):** PoC納期 (2026年5月中旬) に間に合わせるため、本ADRのうちWave 2B以降のうち「Twilio Voice SDKソフトフォン」「Twilio Conference引き継ぎ」「ベクトルRAG」「backend TypeScript化」「リアルタイム通話イベントストリーム」はPoC対象外とし、フェーズ2以降に延期しました。詳細は [ADR 0004 MVPスコープ凍結](./0004-mvp-scope-2026-05.md) を参照してください。

## 背景

現行リポジトリは、単一の `index.js` でTwilio Voice着信を受け、Media StreamsをOpenAI Realtime APIへ中継するプロトタイプです。概念実証としては成立していますが、日本のコールセンターで運用するには、デプロイ、監視、設定管理、通話引き継ぎ、個人情報保護が不足しています。

解決すべき主要課題は次の通りです。

1. Replit/ngrok前提から、再現可能なクラウド運用へ移行する。
2. 通話監視、ログ、プロンプト、VAD、ナレッジ/RAGを管理できるReact UIを作る。
3. 日本の `050` 番号で着信運用する。
4. 周囲音で誤反応しにくいVAD/ノイズ低減設定にする。
5. OpenAI Realtime API、モデル、イベント形状を2026年4月時点のGA仕様へ更新する。
6. AIが対応困難と判断した場合、人間オペレーターが画面から通話へ参加できるようにする。

## 決定

実装は段階的に進め、`050` 番号の恒久切替は最後に行います。

1. 既存のOpenAI APIキーとTwilio番号で、まずローカル通話ループを検証する。
2. PSTN/050通話の本線は、Twilio Voice -> Node/Fastify -> OpenAI Realtime WebSocket のサーバー側経路を維持する。
3. React + TypeScriptでオペレーターコンソールを作る。対象は通話監視、ログ、設定、ナレッジ、VAD、引き継ぎ操作。
4. サーバーからReactへ、WebSocketまたはSSEで通話状態、文字起こし、VAD、AIイベント、パスアップ通知を配信する。
5. 人間オペレーターのブラウザ通話にはTwilio Voice JavaScript SDKを使う。これはブラウザとTwilio間のWebRTCであり、顧客電話を直接ブラウザへつなぐものではない。
6. AI/顧客/オペレーターの管理にはTwilio Conferenceを使う。これにより参加、ミュート、削除、保留、将来のコーチングが扱いやすくなる。
7. Realtimeモデルは `gpt-realtime-1.5` を既定とし、モデル名、音声、文字起こし、VAD、抽出モデルは環境変数または設定として管理する。
8. 本番はGoogle Cloud Runへデプロイし、秘密情報はSecret Managerへ置く。WebSocket長時間接続のtimeoutと再接続方針を明記する。

## 目標アーキテクチャ

```text
050顧客通話
  -> Twilio Voice / Conference
  -> backend Twilio webhook + Media Stream WebSocket
  -> OpenAI Realtime WebSocket
  -> AI音声応答をTwilioへ返送

Reactオペレーターコンソール
  -> 設定、ナレッジ、通話履歴のREST API
  -> 通話状態のリアルタイムイベント
  -> Twilio Voice SDKによるWebRTCソフトフォン
  -> backend経由のConference参加者制御
```

## ロールアウト順序

1. ✅ Wave 1: ローカル起動、OpenAI Realtime、Twilio Media Streams、050実着信を検証する。 (2026-04 完了)
2. 🟡 Wave 2A: Cloud Run、Secret Manager、署名検証、プライバシーログ無効化を整備する。 (2026-04 完了)
3. 🟢 Wave 2B (PoC MVP / 2026-05): React + Clerk管理画面、通話履歴一覧、AI設定 (システムプロンプト + Markdown直書きナレッジ)、再架電フラグを実装する。詳細は [ADR 0004](./0004-mvp-scope-2026-05.md) と [docs/mvp-scope-2026-05.md](../mvp-scope-2026-05.md) を参照。
4. ⏸ Wave 3 (フェーズ2以降): backend TypeScript化、通話状態リアルタイムイベントストリーム。
5. ⏸ Wave 4 (フェーズ2以降): ベクトル化RAG、PDF/PowerPoint対応、参照元表示。
6. ⏸ Wave 5 (フェーズ2以降): Twilio Voice SDKソフトフォンとConferenceで人間への引き継ぎを実装する。
7. ✅ Wave 6: Cloud Run、Secret Manager、監視、署名検証。 (Wave 2Aに統合し完了)
8. ✅ Wave 7: 050番号を本番URLへ恒久切替する。 (2026-04 完了)

## 受け入れ条件

- Cloud Run前に、ローカルで実050着信からOpenAI Realtime音声応答まで確認済みである。
- Realtimeの `session.update` はGA形状を使う。
- React画面で通話状態と文字起こしを確認できる。
- AIのパスアップを受け、人間オペレーターがブラウザから参加できる。
- Cloud Run上で想定通話時間のWebSocket接続が維持できる。
- 050番号は本番URL、署名検証、日本語通話テスト完了後に切り替える。

## 影響

- 単なるモデル名変更より大きな改修になるが、プロトタイプの前提を本番へ持ち込まずに済む。
- 電話AI本線はWebSocket、人間オペレーター参加はWebRTCという役割分担になる。
- Conference制御によりTwilio実装は複雑になるが、引き継ぎや将来拡張が安定する。
- 管理画面とRAGにより、認証、永続化、監査、個人情報保護が必須になる。

## 参考

- OpenAI Realtime model: https://developers.openai.com/api/docs/models/gpt-realtime
- OpenAI Realtime VAD: https://developers.openai.com/api/docs/guides/realtime-vad
- OpenAI Realtime WebSocket: https://developers.openai.com/api/docs/guides/realtime-websocket
- Google Cloud Run WebSockets: https://docs.cloud.google.com/run/docs/triggering/websockets
- Twilio Media Streams: https://www.twilio.com/docs/voice/media-streams
- Twilio Voice JavaScript SDK: https://www.twilio.com/docs/voice/client/javascript
- Twilio Conference: https://www.twilio.com/docs/voice/conference
