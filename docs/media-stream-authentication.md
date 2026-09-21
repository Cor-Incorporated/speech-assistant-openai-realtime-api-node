# Media Streams 認証（stream token）

`TWILIO_STREAM_AUTH_ENABLED=true` のとき、Twilio Media Streams の WebSocket 接続は
HMAC署名付きトークンの提示を必須とする。トークンは `TWILIO_AUTH_TOKEN` を鍵に
`CallSid` と有効期限へバインドされ、別通話のトークン・改竄・期限切れは全て拒否される。

## トークン輸送 — 3経路の多重化

TwiML生成時（`lib/twiml.js`）に同じトークンを2箇所へ埋め込み、サーバは3経路で受理する。
**どれか1つが届けば認証が成立する。**

| 経路 | 形式 | 検証タイミング | 備考 |
|---|---|---|---|
| URLパス | `wss://<host>/media-stream/<token>` | upgrade時点 | **本番主経路**。Twilioは`<Stream url>`のクエリを接続時に送信しないためパス埋込みが必須（2026-09-19実測） |
| `<Parameter>` | `<Parameter name="stream_token" value="..."/>` | `start`フレーム到着時 | `start.customParameters.stream_token`で到達。URLが届かない場合のフォールバック |
| クエリ | `?token=<token>` | upgrade時点 | 非Twilioクライアント・ローカル検証用 |

## 検証フロー（`index.js` / `lib/stream-auth.js`）

1. upgrade時: パスまたはクエリのトークンがあれば即時検証
   - 有効 → provider（OpenAI Live/Realtime）接続を開始
   - **invalid（改竄・期限切れ・署名不正）→ 4403で即拒否**、providerソケットは作らない
   - **missing（トークン自体が無い）→ 遅延認証モード**へ移行
2. 遅延認証: `<Parameter>`経路のために`start`フレームまで待機
   - `start`/`connected`以外のフレームが先に届いた場合は4403拒否
   - `start.customParameters.stream_token`を検証、かつ `start.callSid` がトークン内のCallSidと一致することを確認
   - 認証タイムアウト（未認証のまま放置される接続を4408で閉じる）
   - `TWILIO_STREAM_AUTH_ENABLED=false` のローカル開発時のみバイパス
   - 有効化時に `TWILIO_AUTH_TOKEN` 未設定なら fail-closed（全接続拒否）

## tool応答watchdog（`LIVE_TOOL_WATCHDOG_MS`、既定10秒）

Liveプロバイダでtool結果送信後の`response.create`に対してcontinuation応答
（`response.in_progress`/`created`/`completed`/`output_item.added`）が無い場合:

- **stage1**: `live.tool_response.stalled` をaudit記録し、停滞したdelegationへ
  `session.instructions.append`（`delegation_id`+`content` 必須 — 実APIで確認済み）で
  「確認して担当者より折り返します」のフォールバック案内を注入して `response.create` 再試行
- **stage2**: さらに無応答なら `live.tool_response.failed` を記録し、
  通常の終話ワークフロー（`requestCallEnd`）へ移行

これにより tool 経路の失敗が**無制限の無音**にならないことが保証される。
watchdogはcaller切断・Liveセッション終了・continuation検出で解除される。

## 関連コード

- `lib/twiml.js` — トークン埋込みTwiML生成（パス+Parameter）
- `lib/stream-auth.js` — HMACトークン発行・検証（パス/クエリ抽出対応）
- `index.js` — `/media-stream`・`/media-stream/:token` ルート、遅延認証、watchdog
- `lib/live-session.js` — `toLiveToolResultItem`（tool出力→Live item正規化）、`liveInstructionsAppend`
- `test/stream-auth.test.js` / `test/media-stream.integration.test.js` — 実WS接続での結合検証
