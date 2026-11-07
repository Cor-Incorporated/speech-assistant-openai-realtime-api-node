# Cor音声受付・競合能力差分と追加設計

調査日時: 2026-11-07 JST。対象HEAD: `0ddbd49a7b63596136c95b2f684a485782244850`。

本資料は調査開始時点の比較表・追加設計に固定した記録である。「未確認」「未実装」は上記HEADに対する判定であり、後続の修正後の状態を示さない。
後続の実装・計測結果は[敵対的レビューと追加実装の記録](2026-11-07-callcenter-adversarial-review.md)を参照する。

結論: 自然対話、担当者への承諾付き転送、留守電、公開済みナレッジ、通話修正履歴という土台は存在する。一方、競合が運用を製品化している「誰が・いつまでに・実際に対応したか」「応対品質をどの母集団で評価したか」は弱い。CorではSMSや座席表の追加より、通知の証跡、未処理期限、個人認証、音声品質計測、営業日・当番ルールの順に閉じる効果が大きい。

本資料はread-only設計レビューであり、競合製品の実機比較・契約プラン適用確認・本番UATは行っていない。公式ページ上の提供機能を参照し、優劣・品質・精度の実測とは扱わない。ローカルテスト件数は全面品質の証明として用いない。この競合調査レーンでは、リポジトリ本体の編集、commit、push、外部送信、実通話、有料API呼出しは実施していない。

## 判定方法と到達経路

- **コード確認**: 呼出し元から処理・保存先まで到達経路を読んだ。動作実証・デプロイ状態は含まない。
- **部分実装**: 能力の一部はあるが、運用の完了条件に必要な経路が不足する。
- **経路未確認**: `index.js`、`lib/`、`src/`、`client/src/` の確認範囲で実行経路を見つけていない。外部設定・別システムによる実装までは否定しない。
- **未検証**: この調査ではUI実機・通話・DB・外部サービスの成功証跡を採取していない。以下の全行の実運用状態に適用する。

現行の主要な到達経路:

1. `index.js:639 /incoming-call` → Twilio署名検証 → `lib/twiml.js:27` → `index.js:2885 /media-stream` → `handleMediaStreamConnection` → Live/Realtimeのセッション。
2. `index.js:1169 startHandoff` → ActionGate → `lib/handoff.js:394 updateTwilioCallTwiml` → `lib/handoff-routes.js` → `lib/handoff-outcome.js` → Outboxおよびv2投影。
3. `index.js:2784` 終話抽出 → `notificationOutbox.enqueue` → `lib/notification-outbox.js:150` → Resend。`index.js:2813` → `projectProviderCall` → `src/calls/call-projector.ts:265` → Call/Escalation repository。
4. `index.js:393` → `initAdminV2Services` → `lib/admin-v2-routes.js:172` → CallService / EscalationService / KnowledgeService。バックエンドbuild読込失敗時はv2登録なし、Firestore無効時はメモリ実装である。
5. `index.js:426 initKnowledgeTool` → `lib/knowledge-tool-runtime.js:56 executeKnowledgeCall` → `KnowledgeReader.lookup` → 公開releaseのみ検索。

## 20能力の突合

