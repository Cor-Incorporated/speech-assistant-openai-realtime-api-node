# ADR 0007: 問い合わせ通知をResendへ統一する（Cloudia連携）

- ステータス: 採用
- 日付: 2026-07-15
- 対象: 通話後のメール通知、Cloudia（テキスト問い合わせ）との通知経路統合

## 背景

Cor.の問い合わせ窓口は2系統ある。

| 入口 | システム | 通知 |
|---|---|---|
| テキスト（cor-jp.com） | Cloudia = corsweb2024リポジトリ `workers/contact-chat`（Cloudflare Worker） | **Resend実装済み**。宛先 cloudia@cor-jp.com、Outboxパターン（D1 + Cloudflare Queues、internal通知とreceiptの2種、配信ステータス管理） |
| 音声（050番号） | 本システム | メール通知なし（Firestore/Sheetsへの記録のみ） |

音声問い合わせもテキストと同じ宛先・同じ書式でメール通知されれば、担当者は1つの受信箱で全問い合わせを把握できる。

## 決定

1. 本システムに**Resend経由のメール通知**を追加する。宛先・差出人はCloudia側と揃える（宛先 cloudia@cor-jp.com。CC等の運用値は環境変数で管理）。
2. **Outboxパターンで実装する**。送信要求をFirestoreのoutboxコレクションへ書き込み、非同期ワーカーが送信・リトライ・配信ステータス記録を行う。Cloudia側のD1 + QueuesはWorkerランタイム固有の実装詳細であり流用しない。本システムでは既存の永続層（Firestore）で同型を実装する。
3. **送信契機**:
   - 通話終了時の内容サマリ通知（既存の抽出結果 `extractCallDetails` を本文へ）
   - 人間引き継ぎの不応答フォールバック（[ADR-0006](./0006-handoff-phase1-pstn-transfer.md)）での折り返し依頼通知
4. Resend APIキーは Secret Manager（`resend-api-key`）で管理する。Cloudia側と同一キーを共有するか本システム用に別発行するかは、実装issueでResendダッシュボードの運用（送信ドメイン・レート）を確認して確定する。

## 実装方針（要点）

- Cloudia側の実装（fail closed: キー未設定なら送信系を503にし、問い合わせを握り潰さない／Queue payloadにPIIを載せない）を参照アーキテクチャとする。
- 本システムの通知本文には通話サマリ・折り返し先電話番号が含まれる。outboxドキュメントの保持期間と、本番ログへのPII非出力（既存の `maskPhone` 方針）を維持する。
- 詳細設計: [notification-resend-outbox.md](../notification-resend-outbox.md)

## 影響

- 関連issue: Resend+Firestore Outbox実装（Wave D1）、不応答フォールバック（Wave C3）
- Secret Manager（cor-jp-web、[ADR-0005](./0005-gcp-project-migration-cor-jp-web.md)）に `resend-api-key` を追加
- 通知経路の全体像: テキスト=Cloudia→Resend、音声=本システム→Resend＋必要時に携帯コール（ADR-0006）へ合流
