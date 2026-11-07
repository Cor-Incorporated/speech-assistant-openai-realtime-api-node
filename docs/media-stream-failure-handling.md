# 音声接続の異常終端と誤入力保護

2026-11-07。実際の `index.js` を起動し、localhostのTwilio/音声provider stubで再現した不具合を対象とする。実API・実PSTNの音声品質を保証する試験ではない。

| 再現条件 | 修正後の扱い |
|---|---|
| Realtimeの途中切断・HTTP 429接続拒否 | 発信者の接続を終端し、provider異常を失敗として記録する |
| Liveが`session.closed`を通知し、WebSocketを閉じない | 発信者を無音のまま残さず終端する |
| `server_error`後に音声が止まる | `LIVE_TOOL_WATCHDOG_MS`の期限まで復旧を待ち、無音が続けば終端する |
| tool応答待ち中に`Hi.`などの拒否対象が転記される | 入力ゲートで受理されるまではwatchdogを解除しない |
| Twilioの`stop`、重複`stop`、その後のmedia | 最初のstopから一度だけ終了処理を進め、遅延mediaを無視する |
| 同じCallSidが同じprocessへ同時接続する | sessionを共有せず、2本目を4409でprovider接続前に拒否する |
| 認証前に64KiB超のframeが届く | 1009で拒否し、providerを開始しない |
| `password`、`machine`、`rpc`などの英語転記 | `Word`、`Mac`、`PC`の部分一致だけでは入力ゲートを通さない |

`server_error`の待機時間は2〜60秒、既定10秒。期限前に非無音audioが戻れば通話を継続する。`invalid_request_error`など、回復可能なリクエストエラーを一律に切断しない。

同一socketの同一start再送は無視し、stream identityの変更は拒否する。CallSidの所有権はclose開始時に解放するので、旧AI受付へのfallback接続を保存処理待ちで塞がない。旧接続の遅延cleanupは、自分が所有者である場合だけMapから削除する。

## 検証

- `node --test test/transport-chaos.test.js`: 異常切断、429、errorからの音声復旧、stopの冪等性、拒否noise、過大frame、同時CallSid、遅延drain中のAI fallback再接続を検査する。
- `node --test test/realtime-input-gate.test.js`: 許可語の境界、全角正規化、電話番号、通常の日本語を検査する。
- `npm test`: 既存のMedia Stream、tool往復、転送・留守電の回帰を含める。

既存のCallSid不一致テストは、直前の非同期closeと重複接続検査に干渉しない専用IDへ分離した。`call_sid_mismatch`監査の検査は維持している。

## 制約

所有権Mapはprocess内だけであり、Cloud Runの異なるinstanceに同じtoken/CallSidが到達するreplayは防げない。分散leaseは導入していない。Twilioの通常契約は1通話につきactive bidirectional streamが1本である。

AI fallbackの検査は、新しいprovider接続と所有権の維持を対象とする。既存の管理記録はterminal transportStateをconnectedへ戻さないため、複数Media Stream legをまたぐ状態モデルはこの変更に含めない。

一次資料: [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)、[OpenAI Realtime server events](https://developers.openai.com/api/reference/resources/realtime/server-events)。
