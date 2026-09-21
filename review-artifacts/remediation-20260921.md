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

## 第4回検収(2026-09-21) 修復記録 — U01〜U03

**第4回検収**: 前回8失敗は解消したが番号確認とLive watchdogにP1残存。判定「全シナリオ受入は保留」
**修復ブランチ**: `fix/reception-round4-remediation-20260921` → PR #103 (develop宛、merge commit `dadcce5`)

| # | 指摘 | 対応 | 検証 |
|---|---|---|---|
| U01 | 「いいえ、もう一度お願いします」「はい、間違いです」が肯定扱いで番号確認を通過 | 否定パターンに「いいえ/いえ」「間違いです/でした/だ」「もう一度/もう一回」を追加し肯定より優先評価。「間違いありません」は肯定として維持 | `phone-corrections.test.mjs` C01〜C04全緑(修復前C01/C02 FAIL) |
| U02 | 正常回答後もwatchdogが残り、回答後の無言で誤回復が発動(実Liveで+30秒に回復指示送信を観測) | 解除を「delegation応答のresponse.completed受信」かつ「実質的な可聴出力(非無音audio 8パケット以上 or transcript 12文字以上)」の両立に限定。正常回答後は通常会話待機へ戻る | `watchdog-contract.test.mjs`緑。B05/B06の無音終了は維持 |
| U03 | watchdog回復指示がResponses delegation IDをclient delegationとして送り実APIに`Unknown client delegation`で拒否 | `session.instructions.append`の`delegation_id`を`null`固定(session scope) | 同テストC05緑(修復前FAIL) |

## 第4回検収修復の検証エビデンス

- `npm test` — `# tests 391 / # pass 391 / # fail 0`(取り込んだ検収probe2ファイル含む)
- `review-artifacts/phone-corrections.test.mjs` — C01〜C04全緑(修復前2 FAILでred確認済み)
- `review-artifacts/watchdog-contract.test.mjs` — 16サブテスト全緑(C05 delegation_id=null、B05/B06停止検知維持、N08/N09/R02含む)
- CI(Node checks/h5-admission/gitleaks)— PR #103全緑

## 第4回検収修復の本番デプロイ検証(2026-09-21 17:5x JST)

- PR #103をdevelopへマージ(`dadcce5`)、Actions run `35580179883` Deploy Cloud Run成功(2分10秒)
- 新revision `speech-assistant-realtime-00039-v6p` が100%トラフィック
- `/health`=`{"status":"ok"}`、`/`=200
- トークンなしstart→`closed:4403:forbidden`、未認証アイドル→`closed:4403:stream_auth_timeout`(10.1秒)
- 未認証プローブ2回の前後で`callLogsV2`は既存2件のまま(新規業務レコード0)
- Cloud Logging(新revision): 起動正常、プローブの接続/切断のみ記録、エラーなし
- 未実施: U02の「正常回答後の無言で誤回復しない」は実Live APIでしか完全検証できない。実PSTN通話または認証済みストリーム試験での再確認待ち(電話受付時間13:00〜17:00の知識反映はユーザー確定値として開始阻害に含めず、未反映のまま)

## 第5回検収(2026-09-21) 修復記録 — V01〜V02

**第5回検収**: U01/U03改善とU02の実Live解消を確認する一方、U02修復の完了判定が待機案内でwatchdogを解除する退行(V01)と、正しい知識取得後の「商品不明」回答(V02)を検出。判定「人間受入テストへの移行は保留」
**修復ブランチ**: `fix/reception-round5-remediation-20260921` → PR #105 (develop宛、merge commit `8804169`)

| # | 指摘 | 対応 | 検証 |
|---|---|---|---|
| V01 | 「少々お待ちください」+音声8パケット、または「ただいま確認しております。少々お待ちください。」だけでwatchdogが解除され、tool応答未回答のまま監視停止 | 完了判定を出力サイズから内容ベースへ。transcriptから待機・承認句を除去した実質文字数で判定(実質4文字以上、または実質1文字以上+音声8パケット)。transcript観測後は音声バースト単独では解除しない。transcript未観測時のみ音声40パケットで回答済みとする | `watchdog-boundary.test.mjs` D01/D02緑(修復前2 FAIL)。B05/B06の無音終了・U02の正常回答後待機は維持 |
| V02 | 正しい知識(status:found、3料金)を取得してもbackendが「商品不明」と回答(実Live、2回中1回) | tool出力の各項目に`key`/`title`を追加。answerが商品名を含まない公開項目(「掲載目安はTeam Betaが月額5万円から」)をtitle/keyの対象名でエンティティ結合。found指示文も強化。発信者queryのエコーは秘匿語句の再流出になり得るため出力へ含めない | `test/knowledge-tool-runtime.test.js` 5/5緑(draft/internal非漏洩を維持)。実Liveでの再現率は未確定のため再検証待ち |
| - | メディア統合テスト群のポート乱択(19500+400)が並列実行でEADDRINUSE衝突 | 4ファイル全て空きポート動的取得へ変更 | npm testでcancelled 0を確認 |

