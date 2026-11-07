# 通知・担当期限・Knowledge削除の更新契約

管理v2の通知操作は既存NotificationOutboxへ送信を依頼し、プロバイダーの`accepted`を確認してから`notifiedAt`を記録する。
送信キーは`kind=escalation-request:<案件ID>`と元の通話IDの組で固定し、同一案件の再試行・並行操作を重複排除する。通話IDがない手動案件では案件IDを使う。
同一通話に複数の案件があれば別の通知キーとなる。元の`CA_SMOKE`通話IDをOutboxへ渡すため、既存のテスト通話の送信抑止も維持する。

| 通知結果 | HTTP | 操作側の扱い |
|---|---|---|
| accepted | 200 | 送信受付済み。担当者本人の受諾は別操作 |
| not_required | 200 | 既に受諾・接続・解決済みで送信していない |
| sending | 202 | 送信処理中。受付済みと表示しない |
| disabled・設定不足・outbox障害 | 503 | 設定・状態を確認して再試行 |
| その他の送信失敗 | 502 | 同一案件を再試行 |

応答の`note`に各結果を説明する。失敗時に通知済みの時刻を作らず、送信中のACK・接続・解決・不在状態を後着の通知結果で戻さない。

担当ロールは`operator`または`supervisor`、担当者IDは1〜200文字。`null`で解除できる。
期限は実在するUTC ISO日時、または`null`。`GET /api/admin/v2/escalations?overdue=true`と詳細の`ackOverdue`で、期限を過ぎた未受諾案件を判定する。
期限判定は一覧取得時の計算であり、自動メールや定期ジョブは起動しない。担当変更には既存の`If-Match: "esc-vN"`が必要。
KnowledgeのDELETEも`If-Match`の版を保存層へ渡し、他者更新後の古い画面からの削除を412で拒否する。

受入は`test/operations-contract.test.js`で検査する。実Fastify・実Service・Outboxを用い、メール送信先はローカルstub。
外部メール到達、実Firestoreでの並行実行は未検証。500件超の一覧継続取得は別のページング修正と統合して検証する。