| # | 能力・競合の一次資料 | 現コードと判定 | 不足とCorへの影響 | 最小実装・反証可能な受入条件 |
|---|---|---|---|---|
| 01 | AI一次受付・要件抽出。[IVRy](https://ivry.jp/features/) | **コード確認**。`index.js:106` 日本語受付指示、`:2382` 入力文字起こし、`:2899` 抽出。`lib/realtime-tool-flow.js:96`、`src/domain/reception-state.ts:34` は連絡先確認と終話制御 | 実音声からの業務項目正答率・聞き返し率・受付完遂率はこの調査で未実証。正規表現や分類テストの合格だけでは聞き取り品質を保証できない | 既存goldenシナリオへ実音声fixture・人手正解を対応付ける。静音/雑音/割込/電話番号訂正を含み、誤った確定値0件・未確認を未確認として保存することを検査 |
| 02 | 営業時間・休業日・時間帯分岐。[IVRy](https://ivry.jp/function/ivr-for-after-business-hours/)、[Amazon Connect](https://docs.aws.amazon.com/connect/latest/adminguide/set-hours-operation.html) | **経路未確認**。`index.js:639` 着信は署名検証後にMedia Stream/DTMFを選ぶ。`src/domain/routing-policy.ts:53` の転送判断に時刻・カレンダー引数なし | 夜間の非当番者への発信、翌営業日の折返し説明不一致。ナレッジの営業時間カテゴリだけでは転送を制御しない | 営業時間と当番をversion付きpolicyとして保存し、着信と転送直前に評価。境界時刻・祝日override・無効timezone・休業中の緊急業務をfake clockで検査 |
| 03 | IVR分岐・設定UI。[IVRy機能](https://ivry.jp/function/)、[MiiTel Call Center](https://miitel.com/jp/service/callcenter/functions/) | **部分実装**。`index.js:676`、`lib/twiml.js:61/69` に1桁DTMF。実分岐は `5` → 練習系、それ以外は通常受付 | 「一般IVRがある」と数えると過大。部署分岐、再入力、無入力回数、管理者が編集するフローがない | 既存TwiML builderへ限定された部署分岐設定を追加。未知桁/タイムアウト/連打で誤転送せず通常受付へ1回だけ到達。Corでは現時点の優先度は低い |
| 04 | 用件別の人間転送・複数宛先。[IVRy](https://ivry.jp/function/transfer-call/)、[Connect routing](https://docs.aws.amazon.com/connect/latest/adminguide/routing-profiles.html) | **コード確認**。`index.js:1169` → policy/action gate → Dial。`lib/twiml.js:80` は最大10番号、`:111` は要約と1/2承諾。`lib/handoff.js:147` が設定生成 | 固定のcontract/general番号群で、担当者available状態・優先度・待ち行列のモデルはない。多数人のセンターへはそのまま拡張できない | まず当番policyを既存destinationへ解決。複数転送の承諾競合、拒否、話中、切断を実機で1接続/1通知に収束させる。待ち行列は人数増加時に別意図として判断 |
| 05 | 不在・拒否時の留守電/受付継続。[IVRy転送](https://ivry.jp/function/transfer-call/) | **コード確認**。`lib/handoff-routes.js:176/267` → Record/completed/absent → `lib/voicemail.js` → Outbox。`:401` は認証付き再生 | 留守電の実音声品質、文字起こし、メールの受信、認証付き再生は本調査未検証。通常AI通話の録音とは別能力 | 既存runbookの実機表で1/2/無入力/不在/話中、completed/absent、再送を確認。録音なしを録音済みと表示しない |
| 06 | 折返し待ち・責任者・期限。[Connect queued callback](https://docs.aws.amazon.com/connect/latest/adminguide/setup-queued-cb.html) | **部分実装**。`src/calls/call-schemas.ts:44` にassignee/callbackStatus、`src/escalations/escalation-service.ts:35` にackDeadlineAt、`:197` assign、`:235` ACK。`src/calls/call-projector.ts:302` は自動生成期限null | 担当・期限の型があるだけで期限遵守にはならない。期限消費・未処理再通知・担当不在時の次責任者を確認できず、メール後の放置を検出できない | 既存case/callを使う期限監視。due時刻を過ぎたcaseだけ1回通知、ACK/解決済み除外、競合二重実行/再起動で重複0。自動架電は初期範囲に含めない |
| 07 | 受電通知・配信状態。[IVRy](https://ivry.jp/features/)、[MiiTel Phone](https://miitel.com/jp/service/phone/functions/) | **部分実装**。終話は`index.js:2790` → `NotificationOutbox.enqueue`、failed retry APIは`:429`。一方`lib/admin-v2-routes.js:850` notify-requests はmarkNotifiedだけ | 管理APIの通知操作では送信処理に到達しない。`markNotified`がnotifiedAtを更新するため送信証跡とUI状態が分離。Resend acceptedも受信箱到着ではない | 同じOutboxへrequestを永続化し、accepted結果とproviderMessageIdがある時だけsent相当へ更新。503/timeoutでnotifiedにしない。配信後bounceは別状態、ACKは別操作 |
| 08 | 録音・全文文字起こし・検索再生。[MiiTel Phone](https://miitel.com/jp/service/phone/functions/) | **部分実装**。`index.js:498` 話者別turn、`lib/call-log-sinks.js:85` transcript保存。録音/再生は留守電経路。`lib/twiml.js:27` 通常通話Streamに録音設定なし | 通常AI応対で誤聴・無音・被りが起きても音声から再評価する経路を確認できない。全文テキストは聴感の証跡にならない | まず同意済みの検証fixture音声とイベントを紐付ける。本番録音の採用は保持/削除/アクセス要件と一緒に設計。声を保存しないモードでも時刻計測が使えること |
| 09 | FAQ・ナレッジと回答出典。[IVRy](https://ivry.jp/features/)、[MiiTel FAQ](https://miitel.com/jp/service/phone/functions/) | **コード確認**。`KnowledgeService:254/268/312` レビュー承認公開、`KnowledgeReader:92` 公開release検索、`lib/knowledge-tool-runtime.js:85` releaseId/status、`index.js:2849` 利用releaseの投影 | 手動整備と検索はある。未解決質問からFAQ候補を生成→承認する連続経路は未確認。実通話で回答に使われた根拠と品質の評価も必要 | unknown/expiredを匿名化してKnowledgeReviewへ候補化し既存承認経路を再利用。withdrawn/expiredが音声回答に復活しない、draft非公開、同一質問の重複候補抑制 |
| 10 | 顧客単位の履歴・VIP・番号制御。[IVRy](https://ivry.jp/function/)、[MiiTel DB routing](https://miitel.com/jp/service/callcenter/functions/) | **部分実装**。CallRecordはcallId単位。`index.js:639` はFromを受けるが顧客台帳照合経路なし。`fromNumberMasked`と会話で確認したcallbackNumberは区別される | 再入電を同一案件としてつなぐ表示、番号単位の拒否、既存顧客の担当提示が未確認。発信者番号一致だけを本人認証に使ってはいけない | 正規化番号の照合キーと案件リンクを作り、オペレーター確認の候補として提示。非通知・共用番号・番号変更で誤統合しない。AIへ過去PIIを自動提示しない |
| 11 | SMSによるURL/フォーム案内。[IVRy](https://ivry.jp/function/send-sms/) | **経路未確認**。`lib/notification-outbox.js:32` はResendメール。TwilioのCalls/RecordingはあるがMessages送信の実行経路なし | URL・メール綴りの口頭復唱が長くなる。CorのWebフォーム誘導で効果はあるが、現在の未処理放置を解決しない | 既存outbox/idempotency/gate概念を再利用する別channel。確認済み携帯番号、送信同意、公開URL allowlist、送信回数上限。相手を装った任意本文/番号送信は拒否。未送信は案内しない |
| 12 | CRM/SFA・予約・外部業務連携。[MiiTel Phone](https://miitel.com/jp/service/phone/functions/)、[IVRy](https://ivry.jp/features/) | **部分実装**。`lib/call-log-sinks.js:152/202` はFirestoreとGoogle Sheetsへ記録。予約更新やCRM活動作成の経路なし | 受付後に別台帳へ手入力が必要。Sheets appendは案件同期・二重登録制御を含むCRM連携とは異なる | まずCallRecord確定イベントを許可済み1宛先へoutboxで配信。callId+eventVersionを冪等キーにし、修正と削除も伝播。受信側障害で通話受付を巻き込まない |
| 13 | 通話内容・応対品質のスコアカード。[Connect evaluations](https://docs.aws.amazon.com/connect/latest/adminguide/evaluations.html)、[MiiTel](https://miitel.com/jp/service/callcenter/functions/) | **部分実装**。`src/eval/synthetic-eval.ts`、golden fixture、`ops.needsReview`はある。通話別評価票・人間採点・証跡時刻・採点版の保存経路は未確認 | 分類正解だけでは誤案内、過剰質問、未確認連絡先、長い無音を検出できない。モデル変更後の品質退行を見逃す | 既存turn/CallRecordへrubricVersionと判定根拠を関連付ける。価格断定、終話前確認、転送方針、割込復帰をcriticalとする。人手正解を隠したholdoutで評価 |
| 14 | 応答率・待ち時間・品質ダッシュボード。[Connect metrics](https://docs.aws.amazon.com/connect/latest/adminguide/amazon-connect-metrics.html)、[alerts](https://docs.aws.amazon.com/connect/latest/adminguide/rule-real-time-metrics.html) | **部分実装**。`lib/admin-routes.js:208` 件数/折返し/対応中/完了、`client/src/App.tsx:513` 表示。`index.js:2232` liveUsage。v2一覧は`src/calls/firestore-call-repository.ts:92` 最新500件上限 | p50/p95応答遅延、無応答時間、放棄率、転送成功率、失敗通知数、集計母数/欠損/期間が揃っていない。最新500件の一覧を全件KPIと扱えない | 既存イベントから時刻ベースの計測、日別集計と母数表示。期間・モデル・origin別。501件以上でも古い未処理が消えず、incompleteを成功に算入しない |
| 15 | リアルタイム監督・ささやき・介入。[MiiTel Phone](https://miitel.com/jp/service/phone/functions/)、[Connect monitoring](https://docs.aws.amazon.com/connect/latest/adminguide/monitoring-amazon-connect.html) | **経路未確認**。音声イベントはサーバー内で処理。管理UIは一覧/再読込、PSTN転送はあるが監督用ストリーム・介入APIなし | AI異常応答への即時介入は自動転送条件または電話外操作に依存。少人数Corでは監督常駐の運用費も考慮すべき | 最初はPII権限付き進行中イベント表示と「担当へ引継ぎ要求」のみ。別権限で中断/転送しActionGateへ通す。古いcallIdや完了済み通話への操作は拒否 |
| 16 | 個人認証・権限・監査。[MiiTel SSO/操作ログ](https://miitel.com/jp/service/callcenter/functions/)、[Connect security profiles](https://docs.aws.amazon.com/connect/latest/devguide/security-profiles-api.html) | **部分実装**。`src/admin/permissions.ts` にrole/permission、共有ACK禁止。`lib/admin-v2-routes.js:24/44` subject map。入口`lib/admin-routes.js:45`は単一Basic user/password | roleモデルはあるが複数本人を区別する認証入口ではない。mapのsharedAccount=false宣言だけでは本人性の証拠にならない。legacy APIは同じBasic認証のみ | 検証済み個人identityをActorへ一元化しlegacy/v2へ適用。2名の認証を使い操作監査が別subjectになることを実UIで確認。リクエストbody/headerから役割偽装不可 |
| 17 | PIIマスキング・保持・削除。[Connect redaction](https://docs.aws.amazon.com/connect/latest/adminguide/sensitive-data-redaction.html) | **部分実装**。`lib/admin-v2-routes.js:146/153` viewer投影、`src/calls/call-service.ts:351` soft-delete/hold。`lib/call-log-sinks.js:85/277` transcriptを保存/Sheetsへ出す | soft-deleteはデータ消去ではない。全保存先の保持期限、削除job、録音削除、マスキング漏れの保証は未確認。calls.purge権限の宣言だけでは処理に到達しない | 保持対象一覧と保持期限を定義し、Call/legacy/Outbox/Sheets/録音それぞれの消去結果を追跡。まずdry-runで対象を返しhold除外、監査用最小メタデータを残す |
| 18 | 多言語受付。[IVRy](https://ivry.jp/function/) | **現仕様は日本語専用**。`index.js:106/1851` は日本語限定、`lib/twiml.js` Say ja-JP、`lib/voicemail.js:79` transcription ja | 基盤モデルが多言語でも製品としての多言語対応は成立しない。Corの利用実態で必要性を確認するまでは低優先 | 対象1言語に限定し言語判定/定型案内/FAQ/同意/転送引継ぎを揃える。言語混在・電話番号読み・日本語への戻しを受入。現指示との衝突を解消する |
| 19 | データ出力・全期間検索。[IVRy CSV](https://ivry.jp/function/)、[MiiTel reports](https://miitel.com/jp/service/phone/functions/) | **部分実装**。Sheets転記あり、v2 calls APIにcursorあり。`src/calls/firestore-call-repository.ts:92` は全ページが最新500件の取得を基点とする。calls.export権限はあるがroute未確認 | 古い未処理の探索や期間統計に欠落が出る可能性。Sheetsは運用検索や権限付きエクスポートAPIの代替にならない | Firestore側の安定順序(cursor+docId)とfilterを実装。501件超/同時刻/途中挿入/削除でも重複・漏れなし。CSVは権限と式注入防止、件数/期間/partialを表示 |
| 20 | 業務ポリシーの変更・公開・ロールバック。[Connect hours](https://docs.aws.amazon.com/connect/latest/adminguide/set-hours-operation.html)、[routing](https://docs.aws.amazon.com/connect/latest/adminguide/routing-profiles.html) | **部分実装**。ナレッジはrelease有り。`lib/runtime-settings-store.js:69` 設定更新、`lib/admin-routes.js:390` runtime PATCH、`src/domain/routing-policy.ts` はコードflags中心 | FAQ公開版と転送/営業時間/通知先ポリシーを一つの通話証跡で追えない。通話途中の変更がどの判断に作用したかの説明が難しい | 既存settingsの保存基盤へroutingPolicyVersionを追加、検証→公開→旧版参照。callに開始版/転送評価版を記録。緊急停止は新規外部アクションに即時適用し、開始版固定で停止を無視しない |

## 上位5の追加実装設計

既存dependencyの `@google-cloud/firestore`、Node crypto/clock/HTTP、既存Fastify/Reactを使う前提。新規外部API・新フレームワークは採用しない。個人認証連携先は本設計では未選定で、組織側のissuer/認可・実API検証が必要。性能改善は未計測のため主張しない。以下の候補は各1 PR=1意図へ分割する。

### P1 通知要求を配信証跡へ接続する

**具体的な問題**: `POST /api/admin/v2/escalations/:id/notify-requests` は認証/権限を通った後 `EscalationService.markNotified()` しか呼ばない。関数は現在時刻でnotifiedAtを書き、audit successを残す。`NotificationOutbox` はサービスに渡されていない。ここでの成功は実メール送信を証明しない。

**再利用点と変更**:

- `index.js` から既存NotificationOutboxをv2 routeへdependency injection。別メール送信コードを作らない。
- 通知要求には `caseId + notificationPurpose + policyVersion` の安定キーを使用。ACKを取るまで同じIDの再送を行い、新規outboxを増殖させない。
- 既存Outboxのaccepted/failed、leaseOwner/leaseUntil、providerMessageIdを利用。caseにはoutboxIdと最後に観測した配信状態を関連付ける。
- `notifiedAt` はprovider acceptedの証跡後にだけ更新。`request accepted` と `provider accepted` はレスポンス/UIで区別。ACK/resolved/connectedをnotifiedへ戻さない。
- 配信成功後case更新に失敗した場合、同じoutboxをreadbackして修復できるようにする。送信失敗はACK期限を延長しない。

**受入**: injected sender 503/timeoutではnotifiedAtがnull、accepted時のみproviderMessageIdが残る。同じ要求を2インスタンスから同時実行して送信1回。送信後DB書込失敗→再試行で送信増0・case修復。ACK/connected/resolvedの後に再送して状態後退0。実サービスへの送信は承認された宛先・タイミングで別UAT。

**影響/撤収**: 通知が現在の固定宛先へ届く挙動を保持。新経路をflagで有効化し、移行期間はcase/outbox不一致件数を計測。不一致0と再送試験合格後、証跡なしのmarkNotified呼出しを廃止する。

### P2 未受諾・折返しの期限を運用可能にする

**具体的な問題**: ackDeadlineAtとassigneeはあるが、自動投影は期限null、期限を評価して責任者へ通知するconsumerが確認できない。通常の要折返しは高重要度以外ではEscalationCaseを作らないため、すべてをcaseへ複製して解決してはいけない。

**再利用点と変更**:

- 高重要度は既存EscalationCase `ackDeadlineAt/ownerSubject/state`、通常折返しはCallRecord `ops.assignee/callbackStatus` を正とする。通常折返しに `callbackDueAt` を追加し、自由文の `callbackRequestedWindow` を無理に時刻と見なさない。
- `GET /calls` / `GET /escalations` を担当・期限・未処理で絞れるようにする。最新500件窓へ依存せず、期限フィールドをFirestore queryする。
- 認証された内部triggerで一回走る `sweepDue(now,cursor,limit)` を実装し、期限到達イベントから既存Outboxへ渡す。起動し続けるsetIntervalだけへ依存しない。外部Scheduler設定は本番ゲートの別工程。
- リマインドは決定的キーと次回予定時刻を持ち、重複trigger/再起動に耐える。送信＝受諾としない。担当者が不明な場合は担当設定待ちとして可視化し、都合よく解決扱いしない。

**受入**: due-1秒は0、due時刻は1、重複triggerは増0。ACK/connected/resolved・callback completedは対象外。501件以上でも最古の期限超過を検出。担当変更と同時sweepでも誤った宛先へ二重送信0。未確定希望日時は要確認として表示し、AIが勝手に約束時刻を確定しない。

**影響/撤収**: PSTN自動架電は追加しない。担当者が管理画面で受諾/完了した証跡を残す。既存の人手未処理点検と期限一覧が同じ集合になり、欠落0を確認後に重複点検を廃止する。

### P3 個人認証と既存権限の適用範囲を揃える

**具体的な問題**: アプリの認証実装は単一Basic認証。v2はsubject mapを経由してActor/roleを決めるが、legacy APIはBasic通過が基本条件。個人ACK・承認・PII閲覧の権限モデルを宣言していても、入口で誰なのかを複数人分証明できていない。

**再利用点と変更**:

- 既存 `Actor` / `permissionsFor` / `INDIVIDUAL_ONLY` を保持し、認証の結果を統一したverified subjectへ変換するadapterを作る。リクエスト任意headerを認証済みと扱わない。
- `/app`、legacy call logs/ops/runtime、v2、voicemail再生、outbox retryに共通principalを渡す。PII閲覧と業務変更のpermissionをrouteごとに同じ基準で強制する。
- Basic互換はshared principalとして扱い、個人ACK/承認は拒否。個人セッションはissuer/audience/expiry/signatureを検査する。選定providerの実接続は未実施。
- ロール変更と失効を適用できるsession lifetimeを定義し、認証情報をログへ残さない。監査eventにはverified subjectと操作対象を保存する。

**受入**: 2人の実UIログインで異なるsubject、viewerがlegacy経由でもPII不可、共有BasicでACK不可、expired/wrong audience/forged rolesは403または401。設定ミスはsupervisorへ昇格させず閉じる。署名付きTwilio webhookは別principalのまま維持する。

**影響/撤収**: UI互換を先に整え、全旧API利用箇所を計測して段階移行。旧Basic bypassのcallsiteが0になり本人UAT合格後に管理用共有認証を撤収する。

### P4 音声受付品質を再現可能な評価と運用計測にする

**具体的な問題**: モデル接続・音声chunk・分類正解は、誤案内や長い沈黙がないことを意味しない。既存 `turns`、入力ゲート、tool watchdog、playback mark、voice eventsは観測源として使える。

**再利用点と変更**:

- 既存VoiceEventとPlaybackControllerを使って、発話終了→最初の意味ある応答音声、tool待ち、割込復帰、無音、転送開始/承諾/接続の時刻を記録。ネットワーク受信と相手の再生完了は別の値にする。
- CallRecordへ評価IDとmetric completenessを関連付け、評価票にrubricVersion、scenarioId、期待業務結果、根拠turn/time、human reviewを保存する。既存 `needsReview` は入口として利用する。
- 通常/雑音/遠距離/割込/無言/番号訂正/曖昧緊急/営業/FAQ不明のfixtureセットを固定し、モデル・voice・gate設定をmanifestへ記録する。
- 期間集計はlatest500一覧から算出せず、総数、除外数、欠損数、p50/p95、失敗種類を出す。評価用syntheticと実通話originを混ぜない。

**受入**: clean/noisyの同一内容で業務期待値を比較。critical項目（誤った連絡先確定、未確認価格断定、禁止転送、受付を失う終話）は0件。応答遅延閾値はまず基準実測を取り、合意値を設定。欠測はpassに算入せず、音声のある遅延注入が計測値へ反映されることを検査。聴感・自然さは人間評価が残る。

**影響/撤収**: 本番の全文音声保存を前提にせず、まず同意済みfixtureとPIIを含まない時刻情報。単体テスト件数を品質代替指標として使う運用を、実音声rubricと欠損付きKPIへ置換する。

### P5 営業日・当番・緊急例外を転送policyへ適用する

**具体的な問題**: 営業時間はナレッジとして答えられても転送判断には時刻が渡らない。Coreの「緊急業務は人へ、通常案件はAI受付、生命身体は110/119案内」を時間帯と整合させる必要がある。

**再利用点と変更**:

- `RuntimeSettingsStore` の永続化を再利用し、typed policyにtimezone、weekday windows、date overrides、contract/generalの当番destination、afterHoursActionを定義する。既存の任意浅いmergeへ無検証で混ぜない。
- `evaluateTransferRequest` に評価済みavailability factを加える。LLMが営業時間/当番を直接選ばず、発信直前のサーバーが決める。
- 通話開始時のpolicyVersionを記録し、外部発信直前にも緊急停止/当番変更を再検査する。説明に使った版と発信に使った版が異なれば両方を記録する。
- 休業時は既存AI受付/留守電/折返しへ誘導。次営業日の確定日時を保証できる時だけ案内し、担当未定を即時対応可能と話さない。

**受入**: JST日跨ぎ、営業開始/終了ちょうど、昼休み、臨時休業、当番なし、通話途中の停止、時刻不正をtable test。生命身体の緊急を会社転送へ変えない。緊急業務と非緊急商談の現行方針を保持し、休業中の不正発信0。UIプレビューと実callsiteが同じpure evaluatorを使用する。

**影響/撤収**: 初期設定は現動作を明示的に再現してshadow評価。意図した時間帯差分だけであることを確認して有効化。ナレッジ中の営業時間とpolicyが不一致の場合に公開を拒否またはレビュー要求し、二重編集を減らす。

## 実装順と依存

P1（通知証跡）を先に実装し、P2（期限）がP1の配送結果を使う。P3（本人性）は個人ACKの本番受入前に必須。P4（品質実測）は音声モデル変更と独立して着手可能。P5（営業時間）はP2の折返し期限算定と同じclock/calendarを使う。SMS、CRM、ライブ監督、一般IVR、多言語は20能力表に差分を残すが、今回の上位5を膨らませるために混ぜない。

## 限界・強制点の実測範囲

| 事項 | 現状 | この調査で確認した範囲 |
|---|---|---|
| 競合機能 | 公式の機能説明/管理Docs | 2026-11-07閲覧。料金/プラン/日本リージョン適用・実機品質は未検証 |
| repository | HEAD 0ddbd49a7b63596136c95b2f684a485782244850 | production entrypointからのソース追跡。production env/DB/Cloud Run revisionは未照合 |
| 通知の強制点 | Outbox acceptedとcase notifiedが別経路 | route→markNotifiedを確認。外部送信試験なし |
| 期限の強制点 | 保存・表示・assign以外のconsumerを未確認 | `ackDeadlineAt`のproduction source検索。外部Schedulerの有無は未照合 |
| 権限の強制点 | v2 permissionあり、入口は単一Basic | `createAdminBasicAuth`→deriveActorを確認。実identity/権限設定は未照合 |
| 評価の強制点 | unit/syntheticと音声runtime観測源あり | この調査ではテスト・実通話再実行なし。品質合格は主張しない |
| 追加実装（調査開始時点） | この競合調査レーンでは設計のみ | 対象HEADでの判定。後続レーンのimplemented / PR-ready / merged / deployed / live evidence / issue-closeableは本資料では判定しない |

本資料の受入は「20能力に一次資料・codecallsite・不足・受入を付け、上位5の既存API再利用設計を提示したこと」に限定する。製品の完成や競合以上の品質を宣言しない。
