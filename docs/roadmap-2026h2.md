# 実装ロードマップ 2026年後半（roadmap-2026h2）

最終更新: 2026-07-15

本ドキュメントは実行計画の正本である。意思決定の根拠は [ADR-0004〜0008](./adr/) を参照。各Waveの対応issue番号は **Epic issue #20 のチェックリストを正とする**（issue起票時に#20へ記載する）。

## 全体像

```text
テキスト問い合わせ: cor-jp.com → Cloudia (corsweb2024) ──→ Resendメール通知
音声問い合わせ:     050番号 → 本システム (Cloud Run) ──→ Resendメール通知 + 担当者携帯へ転送
練習システム(#5):   050番号 → DTMFゲートウェイ → 別リポ/別GCPプロジェクトへRedirect
```

## 完了済み（2026年前半の記録）

[implementation-plan.md](./implementation-plan.md)（Wave 1〜2Aの計画記録）より:

- Wave 1: ローカル音声ループ検証、Twilio Media Streams疎通、050実着信（issue #8, #9, #4, #18）
- Cloud Runデプロイ基盤とSecret Manager連携（#3, #16）
- Realtime API/モデル2026年版更新、`gpt-realtime-2` 既定化（#5, #7）
- 通話ログ: Firestore正本 + Google Sheets運用ビュー（ADR-0003）
- Wave 2A: Twilio署名検証、監査ログ、PII最小化ログ（#19）
- 通話ログ品質: 電話番号バリデーション（#51）、smokeログ除外（#52）
- React管理UI（通話一覧・抽出結果・ランタイム設定・モデル切替）

## Wave A: GCP移行（[ADR-0005](./adr/0005-gcp-project-migration-cor-jp-web.md)）

runbook: [gcp-migration-cor-jp-web.md](./gcp-migration-cor-jp-web.md)

| Wave | 内容 | 依存 | 完了条件 |
|---|---|---|---|
| A1 | cor-jp-webに新環境構築（API有効化・Secret Manager・Firestore・Cloud Runデプロイ） | なし | 新URLで `/health` 200、`smoke:media-stream` 成功、管理UI疎通 |
| A2 | Twilio webhook切替と旧aipartner環境停止 | A1 | 実着信で新環境応答、監視期間後に旧環境停止、`cor-cloud-run-preview.md`/`Readme.md` の実URL更新 |

## Wave B: gpt-realtime-2.1（[ADR-0004](./adr/0004-gpt-realtime-2-1-adoption.md)）

| Wave | 内容 | 依存 | 完了条件 |
|---|---|---|---|
| B1 | 2.1をモデル選択肢に追加（`lib/realtime-models.js`、テスト付き。既定は2のまま） | なし | `npm test` 通過、管理UIで2.1選択可能 |
| B2 | ベンチマーク実測と既定昇格 | B1 | `docs/realtime-model-benchmarks/` に実測記録、ADR-0004の判定基準充足で既定昇格+ADRステータス更新 |

## Wave C: 人間引き継ぎ第一弾（[ADR-0006](./adr/0006-handoff-phase1-pstn-transfer.md)）

設計doc: [handoff-phase1-pstn-transfer.md](./handoff-phase1-pstn-transfer.md)

| Wave | 内容 | 依存 | 完了条件 |
|---|---|---|---|
| C1 | `<Dial><Number>` による担当者携帯転送 | A2推奨 | パスアップtool発火で担当者携帯が鳴り、応答で発信者と接続 |
| C2 | Whisper（転送先へのAI要約読み上げ+受諾確認） | C1 | 担当者だけに要約が流れ、キー押下で接続。留守電誤接続なし |
| C3 | 不応答フォールバック（折り返し登録+メール通知） | C1, D1 | 全番号不応答時に発信者へ案内、callLogsへ折り返し登録、担当者へメール |

関連: issue #15（パスアップ判定tool）は第一弾仕様（PSTN転送のトリガー）へ更新済み。

## Wave D: Resend通知（[ADR-0007](./adr/0007-notification-unification-resend.md)）

設計doc: [notification-resend-outbox.md](./notification-resend-outbox.md)

| Wave | 内容 | 依存 | 完了条件 |
|---|---|---|---|
| D1 | Resend + Firestore Outboxによる通話サマリメール通知 | A1（Secret配置先） | 通話終了後にcloudia@cor-jp.comへサマリメール到達、失敗時リトライ、fail closed |

## Wave E: 練習システム分離（[ADR-0008](./adr/0008-practice-system-separation-dtmf-gateway.md)）

設計doc: [dtmf-gateway-design.md](./dtmf-gateway-design.md)、引き継ぎ: [practice-system-handover.md](./practice-system-handover.md)

| Wave | 内容 | 依存 | 完了条件 |
|---|---|---|---|
| E1 | DTMF振り分けゲートウェイ（フラグ既定OFFで先行実装可） | なし | DTMF `5`+`#` でRedirect、無入力は従来フロー、`smoke:media-stream` 非破壊 |
| E2 | 新リポジトリ立ち上げ引き継ぎ（フォーク+新GCPプロジェクト+初期issue起票+Emotion Logic単価確認） | なし | handover docのチェックリスト完了 |

## Phase 2: オペレーターコンソール（[ADR-0002](./adr/0002-operator-console-human-handoff.md)、第二弾）

同時多数着信・通話モニタリング・CRM連携が必要になった段階で着手する。`phase-2` ラベルで管理。

- #12 React: オペレーターコンソールの土台
- #13 WebRTC: Twilio Voice SDKソフトフォン
- #17 Handoff: Twilio Conference参加者制御（warm transferはTwilio公式 openai-programmable-sip 参照実装を候補）
- #11 Realtime UI: 通話状態イベントストリーム

## 継続バックログ（位置づけ）

- **RAG/ナレッジ**（#14, #29, #30）: 受付品質向上の中期テーマ。Wave A〜Eとは独立に着手可能。
- **VAD調整**（#1, #10）: 実通話ログに基づく継続チューニング。
- **TypeScript化**（#6）: 大規模改修。Wave C/E1のような`index.js`への追加が続く間は保留し、機能が落ち着いた時点で判断。
- **営業時間tool**（#53): 受付機能の拡張。RAGと同様に独立着手可能。

## 推奨着手順序

1. **A1 → A2**（GCP移行。以降の実装を新環境で行うため最優先）
2. **B1**（小さい。A系と並行可）→ B2
3. **D1**（通知基盤。C3の前提）
4. **C1 → C2 → C3**（引き継ぎ第一弾）
5. **E1 / E2**（練習システム系。E2は外部確認事項があるため早めに開始してよい）
