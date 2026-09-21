# 音声プロバイダ・ルーティング ロールバック手順

- 対象: ADR 0009 で導入した voice port / Live adapter / Jev classifier / ActionGate・Ledger、および Media Streams認証・知識DB音声経路
- **現行本番状態（2026-09-20時点）**: `VOICE_PROVIDER=live`、`ROUTING_PROVIDER=jev_shadow`、`TWILIO_STREAM_AUTH_ENABLED=true`、知識DB release公開済み。いずれも有効化済みのため、切り戻しは明示的な手順が必要。

## 即時切り戻し（GitHub Variables変更 + workflow_dispatch再デプロイ）

環境変数は `deploy-cloud-run.yml` の `--set-env-vars` で全量管理されるため、`gcloud run services update` での直接変更は**次回デプロイで消える**。切り戻しはGitHub Variable変更 → `Actions → Deploy Cloud Run → Run workflow` で行う。

| 設定 | 現在値 | 切り戻し値 | 影響 |
|---|---|---|---|
| `VOICE_PROVIDER` | `live` | `realtime` | 従来Realtime経路へ即時復帰 |
| `TWILIO_STREAM_AUTH_ENABLED` | `true` | `false` | トークン検証を停止（開発用・本番では非推奨） |
| `LIVE_FALLBACK_TO_REALTIME` | `true` | `false` | Live起動失敗時のRealtime自動復帰を止める |

※ `LIVE_TOOL_WATCHDOG_MS` はワークフロー未配線のため既定10秒が適用される。変更する場合は `deploy-cloud-run.yml` の `env:` と `--set-env-vars` の両方へ追加してから変数を設定する（コード側に既定値あり、未設定でも安全）。

Jevはshadow専用のため、分類が誤っても電話動作に影響しない。Jev自体を止めたい場合のみ `JEV_CLASSIFIER_ENABLED=false`（変数未配線ならworkflowへ追加が必要）。

## コードレベルの切り戻し

分岐が `index.js` / `lib/` に配線された後で障害が出た場合:

1. provider選択: `new RealtimeAdapter(...)` のみ残し、`LiveAdapter` への分岐を外す。Liveの`start()`は成功を返さない構造のため、分岐除去だけでRealtime経路に確実に戻る。
2. classifier選択: `RoutingCoordinator` を `LegacyRulesClassifier` 単独構成に戻す（Jevを外すだけで現行regexのみの挙動に一致）。
3. ActionGate/Ledger: ゲートを通さない直接呼出しに戻すのは**非推奨**。副作用の二重実行・stale実行が復活する。どうしても外す場合は「確認済み・現行revision・初回実行」の3条件を呼出し側で残す。

## 確認手順

```bash
npm run build:backend && npm test
node scripts/eval-synthetic.js   # 分類面の回帰差分を確認
```

## 復旧後の確認項目

- Twilio `mark`/`clear` 挙動が `PlaybackController` 前提でないことを確認（legacy経路はmarkを直接監視）
- `outcome_unknown` のledger残存があれば、実世界と照合して `reconcile` で終了させてから経路を戻す
- 本番台帳（Firestore等）に `prepared`/`running` で残ったレコードがあれば孤児として調査対象にする

## やってはいけない

- `outcome_unknown` のまま同じ `actionId` を別経路で再実行（二重副作用）
- Jev/Liveを「暫定」として無検証のまま本番ONにする
- rollbackを理由に `.env`/シークレットをコード・PRに書く
