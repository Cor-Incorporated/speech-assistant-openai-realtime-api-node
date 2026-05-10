# Historical Record: 開発履歴の記録

このリポジトリは Cor.株式会社代表取締役・寺田康佑が管理する、Twilio Voice Media Streams と OpenAI Realtime API を組み合わせた音声アシスタント実装です。

## リポジトリ起源

- 初期コミット: 2024-10-14 (`1a4a248`)
- 第2コミット: 2024-10-28 (`c0eb3af`)
- 著者: 寺田康佑 (Cor.株式会社代表取締役)
- ベース実装: Twilio公式サンプル `twilio-samples/speech-assistant-openai-realtime-api-node` (MIT License, Copyright (c) 2024 Twilio Inc.) からの派生
- 利用先 API: OpenAI Realtime API (WebSocket経由で音声応答を取得)、Twilio Voice / Media Streams (電話回線とメディアストリーム)
- 公開リポジトリ: https://github.com/Cor-Incorporated/speech-assistant-openai-realtime-api-node
- 公開ライセンス: MIT License (LICENSE参照、ベース実装の Twilio Inc. 表示と Cor Inc. 表示を保持)
- リポジトリ可視性: Public (誰でも閲覧可能)
- stars: 3 (2026-05-10 取得時点)

## 開発期間と境界線

### 公開開始と Cor.管理下の変更 (2024-10-14 〜 2026-04-07)

初期コミットは Twilio 公式サンプルを基盤にした派生実装です。この期間の変更は、Cor.株式会社/寺田康佑による公開リポジトリ上の適用・変更として管理されてきました。

該当コミット:
- `1a4a248` 2024-10-14 first commit
- `c0eb3af` 2024-10-28 for trial

### 2026-04-08 以降

2026-04-08を内部の境界確認日として扱い、それ以降の変更でも本リポジトリのコード・ドキュメントには **特定顧客の固有名詞・運用フロー・業務知識を含めない** 方針を取っています。

デプロイ先ごとのシステムプロンプト、運用識別子、顧客固有設定は、本リポジトリには置かず、環境変数や非公開の管理場所で分離する設計です。

境界日の補助証跡:

- 2026-04-08 18:57 の連絡記録に、koido氏から「AI電話依頼します！」という依頼開始発言が残っています。
- 2026-04-08 のMTG議事録 (`2026-04-08_MTG.pdf`, local evidence archive) には、問い合わせが増えているAI電話システムの本格開発に関心を示した古井戸氏が、寺田氏に過去に試作した経験があるか尋ね、寺田氏が「過去にAI電話システムを開発したが、現在はコスト削減のため停止しており、調整すればすぐに再稼働できる」と回答した旨が記録されています。

この議事録により、本リポジトリに相当するAI電話システムの試作・基盤が、2026-04-08の依頼開始以前から寺田氏/Cor.株式会社側の既存開発として存在していたことを補助的に立証できます。なお、本公開リポジトリには議事録本文、契約情報、金額、顧客固有業務情報、実secretは含めません。

該当コミット (本リポジトリに残る Cor.管理下の汎用変更):
- 2026-04-26: モダナイゼーション計画ドキュメント追加 (`d7ecdbf`, `fc1bc91`, `5fb2989`, `77ae1f1`)
- 2026-04-26: Wave 1 ローカル起動ベースライン整備 (`2566086`)
- 2026-04-26: Cloud Run デプロイ基盤 (`58896b6`)
- 2026-04-26: 日本語コール一次受付プロンプトの環境変数化 (`4c6860f`)
- 2026-04-26: Firestore + Sheets 通話ログ基盤 (`dbb3be4`, `01366c9`)
- 2026-04-26: Wave 1 完了後の実装計画更新 (`b7eeb7a`)
- 2026-04-26: Twilio webhook署名検証 + プライバシーログ無効化 (`5c56f6a`)

これらは公開リポジトリで扱うため、顧客固有情報を入れない前提の汎用機能として管理しています。

## 公開リポジトリの管理方針

### 2026-04-08 以前のコード

- 本リポジトリは2026-04-08以前から Cor.株式会社の GitHub Organization (Cor-Incorporated) 配下で **Public・MITライセンスとして公開** されていました。

### 2026-04-08 以降のコード

- 本リポジトリに残る2026-04-08以降のコミットは、公開リポジトリで扱える汎用機能として管理します。
- 顧客固有のカスタマイズ部分は本リポジトリに含めません。

## ベース実装

本リポジトリは Twilio公式サンプル `twilio-samples/speech-assistant-openai-realtime-api-node` (MIT License, Copyright (c) 2024 Twilio Inc.) を基盤とした派生実装です。OpenAI Realtime API は本実装の利用先 API として WebSocket 経由で呼び出します。詳細は [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) を参照してください。

## 著作権

- 本リポジトリの Cor.追加実装部分: Cor.株式会社 (代表取締役 寺田康佑)
- ベース実装部分: Twilio Inc. (MIT License、LICENSE 参照)
- 使用OSSの著作権: 各OSSの著作権者 ([THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) 参照)

## ライセンス

MIT License (LICENSE参照)
