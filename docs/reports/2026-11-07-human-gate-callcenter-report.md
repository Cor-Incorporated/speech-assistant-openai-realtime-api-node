# Cor.株式会社 人間転送・留守電テスト報告

作成日: 2026-11-07（JST）。対象: PR #117 とデプロイ前の追補修正。

## 受入仕様

| 通話 | 期待動作 |
|---|---|
| 緊急の担当者対応 | 指定番号へ転送、AI要約後に1/2判断 |
| 1承諾 | 発信者と接続。最終callbackで接続済みを記録し通知1通 |
| 2・無入力・切断・不在・話中 | 受付側留守電へ。AI受付には戻らない |
| 留守電completed | 録音・文字起こし・要約・認証付き再生リンクをメール1通 |
| 留守電absent | 録音なし通知1通 |
| 非緊急の開発見積・営業・資料請求 | AI受付を終え、メール通知。人間へ発信しない |
| 生命・身体の危険 | 110/119案内。会社担当者へ転送しない |
| 廃止済みメール宛先 | 新規・保存済み通知の再送とも送らない |

## 前報告との相違

- このMacではGCP・Twilio・Resendの既存認証を利用できる。
- 本番のHANDOFF_ENABLED/NOTIFY_EMAIL_ENABLEDは既にtrue。マージ時点で新動作へ切り替わる。
- 元のPRでは非緊急の受託相談が転送対象だった。最新依頼に合わせてAI完結へ変更した。
- 元の「493件成功」は今回の実行結果ではない。既存worktreeまでnode --testが探索するため、npm testの探索を本体testとgit管理のreview-artifactsへ明示的に限定した。

## 再現して修正した問題

1. 自動転送のstartingフラグ二重設定により発信されない問題（元PR）。
2. 「納得できません」の苦情検出漏れ（元PR）。
3. 転送途中の通常要約と留守電通知の二重メール。
4. 留守電通知が失敗してもRecordingSid一致で再送されない問題。
5. 並行callbackによる重複通知と、既存outbox再送で廃止宛先が復活する問題。
6. 人間の承諾前にconnected/doneと記録する問題、および遅延投影による状態逆戻り。
7. 最終録音状態absentの通知漏れ、trim前のaction時間による空通知の誤判定。
8. 音声が来ない切断・APIエラーでもsmokeがexit 0となる偽成功。

## 検証の範囲

39ゴールデンシナリオは手書きの仕様期待値で、分類の下位判定を検査する。人間ゲート7、AI業務受付10、AI一般10、高精度6、緊急案内3、迷惑対応3。分類関数の合格だけを音声受付全体の合格とは扱わない。

シナリオテストでは1/2、無入力、各転送結果、録音completed/absent、署名拒否、再生認証、通知失敗後の再送、並行callback、Firestore障害、廃止宛先を検査する。実index.jsのE2EはTwilio/OpenAI/Resendをローカルstubにし、署名とMedia Stream認証を有効にして転送と通知の総数を検査する。

実APIではRealtimeのsession.update受理と、GPT-Live-1/harema/gpt-5.6-luna/μ-law 8kHzの入出力・委譲を確認した。Live実測は19.323秒、音声142チャンク、113600 bytes、ツール往復1回、error 0。これはプロトコル検証であり、電話の聴感や業務応答品質の受入とは別。

## 最終ローカル検証

`npm test` は構文・フロント型検査・フロント/バックエンドbuildを含め **527件成功、失敗0、skip0**（2026-11-07 JST）。`smoke:local` もroot/health/incoming-callの3経路が成功した。新規の終端競合・通知再送・非緊急判定は修正前の失敗を再現してから確認した。

## デプロイ前readback

- 現revision: speech-assistant-realtime-00054-znm、traffic 100%、SHA 532ddede6b5534f70647b765483673e5f54ea5ea。
- Twilio着信Webhookは対象Cloud Run、runtime認証はHTTP200、日本low-risk発信は許可済み。
- Resendのcor-jp.comはverified。
- 転送先設定はhandoff-numbers version 2へ統一し、指定番号との一致をreadbackした。
- LIVE_VOICE=haremaをGitHub Variableへ設定。認証情報・実番号は本報告に含めない。
- workflowのenv宣言と注入を照合。片側だけHANDOFF_FALLBACK_MODEを除去した変異はexit1、元はexit0。H5証跡なしはexit1と台帳append、証跡ありはexit0。

## 人間ゲートと費用

担当者が1/2を押す実機接続、電話越しの聴感は、ユーザー指定の待機時間後の確認として残る。実施状況は最終報告でimplemented / merged / deployed / live evidenceを分けて記載する。

上限は$50。実API・実通話は回数と時間を限定し、テスト通話は最大110秒。請求の確定値と時間からの見積を区別する。外部API実行済みなので今回の費用を$0とは報告しない。

運用手順と実機表は[Runbook](../runbooks/human-gate-activation.md)、設計は[ADR-0010](../adr/0010-human-gate-voicemail-fallback.md)。
