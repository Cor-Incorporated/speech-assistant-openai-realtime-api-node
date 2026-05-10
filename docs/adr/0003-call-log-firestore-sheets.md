# ADR 0003: 通話ログの正本を専用Firestoreに保存し、Google Sheetsへ同期する

## ステータス

採用

## 背景

050番号の通話がCloud Runで受けられるようになったため、次は通話内容を運用担当者が確認できる状態にする必要があります。最終的にはBigQueryで分析しますが、初期段階では導入速度とGoogle環境内で閉じる運用を優先します。

既存プロジェクトには他システムのFirebase/Firestoreが存在するため、default databaseには混在させません。

## 決定

- 通話ログの正本は専用Firestore named database `your-firestore-database-id` に保存する。
- コレクション名は `callLogs` とする。
- Google Sheetsは運用ビューとして使い、通話終了時に1行追記する。
- 対象スプレッドシートは `your-spreadsheet-id` とする。
- 通話要約はOpenAI Responses APIのStructured Outputsで抽出する。
- Sheets書き込み失敗は通話を失敗扱いにせず、Cloud Runログへ記録する。

## 理由

Firestoreを正本にすると、後続のReact管理画面、再送、監査、BigQuery移行で扱いやすいです。Sheetsを正本にすると、手編集や形式崩れでデータの信頼性が落ちます。

## 影響

- Cloud Run実行サービスアカウントにはFirestore書き込み権限とSheets編集権限が必要です。
- Sheets APIを有効化します。
- BigQuery移行時はFirestore `callLogs` からエクスポート、または通話終了時の二重書き込みに切り替えます。

