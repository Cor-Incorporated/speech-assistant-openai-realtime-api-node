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
- ~~本番デプロイ~~ → 下記「本番デプロイ検証」参照

## 本番デプロイ検証(2026-09-21 14:xx JST)

- PR #97をdevelopへマージ(merge commit `f5f9272`)、Actions run `35563322444` Deploy Cloud Run成功(2分34秒)
- 新revision `speech-assistant-realtime-00033-b6j` が100%トラフィック、`/health`=`{"status":"ok"}`
- **R01(本番実測)**: トークンなしstart送信→`closed:4403:forbidden`。未認証アイドル接続→10.3秒で`closed:4403:stream_auth_timeout`。いずれもproviderセッションは作成されない
- **R09(本番実測)**: プローブ切断のセッションが`callLogsV2/session_1789967372672`として投影済み(`origin:provider`,`createdBy:system:call-projection`,`call.project`イベント成功)
- 起動ログにエラーなし。`call projection disabled`警告なし=admin v2リポジトリ経路で投影が有効化済み
- 未実施: 実電話による音声品質・転送の確認(発信者側の操作が必要)

## 再検収(2026-09-21) 修復記録 — RR01〜RR07

**再検収**: レビュアーによる追加境界テスト10件(N01〜N10)で前回修復の不備を検出。判定「不合格」
**修復ブランチ**: `fix/reception-recheck-remediation-20260921` → PR #99 (develop宛、merge commit `0cd9be1`)

| # | 指摘 | 対応 | 検証 |
|---|---|---|---|
| RR01 | 終了時v2投影が`extraction.model: undefined`でFirestore拒否 | 投影値からundefined除去。`model`は抽出モデル名がある場合のみ付与 | `extended-contracts.test.mjs` N06(実Firestoreシリアライザ通過)緑 |
| RR02 | watchdog stage2がフラグのみで実終了しない。無音PCMU(0xff)で解除 | stage2で実際に通話終了ワークフローへ移行。無音PCMUペイロードは可聴進捗とみなさない | `extended-media.test.mjs` N08(25秒以内終了)/N09(無音パケットで解除されない)緑 |
| RR03 | 未認証接続の切断でv2レコード+通知処理が作成 | close handlerに認証成功ゲート。認証失敗・timeout・start前切断では業務レコード0/通知0/provider接続0 | 同テスト N10緑。本番プローブ後のFirestore読取で新規レコード0件を実測 |
| RR04 | Realtime `session.tools`の`strict:true`を実APIが拒否 | provider別にtool schemaを整形しRealtimeからは`strict`を除去。`OPENAI_REALTIME_WS_URL` override追加でwire検証可能化 | wire検証 `tools=3 names=validate_callback_phone,lookup_company_knowledge,finish_reception / strict fields:[null,null,null]` |
| RR05 | 番号確認が復唱内容・訂正に結び付かない | 復唱した番号値とturnを対応付け。訂正・否定で既存確認を取消。「間違いありません」等の肯定を否定regexに誤認させない | `extended-contracts.test.mjs` N01/N02/N03緑 |
| RR06 | 未知商品に別サービス料金を回答 | 「グリフト」同義表記を追加。商品未特定時は一般語一致のみで断定せず確認質問/unknownへ | 同テスト + `knowledge-reader.test.js`緑 |
| RR07 | 開始時空データが有効値を占有・needsReview未更新・transportState巻戻し | 未編集のeffectiveは抽出値で初期化。後発escalationでneedsReview反映。終了済みcallのconnected巻戻し防止 | 同テスト N04/N05/N07緑 |

## 再検収修復の検証エビデンス

- `npm test` — `# tests 348 / # pass 348 / # fail 0`(26スイート)
- `review-artifacts/extended-contracts.test.mjs` — N01〜N07全緑(修復前は7 FAILでred確認済み)
- `review-artifacts/extended-media.test.mjs` — 13サブテスト全緑(N08 25秒以内終了、N09無音PCMU非解除、N10未認証副作用なし含む)
- CI(Node checks)run `35567236671` — success(1分51秒)

