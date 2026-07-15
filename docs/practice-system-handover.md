# 電話応答練習システム 新リポジトリ立ち上げ引き継ぎ

対応ADR: [ADR-0008](./adr/0008-practice-system-separation-dtmf-gateway.md) ／ 対応Wave: E2

## 位置づけ

アルバイト向け電話応答練習システム（AIが顧客役、練習者の応対を3系統で評価するSaaS構想）は、**本リポジトリをフォークした別リポジトリ + 別GCPプロジェクト**で開発する。企画・要件定義は承認済み（要件定義書 統合版 v1.0、2026-07-10。企画書一式は社内保管）。

本リポジトリとの接点は [DTMFゲートウェイ](./dtmf-gateway-design.md) の `<Redirect>` のみ。

## 立ち上げ手順（チェックリスト）

1. [ ] 本リポジトリをフォークして新リポジトリ（例: `Cor-Incorporated/phone-training-system`）を作成する
2. [ ] 練習システム用GCPプロジェクトを新設する（受付システムのcor-jp-webとは分離。SaaS課金・テナント分離のため）
3. [ ] [emotion-logic-api-notes.md](./emotion-logic-api-notes.md) を新リポジトリの `docs/` へコピーする
4. [ ] Emotion Logicの**従量単価をRHS高橋氏へ確認**し、要件定義書のユニットエコノミクス（1通話原価）を実測値で更新する
5. [ ] Secret Managerに `emotion-logic-api-key` / `emotion-logic-api-key-password` を登録する（値はRHS発行メール参照。リポジトリに書かない）
6. [ ] 下記「初期issue一覧」を新リポジトリへ起票する
7. [ ] 本リポジトリ側のWave E1（DTMFゲートウェイ）と接続し、実発信で `5`+`#` → 練習システム着信を確認する

## 本リポジトリから引き継ぐ資産と、無いもの

### そのまま使える（フォークに含まれる）

- Twilio Media Streams ↔ OpenAI Realtimeブリッジ（`index.js`）
- 発話記録 `session.turns`（話者・本文・時刻）＝**評価の入力データ**
- 構造化抽出パターン（`extractCallDetails` のjson_schema）＝評価ルーブリックへの転用元
- 入力ゲート・VAD設定・終話ワークフロー・署名検証・監査ログ・Cloud Runデプロイ・React管理UI

### 本リポジトリに存在しない（新規実装が必要）

- **録音・音声tee**: 現行は音声をOpenAIへ転送するのみで、いかなる形でも保存していない。練習者音声（Twilio inboundトラックのみ）のWAV録音またはリアルタイムteeを新規実装する
- **μ-law→PCM変換**: Emotion Logicリアルタイム連携用（8kHzはそのまま使える。emotion-logic-api-notes.md参照）
- **評価エンジン**: 下記3系統の統合
- **シナリオ管理・マルチテナント・課金**: SaaS基盤

## 評価エンジン（フル実装方針）

要件定義書の3系統統合。各軸に `confidence` と `evidence`（根拠へのポインタ）を必ず持たせる。

| 評価軸 | 担い手 | 入力 | 備考 |
|---|---|---|---|
| 声のトーン・感情・共感・緊張 | Emotion Logic | 練習者音声（inboundのみ） | PoC=通話後 `analyzeFile`、本番=EMLO Dockerリアルタイムを検証 |
| 話速・間 | 自前計算 | `turns`（本文＋時刻） | 文字数÷発話秒数。**既存データだけで実装可能、最初に作る** |
| 言葉遣い・敬語・マニュアル順守 | 文字起こし×LLM（json_schema） | 文字起こし＋マニュアル | `extractCallDetails` パターンを評価スキーマへ差し替え |

### 実装順の推奨

1. **話速評価**（既存turnsのみで完成。最小の差別化を最速で実証）
2. **LLM内容評価**（既存の構造化抽出パターン転用）
3. **Emotion Logic連携**（録音実装→`dummyResponse=true`で開発→通話後解析→8kHz感度のPoC実測→リアルタイム化判断）

## 新リポジトリの初期issue一覧（起票用）

1. リポジトリ初期化: フォーク、プロンプトをAI顧客役へ差し替え、不要機能（handoff等）の無効化
2. GCPプロジェクト構築: API有効化、Secret Manager、Firestore、Cloud Runデプロイ
3. 着信受口: DTMFゲートウェイからの `<Redirect>` を受けるTwiML + 練習セッション開始
4. 同意フロー: 練習開始前の録音・外部送信同意（`consentObtainedFromDataSubject` と整合）
5. 録音/tee: Twilio inboundトラックのWAV録音（話者分離）
6. 話速・間の評価: turnsからの算出とスコア化
7. LLM内容評価: 評価ルーブリックjson_schemaと通話後採点
8. Emotion Logic通話後解析: `analyzeFile` 連携（`dummyResponse` で開発→実解析）
9. 8kHz感度PoC: 電話音声 vs 広帯域録音の実測比較（要件定義書10.5）
10. 評価統合レポート: 3系統統合スコア+根拠提示、フィードバック画面
11. 1通話原価の実測: Realtime累積トークン+Emotion Logic単価（要件定義書11章の更新）
12. μ-law→PCM変換とEMLO Dockerリアルタイム解析の検証（本番方式の判断、ADR化）

## プライバシー要件（受付システムより厳格）

- 練習者音声の録音と外部送信（Emotion Logicクラウド利用時）が発生するため、同意取得フロー・RHSとのDPA・保持期間/削除ポリシーが必須（要件定義書13章）
- EMLO Docker（セルフホスト）なら音声を自社インフラ内で処理でき、第三者提供の論点を軽減できる。PoC後の本番方式判断で考慮する
- テナント間データ分離（`tenantId` 必須クエリ）をスキーマ段階から設計する
