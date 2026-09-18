# 受付システム近代化 調査メモ（2026-09-18）

- 目的: Node.js/Fastify構成を維持したまま、音声プロバイダ・分類・副作用の責務を分離し、TypeScriptへ段階移行する
- 基準: `origin/develop` @ `59b8829`、baseline `npm test` 85件全PASS

## 現行アーキテクチャの観測

- 本体は `index.js`（Fastify + Twilio Media Streams + OpenAI Realtime）。純粋ロジックは `lib/` に分離済み。
- Twilio `mark` 受信を「再生完了＝終話可能」の根拠に使っている。`clear` 後のmarkを再生済み扱いしない分離は `src/telephony/playback-controller.ts` でエポック管理として実装。
- ツール引数は `lib/realtime-tool-flow.js` がJSON.parseするが、`Boolean("false")` のような型偽装や未知enum値への拒否が層として独立していない。`src/contracts/tool-arguments.ts` で厳密検証を追加。
- 転送先は `contract`/`general` のallowlist管理。分類（用件判定）と転送権限（policy判定）を `src/domain/routing-policy.ts` に分離。

## エビデンス状況（archive `evidence_status.json` から）

| 項目 | 状態 |
|---|---|
| Live API実接続 | 未検証（not verified） |
| Jev API実接続 | 未検証（not verified） |
| Live/Jev実リクエスト | 未実行 |
| 音声品質実測 | 未実行 |
| レイテンシ計測 | 未計測 |
| 品質改善の実測 | 未計測 |
| 合成ケース | 48件（JSONパース・構造のみ検証済み） |

実測なしに Jev/Live の精度・速度改善を断定しない。本メモ以降の報告でも同様。

## 設計上の分離（必須要件への対応）

| 分離 | 実装 |
|---|---|
| 電話番号の形式検証 vs 発信者確認 | `src/domain/reception-state.ts`（形式OK≠確認済み、訂正でrevision無効化） |
| 音声生成 vs 電話再生 | `src/contracts/voice-events.ts` の `assistant_turn_completed` と `src/telephony/playback-controller.ts` のmarkベース判定 |
| 割込み vs 業務操作の取消 | playbackエポック + `ActionLedger` の `outcome_unknown` |
| 分類結果 vs 転送権限 | `RoutingDecision`（what) と `evaluateTransferRequest`（may) の分離 |
| 現行context vs 古い非同期結果 | `contextRevision` を全判定物に付与、coordinatorでstale破棄 |
| プロバイダ差異 | `VoiceSessionPort`（Realtime互換）+ `LiveAdapter`（無効既定・構造化unavailable・再接続なし） |

## BLOCKED（外部権限なし・未検証）

- OpenAI Live API実接続・イベント名の実測照合
- Jev分類APIの実仕様（エンドポイント・レスポンス形式・レート制限挙動）
- Twilio実通話・実転送・実通知
- Firestore本番台帳

これらはモック・純粋関数で代替検証済み。実接続は明示的許可後に別途実施。