## 再検収修復の本番デプロイ検証(2026-09-21 15:1x JST)

- PR #99をdevelopへマージ(`0cd9be1`)、Actions run `35567415943` Deploy Cloud Run成功(2分23秒)
- 新revision `speech-assistant-realtime-00035-krm` が100%トラフィック
- `/health`=`{"status":"ok"}`、`/`=正常応答
- **R01再確認(本番実測)**: トークンなしstart→`closed:4403:forbidden`(0.7秒)、未認証アイドル→`closed:4403:stream_auth_timeout`(10.1秒)
- **RR03(本番実測)**: 上記未認証プローブ2回の実施前後で`callLogsV2`が2件のまま変化なし(新規業務レコード0)
- Cloud Logging(新revision): 起動正常、プローブの接続/切断を記録、エラーなし
- 未実施: 認証済みストリームの本番検証(無音watchdog・provider音声・v2終了投影)はTwilio Auth TokenのHMAC署名が必要なため、実PSTN通話またはトークン発行済み試験経路での確認待ち

## 第3回検収(2026-09-21) 修復記録 — T01〜T04

**第3回検収**: 追加境界テスト8件(B01〜B06, K03/K04)で前回修復の残存不備を検出。診断通話のみ許容、全シナリオ受入は保留
**修復ブランチ**: `fix/reception-acceptance-remediation-20260921` → PR #101 (develop宛、merge commit `dd83ae4`)

| # | 指摘 | 対応 | 検証 |
|---|---|---|---|
| T01 | 否定・話題変更で番号復唱の確認待ちが失効しない | 確認待ちを復唱turn単位のウィンドウ化。復唱を含まないagent発話・user否定で失効 | `additional-contracts.test.mjs` B01/B02緑 |
| T02 | 空transcript・短いfillerでwatchdog永久解除 | watchdogを再監視型へ。pending中は可聴進捗で期限延長のみ、解除はcaller speech/close/終話のみ。stage1 nudge最大2回 | `additional-media.test.mjs` B05/B06緑(26秒無音→実終了) |
| T03 | 遅延投影で要約消失・部分編集で初期化停止 | `effective`を項目単位マージ。extraction無し再投影は既存値を保持、人の部分編集はその項目のみ保護 | `additional-contracts.test.mjs` B03/B04緑 |
| T04 | 未知商品検出が助詞・複合語に弱い | segment内のカタカナ/英字runを抽出。非既知runはunknown、既知商品(キーprefix一致)はその商品の項目に限定 | `knowledge-entity.test.mjs` K01〜K04緑 |

## 第3回検収修復の検証エビデンス

- `npm test` — `# tests 348 / # pass 348 / # fail 0`(取り込んだ検収probe3ファイル含む)
- `review-artifacts/additional-contracts.test.mjs` + `knowledge-entity.test.mjs` — 8件全緑(修復前6 FAIL)
- `review-artifacts/additional-media.test.mjs` — B05/B06含む全サブテスト緑(修復前2 FAIL)
- CI(Node checks)run `35573067081` — success

## 第3回検収修復の本番デプロイ検証(2026-09-21 16:3x JST)

- PR #101をdevelopへマージ(`dd83ae4`)、Actions run `35573305568` Deploy Cloud Run成功(2分24秒)
- 新revision `speech-assistant-realtime-00037-jlp` が100%トラフィック
- `/health`=`{"status":"ok"}`、`/`=正常応答
- トークンなしstart→`closed:4403:forbidden`(0.9秒)、未認証アイドル→`closed:4403:stream_auth_timeout`(10.1秒)
- 未認証プローブ2回の前後で`callLogsV2`は既存2件のまま(新規業務レコード0)
- Cloud Logging(新revision): 起動正常、プローブの接続/切断を記録、エラーなし
- 未実施: 認証済みストリームの本番検証(無音watchdogの実発話・provider音声・v2終了投影)はTwilio Auth TokenのHMAC署名が必要。実PSTN通話での確認待ち(番号確認・無音回復・商品料金の実音声での再現を含む)
