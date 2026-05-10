# Wave 1 検証ToE

ToEはTest of Evidence、つまり検証証跡です。この文書は、Cloud Runや050番号の恒久切替に進む前に、Twilio -> ローカルNode -> OpenAI Realtime -> Twilio の音声ループが成立することを再現・記録するための手順です。

## 対象

検証するもの:

- ローカルサーバー起動
- ローカルHTTP/TwiMLエンドポイント
- OpenAI Realtime GA WebSocket接続と `session.update`
- Twilio Media Streams互換のWebSocket音声返送
- ngrok経由の050実着信

対象外:

- Cloud Run
- React管理画面
- RAG/ナレッジ
- 人間への引き継ぎ
- 本番のTwilio webhook署名検証

## 前提

- Node.js 22系
- `OPENAI_API_KEY` を含む `.env`
- Twilio CLIログイン済み
- ngrok設定済み
- Twilioの050番号へアクセスできること

Twilio profileと番号を確認します。

```bash
twilio profiles:list
twilio api:core:incoming-phone-numbers:list --properties sid,phoneNumber,friendlyName,voiceUrl,voiceMethod --limit 20
```

Wave 1で確認した050番号:

```text
<twilio-phone-number>
```

## ローカル確認

依存関係を入れて構文チェックを実行します。

```bash
npm ci
npm test
```

期待結果:

```text
node --check index.js
```

サーバーを起動します。

```bash
npm run start
```

別ターミナルでローカルエンドポイントを確認します。

```bash
SMOKE_BASE_URL=http://127.0.0.1:5050 npm run smoke:local
```

期待結果:

```text
ok - root endpoint
ok - health endpoint
ok - incoming-call TwiML
```

## OpenAI Realtime確認

```bash
npm run check:realtime
```

期待結果:

```text
ok - connected to OpenAI Realtime model gpt-realtime-1.5
ok - received session.created
ok - session.update accepted
```

## Media Streams互換確認

ローカルサーバー起動中に実行します。

```bash
npm run smoke:media-stream
```

期待結果:

```text
ok - connected to local media stream WebSocket
ok - received outbound media payload from server
```

これは、Twilio Media Streams互換クライアントが接続し、OpenAI Realtimeで生成された音声payloadを受け取れることを確認します。

## ngrok公開URL確認

ngrokを起動します。

```bash
ngrok http 5050
```

公開URLを取得します。

```bash
curl -s http://127.0.0.1:4040/api/tunnels
```

環境変数へ入れます。

```bash
export NGROK_URL=https://your-ngrok-host.ngrok-free.app
```

公開URLを確認します。

```bash
curl -sS -i "$NGROK_URL/healthz"
curl -sS -i -X POST "$NGROK_URL/incoming-call"
```

期待結果:

- `/healthz` がHTTP 200と `{"status":"ok"}` を返す。
- `/incoming-call` が `wss://.../media-stream` を含むTwiMLを返す。

## 050一時着信テスト

変更前のWebhookを必ず記録します。

```bash
twilio api:core:incoming-phone-numbers:list --properties sid,phoneNumber,voiceUrl,voiceMethod --limit 20
```

050番号を一時的にngrokへ向けます。

```bash
twilio api:core:incoming-phone-numbers:update \
  --sid <twilio-phone-number-sid> \
  --voice-url "$NGROK_URL/incoming-call" \
  --voice-method POST \
  --properties sid,phoneNumber,voiceUrl,voiceMethod
```

`<twilio-phone-number>` へ電話します。

期待ログ:

```text
Incoming call
Client connected
Incoming stream has started ...
Connected to the OpenAI Realtime API
Received event: session.created
Received event: session.updated
Received event: input_audio_buffer.speech_started
Received event: input_audio_buffer.speech_stopped
Received event: conversation.item.input_audio_transcription.completed
Received event: response.output_audio_transcript.done
Received event: response.done
```

初回成功時の証跡:

```text
transcript: こんにちは
transcript: どんなことがあなたできるんですか?
```

## 後片付け

必ずWebhookを戻します。初回Wave 1検証時の戻し先は次の通りです。

```bash
twilio api:core:incoming-phone-numbers:update \
  --sid <twilio-phone-number-sid> \
  --voice-url https://demo.twilio.com/welcome/voice/ \
  --voice-method POST \
  --properties sid,phoneNumber,voiceUrl,voiceMethod
```

ローカルプロセスを停止します。

```bash
pkill -f "node index.js"
pkill -f "ngrok http 5050"
```

番号設定が戻っていることを確認します。

```bash
twilio api:core:incoming-phone-numbers:list --properties sid,phoneNumber,voiceUrl,voiceMethod --limit 20
```

## 合格基準

Wave 1は次を満たしたら合格です。

- CIの `Node checks` が成功する。
- ローカルで `npm test` が成功する。
- `npm run check:realtime` が成功する。
- `npm run smoke:local` が成功する。
- `npm run smoke:media-stream` が成功する。
- 050実着信でOpenAI Realtimeへ接続し、AI音声応答が返る。
- テスト後にTwilio webhookを元に戻している。
