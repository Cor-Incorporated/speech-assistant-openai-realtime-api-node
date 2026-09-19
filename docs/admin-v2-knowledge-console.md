# Admin v2 / Cor.知識DBコンソール 実装状況

2026-09-19 時点。`fix/reception-audit` ブランチ（worktree `.worktrees/devin/reception-modernization`）。

## アーキテクチャ

```
Twilio ──> index.js ──> Live/Realtime provider
              │                ▲ lookup_company_knowledge（読取専用tool）
              │                └─ lib/knowledge-tool-runtime.js ──> KnowledgeReader
              │                                                  （現行releaseのみ・whitelist済み）
              ├─ /api/admin/*          既存v1（call log + runtime settings）
              └─ /api/admin/v2/*       lib/admin-v2-routes.js
                     ├─ CallService     src/calls/（manual作成・訂正・soft delete・If-Match）
                     ├─ EscalationService src/escalations/（通知≠受諾、subject紐付けACK）
                     └─ KnowledgeService src/knowledge/（draft→review→approve→release→withdraw）

永続化: named Firestore DB（CALL_LOG_FIRESTORE_DATABASE_ID）
  corKnowledge*, corKnowledgeSources, corKnowledgeReleases,
  corKnowledgeReviews, receptionPolicies, runtimeSettings/knowledge,
  callLogsV2, escalationCases, adminAuditEvents, adminIdempotency
CALL_LOG_FIRESTORE_ENABLED=false では全repoがin-memoryに退避（dev用）。
```

## 認証・権限

- Basic認証（`ADMIN_BASIC_*`）→ `ADMIN_V2_SUBJECT_MAP` JSON で subject/roles/sharedAccount を導出
- 未登録ユーザーは `viewer` + `sharedAccount`（最小権限: 承認/公開/削除/ACK不可）
- 書き込みは Origin/Referer の same-origin 検査 + JSON content-type 必須（CSRF対策）
- `If-Match`（ETag `*-vN`）による楽観ロック: PATCH/DELETE/publishで必須
- `Idempotency-Key` によるPOST /calls冪等化
- 監査: `adminAuditEvents` に actor/action/target/result（顧客本文は記録しない）

## 検証済み（2026-09-19）

| 区分 | 内容 | 結果 |
|---|---|---|
| ユニット | knowledge-service 18件 / call-service 11件 / classification-fixes / stream-auth / tool-flow | PASS |
| API結合 | admin-v2-routes 9件（認証・権限・If-Match・冪等・CSRF・エスカレーションACK） | PASS |
| 音声tool | knowledge-tool-runtime 5件（公開のみ応答・draft/admin_only/operatorNote非漏洩） | PASS |
| 実サーバー | `node index.js`起動→status/knowledge作成→承認→release→preview→escalation ACK→手動call作成→If-Match 428 | PASS |
| Firestore emulator | seed import 172件→再import全skip→衝突exit1→全draft維持・runtimeSettings/callLogs無変更 | PASS（前段） |
| フル | `npm test` 273/273 | PASS |

## 未検証・保留

- Playwright UI E2E（画面は実装済み・ブラウザ操作検証は未実施）
- 実電話でのknowledge tool呼出（実API `session.tools`への広告は配線済み）
- 本番Firestoreでの動作（named DBへの書込は未承認・emulatorのみ検証）
- push/PR/merge/deploy: 明示承認待ち

## 運用メモ

- 公開releaseの取り消しは `POST /knowledge/:id/withdraw`（runtime設定で即時失効、release manifestは不変）
- エスカレーション「通知を記録」は送信記録のみ。受諾は別途本人ACK操作
- 手動通話レコードは外部通知・Twilio呼出を一切伴わない
- `.env` に `ADMIN_V2_SUBJECT_MAP` を設定しないと全ユーザー viewer+sharedAccount になり書き込み不可（fail-closed意図）
