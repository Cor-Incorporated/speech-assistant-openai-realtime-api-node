# ADR 0009: 音声プロバイダ・ルーティング分離とTypeScript段階移行

- ステータス: 採用（実装完了、本番未適用）
- 日付: 2026-09-18
- 対象: 受付システムの音声プロバイダ抽象化、分類/転送権限/副作用の責務分離、バックエンドのTypeScript段階移行

## 背景

現行 `index.js` は動作しているが、次の責務が単一モジュールに混在している。

- Realtime wireプロトコルの解釈（`response.done`、function_call引数）
- 用件分類（regex判定）と転送可否の業務判断
- Twilio `mark`/`clear` に基づく再生状態管理
- 副作用（転送・終話・通知）の実行とべき等性

また、将来のプロバイダ選択肢（GPT-Live）と分類基盤（Jev）の導入検討があるが、現構成では「Realtimeのイベント名・完了セマンティクスを全プロバイダが共有する」という暗黙前提に依存してしまう。

## 決定

### 1. `VoiceSessionPort` をアプリ側の音声ポートとする

- `src/contracts/voice-events.ts` にプロバイダ非依存のイベント語彙を定義（`assistant_turn_completed` は「生成完了」であり「発話が相手に届いた」意味を持たない）。
- `RealtimeAdapter`（互換・既定）と `LiveAdapter`（`VOICE_PROVIDER=live` 指定時のみ選択・既定無効）を実装。LiveはRealtimeのイベント名・完了イベントを仮定せず、wire名を `LIVE_EVENTS` 定数として分離。
- Liveの実API未検証のため、adapterは設定検証と構造化 `unavailable` 応答のみを行い、接続を偽装しない。サイレント再接続も行わない。

### 2. 分類と転送権限を分離する

- `RoutingDecision`（intent/risk/signals/revision）は分類層の出力であり、それ自体は権限を持たない。
- `evaluateTransferRequest` が policy flags・risk flags・宛先を評価して許可/拒否理由を返す。分類が `uncertain` なら権限ゼロ。
- `JevClassifier` は無効既定・shadow用。deadline・マスキング・レスポンス検証をadapter内に持ち、timeout/429/不正値は `uncertain` に変換して音声経路を塞がない。

### 3. 副作用は `ActionGate` + `ActionLedger` の2層で管理する

- Gate: schema検証→種別/宛先allowlist→policy→確認→ライフサイクル→revision鮮度の順で同期評価。
- Ledger: 業務べき等キー（providerイベントIDではない）で `insertIfAbsent` クレーム。`outcome_unknown` は実世界との照合なしに再試行しない。
- 古い `contextRevision` の非同期結果・二重イベントからは副作用を実行しない。

### 4. TypeScriptは段階移行とする

- `tsconfig.backend.json`（strict）で `src/` → `dist-backend/` を別ツリーに出力。`index.js`/`lib/` のESMはそのまま維持し、新規・分離済みロジックからTS化する。
- 全面書き換え・Python/Go移行・本番モデル名だけの差替えは行わない。

## 理由

- Twilio `clear` 後のmarkを再生済み扱いしない、`"false"` 文字列を真にしない、未知宛先を `general` に正規化しない、といった具体的障害は全て「層の混在」が原因であり、境界の明示が最も安い対策。
- Live/Jevの実APIは未検証。ポートで隔離しておけば、実測後に実装を差し替えても呼び出し側（音声ループ・policy）を変更せずに済む。
- 現行regex分類を `LegacyRulesClassifier` として残すことで、Jev shadow比較の基準線とrollback先を同一コードで提供できる。

## 影響

- `npm run build:backend` が新規に必要（`npm test` 経路に組込済み）。
- 本番挙動は現時点で変更しない（adapter層は新規追加、既存 `lib/` は `handoff.js` の分類パターンexport追加のみ）。
