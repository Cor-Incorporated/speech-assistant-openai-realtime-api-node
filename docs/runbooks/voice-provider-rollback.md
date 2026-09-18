# 音声プロバイダ・ルーティング ロールバック手順

- 対象: ADR 0009 で導入した voice port / Live adapter / Jev classifier / ActionGate・Ledger
- 原則: 新レイヤーは全て**無効既定**。本番挙動を変えた場合のみ以下を実施。

## 即時切り戻し（環境変数のみ・デプロイ不要の範囲）

| 設定 | 既定 | 切り戻し値 |
|---|---|---|
| `VOICE_PROVIDER` | `realtime` | `realtime`（`live` 指定時のみ新経路） |
| `JEV_CLASSIFIER_ENABLED` | `false` | `false`（shadow含め無効化） |
| `JEV_SHADOW_ONLY` | `true` | `true` |

Live/Jevは既定で無効のため、**通常時は何もしない**のが正しい状態。

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
