# ADR 0005: GCPプロジェクトを cor-jp-web へ統一移行する

- ステータス: 採用（実行待ち）
- 日付: 2026-07-15
- 対象: Cloud Runデプロイ先、Firestore、Secret Manager、Twilio webhook設定

## 背景

本システムのCloud Runサービスは現在、`aipartner-426616` プロジェクトで稼働している（[cor-cloud-run-preview.md](../cor-cloud-run-preview.md)）。一方、Cor.のお問い合わせ導線は次の構成で `cor-jp-web` プロジェクトへ集約が進んでいる。

- テキスト問い合わせ: Cloudia（corsweb2024リポジトリの `workers/contact-chat`、Cloudflare Worker）
- そのLLMゲートウェイ: `cloudia-vertex-gateway`（cor-jp-web上のCloud Run）
- メール通知: Resend（Workerのsecretで管理）

音声問い合わせ（本システム）をテキスト問い合わせと同じ通知経路へ統合する方針（[ADR-0007](./0007-notification-unification-resend.md)）を踏まえると、課金・IAM・Secret管理を1プロジェクトへ集約するのが運用上合理的である。

また `aipartner-426616` には本システムと無関係なサービスが複数同居しており、コスト把握と権限管理が濁っている。`cor-jp-web` は現時点で `cloudia-vertex-gateway` のみの整理されたプロジェクトである（Firestore APIは未有効。移行時に有効化する）。

## 決定

`speech-assistant-realtime` サービスを `aipartner-426616` から `cor-jp-web` へ**段階移行**する。ビッグバン切替はしない。

### 移行手順（概要。詳細runbookは [gcp-migration-cor-jp-web.md](../gcp-migration-cor-jp-web.md)）

1. **新環境構築**: cor-jp-web で必要APIを有効化し、Secret Manager・Firestore DB・Cloud Runサービスを構築する。
2. **疎通確認**: `smoke:local` / `smoke:media-stream` / 管理UI / `check:realtime` を新URLに対して実施する。
3. **Twilio webhook切替**: 050番号のVoice webhookを新URLの `/incoming-call` へ変更する。実着信で確認する。
4. **監視期間ののち旧環境停止**: 問題なければ `aipartner-426616` 側のサービスを停止する。

### ロールバック

切替後に問題が出た場合、Twilio webhookを旧URLへ戻すだけで復旧できる。旧環境は監視期間が終わるまで削除せず停止のみとする。

## 影響

- 通話ログFirestoreは新プロジェクトに新規作成する。過去ログの移行要否は切替時に判断する（運用ビューのGoogle Sheetsは継続利用可能）。
- [cor-cloud-run-preview.md](../cor-cloud-run-preview.md) と `Readme.md` の実URL記載は、切替完了時に更新する（デプロイ前にURLを推測で書かない）。
- 関連issue: 新環境構築（Wave A1）、webhook切替と旧環境停止（Wave A2）