## 第5回検収修復の検証エビデンス

- `npm test` — `# tests 393 / # pass 393 / # fail 0 / # cancelled 0`(新規probeファイル含む)
- `review-artifacts/watchdog-boundary.test.mjs` — D01/D02緑(修復前は同入力で26秒後もWS OPEN・watchdog指示0)
- `review-artifacts/watchdog-contract.test.mjs` — C05 delegation_id=null、B05/B06/N08/N09停止検知を維持
- CI(Node checks/h5-admission/gitleaks)— PR #105全緑

## 第5回検収修復の本番デプロイ検証(2026-09-21 18:5x JST)

- PR #105をdevelopへマージ(`8804169`)、Actions run `35589468286` Deploy Cloud Run成功(2分35秒)
- 新revision `speech-assistant-realtime-00041-6wz` が100%トラフィック
- `/health`=`{"status":"ok"}`、`/`=200
- トークンなしstart→`closed:4403:forbidden`、未認証アイドル→`closed:4403:stream_auth_timeout`(10.1秒)
- 未認証プローブ2回の前後で`callLogsV2`は既存2件のまま(新規業務レコード0)
- Cloud Logging(新revision): ERROR以上のログなし
- 未実施: V01の「正常回答後の無言で誤回復しない」+「filler後の障害回復が残る」の同時成立はwire契約とmockで検証済みだが、実Live APIでの再確認は実PSTN通話または認証済みストリーム試験待ち。V02の実Live再現率(2回中1回)は小標本であり、title/key追加後の実Live再試験で改善を確認する必要がある

## 第6回検収(2026-09-21) 修復記録 — W01

**第6回検収**: V01の元反例(D01/D02)は改善したが、同じ待機文をLiveの自然なdelta断片で送るとwatchdogが不可逆に解除される残件(W01)を検出。V02は今回0/2で非再現(音声認識側の揺れ1件は別途記録)。判定「人間受入テストへの移行は保留」
**修復ブランチ**: `fix/reception-round6-remediation-20260921` → PR #107 (develop宛、merge commit `2a2d4bb`)

| # | 指摘 | 対応 | 検証 |
|---|---|---|---|
| W01 | 待機文をdelta断片(「ただいま」「確認して」「おります。」等)で送ると、完成前の句の前方一致部分が実質文字に計上されwatchdogが不可逆に解除。実Liveでも待機文の断片化を観測 | 待機句の前方一致割引を追加。累積transcriptを完成句で除去した後、末尾が待機句の真の前方一致である間は実質文字数に数えない。粒度・順序不変 | `streamed-filler.test.mjs` E01/E02緑(修復前2 FAIL)。D01/D02一括送信・B05/B06無音系・U02正常回答後待機は維持 |

## 第6回検収修復の検証エビデンス

- `npm test` — `# tests 395 / # pass 395 / # fail 0 / # cancelled 0`(新規probeファイル含む)
- `review-artifacts/streamed-filler.test.mjs` — E01/E02緑(修復前は同入力で26秒後もWS OPEN・watchdog指示0)
- `review-artifacts/watchdog-boundary.test.mjs` — D01/D02緑を維持
- `review-artifacts/watchdog-contract.test.mjs` — B05/B06/N08/N09/C05の停止検知・delegation scopeを維持
- CI(Node checks/h5-admission/gitleaks)— PR #107全緑

## 第6回検収修復の本番デプロイ検証(2026-09-21 20:5x JST)

- PR #107をdevelopへマージ(`2a2d4bb`)、Actions run `35595157782` Deploy Cloud Run成功(2分53秒)
- 新revision `speech-assistant-realtime-00043-bhp` が100%トラフィック
- `/health`=`{"status":"ok"}`、`/`=200
- トークンなしstart→`closed:4403:forbidden`、未認証アイドル→`closed:4403:stream_auth_timeout`(10.1秒)
- 未認証プローブ2回の前後で`callLogsV2`は既存2件のまま(新規業務レコード0)
- Cloud Logging(新revision): ERROR以上のログなし
- 未実施: W01の「断片化された待機文で誤解除しない」はwire契約とmockで検証済み。実Live APIでの最終確認(自然なdelta断片での待機文と正常回答の区別)は実PSTN通話または認証済みストリーム試験待ち。V02の実Live再現率は今回0/2で非再現だが小標本のため、次回検収での再確認が望ましい
