# 独立レビュー(2026-09-21) 修復記録

**対象レビュー**: `review-artifacts/REVIEW.md`(対象SHA `526deb4`)
**修復ブランチ**: `fix/reception-review-remediation-20260921` → PR #97 (develop宛)
**修復実施者**: Devin

## 指摘ごとの対応

| # | 指摘 | 対応 | 検証 |
|---|---|---|---|
| R01 | 認証完了前にprovider接続を作成 | `connectProvider()`を導入。パストークン/`start.customParameters`遅延認証の成功後にのみ接続。handoff/closing/closed後は接続しないガード付き | `media-stream-review.test.mjs`「unauthenticated idle stream must not start a paid provider session」ok |
| R02 | watchdogがlifecycleだけで解除 | audio/transcript deltaのみを進捗とみなすよう変更。response lifecycle通知では解除しない。知識lookup停滞も25秒無音上限で捕捉 | 同テスト「lifecycle-only continuation must not disable the 25-second silence bound」ok(26秒実測) |
| R03 | `evaluateAction`へledger引数未渡し | `ActionLedgerStore`抽象化を追加。Firestore有効時は永続台帳、ローカル/試験時はインメモリ。ブリッジは常時ledgerを渡す | `negative-contracts.test.mjs` R03 + `action-gate-runtime.test.js` 全緑 |
| R04 | 設定失敗時に撤回知識が復活 | `lastKnownRevokedIds`/epochを保持しbounded stale fallback内でも撤回を維持 | 同テスト R04 ok(lookup→revoke→settings outage) |
| R05 | 構文正当のみで確認なし終話 | `caller_confirmed`を独立事実化。番号変更で無効化、同一応答内validate+finish連鎖を抑止 | 同テスト R05 ok + `realtime-tool-flow.test.js` 更新済み |
| R06 | 全角数字がJevマスクをすり抜け | Jev送信前にNFKC正規化。全角数字・区切りをマスク対象に含める | 同テスト R06 ok(全角電話番号が外部送信されないことを確認) |
| R07 | 自然な日本語質問が検索失敗 | NFKC正規化・文字n-gram・同義語最大寄与・カバレッジ加点を導入 | `knowledge-reader.test.js` 全緑(レビュー10クエリを含む) |
| R08 | 裸`function_call_output`送信 | `conversation.item.create`封筒で送信。`response.create`より先に出力を送る | `media-stream-review.test.mjs`「delegated tool output precedes response.create」ok |
| R09 | `callLogsV2`未投影・escalation未配線 | `projectProviderCall`を開始/終了時に呼出。冪等投影+決定論IDでescalation作成。通知≠ACK維持 | `call-projector.test.js` 5テスト全緑 |
| R10 | S-04昇格仕様の不一致 | S-04を確定仕様に改訂: Live(本番)は`live.backend_escalation`(音声`marin`継続)、Realtime時のみモデル昇格+音声`ash` | 同テスト「S-04: complex complaint escalates via Live backend delegation」ok |

## 検証エビデンス

- `npm test` — `# tests 327 / # pass 327 / # fail 0`(check + check:frontend + build:frontend + build:backend + node --test、約31.8秒)
- `review-artifacts/media-stream-review.test.mjs` — 10サブテスト全緑
- `review-artifacts/negative-contracts.test.mjs` — R03〜R06ネガティブ契約全緑
- `npm run smoke:local` — 3項目ok(ローカル起動サーバー)
- `npm run smoke:media-stream` — WS接続ok。outbound media待機タイムアウトは実OpenAIキー不在のローカル環境の既知限界
- `npm run check:realtime` — 実OpenAIキーが必要なためローカルでは未実施

## 残存する未検証事項(レビュー指摘のうちコード修正で完結しないもの)

- 実PSTNでの転送・音声再生・割込み・DTMF動作
- 実OpenAIキーを使った`check:realtime`/`smoke:media-stream`の往復音声
- レビューが「人間確認が必要」とした公開知識17件の確定
- 本番デプロイ(本PRのマージと別ゲートの承認が必要)
