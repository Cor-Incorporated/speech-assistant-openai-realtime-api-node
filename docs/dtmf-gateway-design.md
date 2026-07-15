# DTMF振り分けゲートウェイ設計

対応ADR: [ADR-0008](./adr/0008-practice-system-separation-dtmf-gateway.md) ／ 対応Wave: E1

## ゴール

1つの050番号で「AI受付（既定）」と「電話応答練習システム（別リポ/別GCPプロジェクト、DTMF `5` で選択）」を振り分ける。**一般の発信者の体験を変えないこと**が最優先。

## 現状と変更点

現在の `/incoming-call` は署名検証後、即座に `<Connect><Stream url="wss://host/media-stream">` を返す（`index.js` の `/incoming-call` ハンドラ）。ここに `<Gather>` による振り分けを**フィーチャーフラグ付き**で挿入する。

### TwiML（フラグON時）

```xml
<Response>
  <Gather input="dtmf" numDigits="1" finishOnKey="#" timeout="2"
          action="/gateway/route" method="POST">
    <!-- Gather中は無音。一般発信者には案内を流さない（隠しコマンドのため） -->
  </Gather>
  <!-- timeout経過（=DTMF入力なし）: 従来のAI受付へ -->
  <Redirect method="POST">/gateway/route?digits=none</Redirect>
</Response>
```

### ルーティング表（`POST /gateway/route`）

| Digits | 遷移先 |
|---|---|
| `5` | `<Redirect>` で `PRACTICE_SYSTEM_REDIRECT_URL`（練習システムの `/incoming-call` 相当）へ通話ごと引き渡し |
| 入力なし（timeout）/ その他 | 従来どおり `<Connect><Stream>`（AI受付） |

- `<Redirect>` はTwilio側で次のTwiML取得先を差し替えるため、**別GCPプロジェクトのCloud Run URLでも動作する**。
- 練習システム側でも独自にTwilio署名検証を行う（Redirect後のwebhookは練習システム宛のリクエストになる）。

## 設計上の判断

1. **Gatherプロンプトは無音**: `5` は隠しコマンドであり、一般発信者に「練習は5を…」と案内しない。`timeout="2"` 秒の無音は、FIRST_MESSAGE（AI挨拶）開始が2秒遅れることを意味する。実装時に体感を確認し、許容できなければ `timeout="1"` へ短縮を検討する。
2. **FIRST_MESSAGEとの関係**: 現行はMedia Stream接続後にOpenAI経由で挨拶を発話する。Gatherはその**前段**に挟まるため、Realtimeセッションには影響しない。
3. **`lib/realtime-input-gate.js` との非干渉**: 入力ゲートの「Xボタン」転写破棄はMedia Stream接続**後**の音声認識に対する処理。Gatherは接続**前**のDTMF収集であり干渉しない。
4. **署名検証**: `/gateway/route` にも既存の `validateTwilioSignature` を適用する。actionコールバックのURL（クエリ含む）が署名対象になる点に注意。
5. **フラグOFF時は完全に従来動作**: `DTMF_GATEWAY_ENABLED=false`（既定）なら `<Gather>` を挿入せず、現行TwiMLをそのまま返す。練習システム稼働までOFFを維持する。

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `DTMF_GATEWAY_ENABLED` | `false` | ゲートウェイ有効化フラグ |
| `PRACTICE_SYSTEM_REDIRECT_URL` | （空） | 練習システムの着信TwiML URL。空のままフラグONにした場合、`5` 入力でも従来フローへフォールバックする（fail safe） |
| `DTMF_GATEWAY_TIMEOUT_S` | `2` | Gatherのtimeout秒 |

## テスト方針

- `node --test`: フラグON/OFFのTwiML分岐、digitsルーティング（`5`/none/その他）、URL未設定時のfail safe
- `npm run smoke:local` / `npm run smoke:media-stream`: フラグOFFで既存動作が非破壊であること（受け入れ条件）
- 手動: フラグONで実発信し、(a) 何も押さない→AI受付、(b) `5#`→練習システム（未構築の間はテスト用スタブURL）への遷移を確認

## 退役

練習システムが専用番号を持った段階で、フラグOFF→分岐コード削除で退役できる。
