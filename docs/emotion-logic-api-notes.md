# Emotion Logic API 仕様メモ（練習システム引き継ぎ資料）

> **秘匿情報の扱い**: APIキー・パスワードの実値は**いかなるファイル・issue・チャットにも記載しない**。Secret Manager（`emotion-logic-api-key` / `emotion-logic-api-key-password`、練習システム用GCPプロジェクトに配置想定）で管理する。
>
> 本docは本リポジトリでは**使用しない**引き継ぎ資料である（[ADR-0008](./adr/0008-practice-system-separation-dtmf-gateway.md): 感情解析は練習システム＝別リポジトリの責務）。新リポジトリ立ち上げ時にコピーする（[practice-system-handover.md](./practice-system-handover.md)）。

## 概要

- **Emotion Logic**: Nemesysco社のLVA（Layered Voice Analysis）技術ベースの音声感情解析プラットフォーム。声の非言語特徴からストレス・感情パラメータを数値化する。
- **契約経路**: Rabbit Hole Solutions株式会社（RHS）経由。同社の提供名称は「ALICe」。**NDA締結済み、APIキー/パスワード発行済み（2026-04-28、RHS高橋氏からのメール）**。
- 公式ドキュメント: https://app.emotionlogic.ai/documentation （旧URL emlo.cloud/documentation はリダイレクト）
- **未確定事項**: 従量単価（RHS高橋氏へ確認する。Wave E2のチェックリスト項目）

## 提供形態（2系統）

| 形態 | エンドポイント | 用途 |
|---|---|---|
| ① クラウド直リクエスト | `https://cloud.emlo.cloud/analysis/...` | 通話後ファイル解析（PoC向き） |
| ② EMLO Docker（セルフホスト） | `http://[docker-ip]/analysis/...` | リアルタイムストリーミング解析＋ファイル解析。音声を自社インフラ内で処理できる |

Docker版のAPIキー/パスワードはインストール時のダッシュボードアクティベーションで使用する。

## ファイル解析API（通話後解析、PoCの本命）

### エンドポイント

- `POST /analysis/analyzeFile` — multipart/form-dataで音声ファイルを直接アップロード（**推奨**: 音声を公開URLに置く必要がない）
- `POST /analysis/analyzeFromURL` — JSONで音声ファイルのURLを渡す

### 主要パラメータ

| パラメータ | 必須 | 内容 |
|---|---|---|
| `file` / `url` | Yes | 解析対象音声 |
| `sensitivity` | Yes | `normal` / `high` / `low`（falseポジティブとのトレードオフ） |
| `outputType` | No | `json`（既定） / `text` |
| `dummyResponse` | No | `true` で**課金なしのダミー応答**（開発用。実装・テストで積極活用する） |
| `segments` | No | セグメント境界の配列 `[{channel, start, end, text}]`。**文字起こしturns（話者・時刻・本文）をそのまま渡せる**＝練習者発話単位の感情解析が可能 |
| `requestId` | No | 36文字までの相関ID |
| `backgroundNoise` | No | 背景ノイズ値（0=自動） |

### クラウド版のみの追加パラメータ

| パラメータ | 必須 | 内容 |
|---|---|---|
| `apiKey` / `apiKeyPassword` | Yes | 認証情報（Secret Managerから） |
| `consentObtainedFromDataSubject` | Yes | **`true` 必須**（被解析者の同意取得をAPIレベルで要求）→ 練習開始前の同意フロー設計と直結 |
| `useSpeechToText` | No | Emotion Logic側STT（追加課金）。本システムはgpt-4o-transcribeを持つため不要見込み |

## リアルタイム解析（本番のリアルタイム評価向け）

**EMLO Docker（セルフホスト）のみ**で提供。socket.io（WebSocket）ベース。

### イベントフロー

1. クライアント → Docker: `handshake`（音声メタデータ）
2. Docker → クライアント: `handshake-done`（成功でstreamId）
3. クライアント → Docker: `audio-stream`（音声バッファを逐次送信）
4. Docker → クライアント: `audio-analysis`（セグメント解析結果を随時push）
5. 通話終了時: `fetch-analysis-report` → `analysis-report-ready`（ファイル解析と同形式のレポート）

### handshakeパラメータ

| パラメータ | 必須 | 値 |
|---|---|---|
| `isPCM` | Yes | `true` 固定（**PCMのみ対応**） |
| `channels` | Yes | 1 or 2 |
| `backgroundNoise` | Yes | 標準 1000 |
| `bitRate` | Yes | 8 or 16 |
| `sampleRate` | Yes | **8000対応**（6000/8000/11025/16000/22050/44100/48000） |
| `outputType` | No | `json`（既定） |

### 電話音声との接続

- Twilio Media Streamsの音声は **G.711 μ-law・8kHz・base64フレーム**。
- Emotion LogicリアルタイムはPCM必須 → **μ-law→リニアPCM（16bit）変換**が必要。G.711 μ-lawのデコードは256エントリのテーブル参照で、Node.jsで軽量に実装できる。
- sampleRate 8000が公式サポートされているため、リサンプリングは不要。
- 評価対象は練習者の声のみ。Twilio Media Streamsの **inboundトラックのみ**をEmotion Logicへ送る（AI顧客役の声を混ぜない）。

## 品質上の注意（要件定義書との整合）

- 電話音声は8kHz狭帯域で高域が欠落する。LVA系解析の精度に上限がかかる可能性があるため、**PoCで実測検証する**（同一発話の電話8kHz vs 広帯域録音の比較、実力群の分離度確認）。
- 練習者音声の外部送信は個人情報の第三者提供に該当し得る。同意フロー（`consentObtainedFromDataSubject` と整合）とRHSとのDPA整理が必要。Docker版なら音声を自社インフラ内で処理できるため、プライバシー面で有利な選択肢になる。

## 参照

- リクエスト仕様（URL版）: https://app.emotionlogic.ai/documentation/audio-analysis-request-with-url
- リクエスト仕様（アップロード版）: https://app.emotionlogic.ai/documentation/analysis-request-upload-file
- リアルタイム解析: https://app.emotionlogic.ai/documentation/realtime-analysis
- Docker導入: https://app.emotionlogic.ai/documentation/docker_installation
- レスポンス例: https://app.emotionlogic.ai/documentation/api-response
