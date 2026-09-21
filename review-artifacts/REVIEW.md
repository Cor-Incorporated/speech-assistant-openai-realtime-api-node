# AI受付 独立レビュー・テスト結果（2026-09-21）

**総合判定: 受入不可。全シナリオ・全要件を満たすとは判定できない。** 既存280テストと管理UIの既存5 E2Eは通るが、追加した境界条件の6試験が安全側の期待に反して失敗した。これに加え、実Live APIで既知の代表者情報を回答できないこと、Realtime APIが現行の知識tool出力形式を拒否することを確認した。

修正・デプロイ・GitHubへの投稿は実施していない。本報告は対象SHAのレビュー成果物。添付シナリオ内の切戻し・Secret変更コマンドは参照資料として扱い、実行していない。

## 1. 依頼された4点の回答

| 評価軸 | 判定 | 根拠 |
|---|---|---|
| TypeSafe Jev / OpenAI Liveを一次仕様・推奨設計どおり使えているか | 一部適合、受入不可 | 正規API・モデル・tool往復は実接続成功。ただし認証前接続、watchdog、副作用Gate、個人情報マスクに不備。Jevはshadowであり、本番判断をJevが担う状態ではない |
| S-01〜S-14 / A-01〜A-05をすべて実行できるか | 不合格・一部未検証 | S-01/02/04/08/13に具体的阻害。管理操作はローカルで成立。実電話での転送・音声再生・割込み・DTMFは未検証 |
| 要件定義をすべて満たすか | 未充足 | 形式検証と本人確認の分離、25秒無音上限、失効知識の除外、実通話とv2管理の連携に未充足。包括的な承認済み要件一覧は今回の資料だけでは確定できない |
| Cor.株式会社の知識は正確か | 公開記載との整合は概ね良好、利用上の欠落あり | 公開52件中35件は一次公開情報と矛盾なし。17件は人間確認が必要で未確定。代表者・住所・料金の検索品質に問題 |

## 2. 対象と検証境界

- 対象commit: `526deb4dd1b8e70aff64e8a4dbba12cf5aa7e037`（PR #96 merge commit / origin/develop）。
- GitHub merge実時刻: **2026-09-21 12:06:30 JST**。元報告のEvidence末尾の「2026-09-20」とは一致しない。[PR readback](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/review-artifacts/pr96.json)
- Actions run `35556371791`のcheckout SHAとdeployログを照合。Cloud Run `speech-assistant-realtime-00032-pb4`、100% traffic。デプロイ時刻12:09 JST。[SHAとrevisionの対応](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/review-artifacts/deploy-sha-binding.log)
- image digest: `sha256:5ebe9e6808e8a3effa86f3d5dba176e4c1bb0927ed64b81054592b585ee5585f`。[実設定](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/review-artifacts/production-metadata.json)
- 本番: Live=`gpt-live-1`、backend=`gpt-5.6-luna`、voice=`marin`、PCMU/8kHz、stream auth有効。Jev=`jev-1.13.0`、shadow、deadline=500ms。
- 知識: 現行release `rel_20260919004348_9b492cc4`、公開52件。DB読取12:18 JST、公式ページ照合12:30 JST、本番UI読取12:39 JST。
- 実APIには合成日本語音声・合成テキストのみを送信。実通話ログ本文、録音、転送先番号を取得・送信していない。APIキーは子プロセスの環境へだけ供給し、成果物に保存していない。
- 実Liveシナリオは本体`index.js`をローカルで起動し、Twilio互換クライアント→実OpenAIへ接続。読取済み公開知...[23789 chars truncated]...理由 |
|---|---|---|
| 形式検証と発信者確認を分離 | 未充足 | R05。状態クラスが存在しても実flowで強制されていない |
| 音声生成と電話での再生を分離 | 一部実装・実機未検証 | mark/clear単体試験は通る。PSTNでの音切れ・barge-in・終了順序は未確認 |
| 分類と転送権限を分離 | 構造は存在、実行不良 | shadowは権限を持たないがR03で正常転送も止まる |
| 古いrevision/二重操作を抑止 | 全経路はNOT_PROVEN | Gateに現在revision同士を渡すcallsite、in-memory ledger。生成開始時revisionから副作用までの統合保証を別途検証する必要 |
| 25秒無音を上限にする | 未充足 | R02で反例あり |
| 公開・非失効知識だけ回答 | 未充足 | draft/admin_only除外は成立、設定障害時の撤回除外はR04 |
| 公開知識を会話で参照 | 未充足 | 実Liveの自然な代表者質問でunknown（R07） |
| 通話ログ/詳細で知識の参照元を確認 | 未充足 | session.knowledgeLookupsはあるが、`buildCallLogRecord`は保存しない。Cloud LoggingのreleaseIdだけでは#14の永続的source metadataの確認を満たさない |
| 通話訂正・履歴・復元、通知≠ACK | 手動v2レコードのUI/APIは成立 | 実通話の取り込み・自動案件作成はR09 |
| 人間whisper受諾、不応答fallback、Resend到達 | 実機・受信側はNOT_PROVEN | 模擬・コードの存在に留まる。今回実発信・メール送信なし |
| ナレッジ文書upload/インデックス状態 | 今回の構造化seed/編集UIでは#14全体を満たさない | #14 OPEN。構造化知識releaseと文書RAG登録の受入条件を分ける必要 |
| Phase 2のVoice SDK/Conference等 | 継続計画 | roadmap上の別フェーズ。今回PRの回帰バグとは扱わず、「全要件完了」の根拠にも使わない |

参照: [Issue #14](https://github.com/Cor-Incorporated/speech-assistant-openai-realtime-api-node/issues/14)、[Epic #20](https://github.com/Cor-Incorporated/speech-assistant-openai-realtime-api-node/issues/20)、[ADR0009](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/docs/adr/0009-voice-provider-routing-separation.md)、[必須分離の調査メモ](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/docs/research/2026-09-18-reception-modernization.md:27)、[通話ログ生成](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/lib/call-log-sinks.js:60)。Issueのチェックボックスや過去記載は現在の稼働証明として流用していない。

## 7. Cor.知識の精度

[52件の項目別照合台帳](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/review-artifacts/KNOWLEDGE-LEDGER.md)と[公式ページ取得情報](/Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/codex/chore-reception-review-20260921/review-artifacts/sources/index.json)を参照。

- 代表者、所在地、機密AI/ローカルLLM支援、全国対応、Cloudia日本語/英語、公開支払条件などは現行公式サイトの記載と矛盾なし。
- 診断10〜30万円、PoC3か月300万円〜は公式掲載の目安に整合。GriftのTeam Beta月額5万円〜、Paid Trial3か月15万円〜、Estimate Audit100万円〜も公開ページに整合。確定見積や税込保証ではない。[Cor公式](https://cor-jp.com/)、[Grift公式](https://griftai.org/)
- ISMSは取得に向けて整備中という保存内容で、取得済みと誤記していない。[情報セキュリティ方針](https://cor-jp.com/security/)
</file-view>

=== MESSAGE 76 - Assistant ===
レビューの再現テストを確認します。

=== MESSAGE 77 - Tool ===
