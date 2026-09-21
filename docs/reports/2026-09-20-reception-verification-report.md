# AI電話受付システム — 実装・実機検証レポート

**作成日**: 2026-09-20
**対象**: レビュアー・テスター
**環境**: 本番 Cloud Run `speech-assistant-realtime`（`asia-northeast1`、GCP `cor-jp-web`）

---

## 1. サマリ

受付システムの監査修正（F01–F12）、知識DB、admin v2管理コンソールを本番デプロイ済み。
実電話テストで**2件の本番固有障害**を発見し、いずれも修正・デプロイ・再検証済み。

| 項目 | 状態 |
|---|---|
| 本番リビジョン | `speech-assistant-realtime-00031` 系（PR #95マージのデプロイ） |
| テスト | `npm test` 280/280 PASS・Playwright E2E 5/5 PASS |
| 実電話検証 | S-01のtool往復を実API・実WS接続で検証済み（発見した障害2件は修正済み） |
| 知識DB | release `rel_20260919004348_9b492cc4` 公開中（52件・admin_only 6件は除外済み） |

## 2. デプロイ済み変更（PR一覧）

| PR | 内容 |
|---|---|
| #92 | 受付監査 F01–F12 修正、知識DBドメイン、admin v2 API/Reactコンソール、Playwright E2E |
| #93 | デプロイ配線: `TWILIO_STREAM_AUTH_ENABLED`・`ADMIN_V2_SUBJECT_MAP` |
| #94 | stream token輸送経路の修正（実障害1） |
| #95 | Live tool出力未送信による86秒無音の修正 + watchdog追加（実障害2） |

## 3. 実機検証で発見した障害と修正

### 障害1: 着信直後に即切断（修正済み・PR #94）

**症状**: 電話をかけると音声なしで即切断。

**ログ時系列**（2026-09-19 01:47 JST）:

```
twilio.webhook.accepted → twilio.gateway.routed →
WS upgrade 101 requestUrl=/media-stream（クエリ文字列が無い）→
media_stream.rejected reason=missing_stream_token → 切断
```

**根因**: Twilioは`<Connect><Stream url>`のクエリパラメータをWS接続時に送信しない。
TwiMLには`?token=`を埋め込んでいたが届かず、認証必須のサーバが4408で拒否した。

**修正**: トークンをURLパス（`wss://host/media-stream/<token>` — パスは除去されない）に
埋込み + `<Parameter name="stream_token">`（`start.customParameters`経由で到達）を併記。
サーバはパス/クエリ/Parameterの3経路で検証。あわせて Fastify `maxParamLength`
（既定100文字）が133文字のトークンを404にしていた第2障害も修正（512へ）。

### 障害2: 応答途中で86秒無音（修正済み・PR #95）

**症状**: 「営業時間を調べます」と言った後、86秒間完全な無音。発信者が切断。

**ログ時系列**:

```
live.delegation.created（バックエンド委譲）
knowledge.lookup result=found（検索は1.2秒で成功）
GPT-Live error: "Submit the pending function call outputs before response.create."
live.session.close_incomplete drain_timeout
```

**根因**: `executeKnowledgeCall`は裸の`function_call_output` itemを返すが、
`toLiveToolResultItem`が`conversation.item.create`エンベロープしか展開せず
**裸itemをnullで捨てていた**。tool結果が一度もプロバイダに届かず、
pending callを抱えたままの`response.create`が永久に拒否されモデルが待機した。

**修正**:

1. `toLiveToolResultItem`が両shapeを受理するよう修正（根本原因）
2. `LIVE_TOOL_WATCHDOG_MS`（既定10秒）watchdogを追加 — tool出力後の応答が無ければ
   stage1でstalled delegationへフォールバック指示+再試行、stage2で終話ワークフローへ。
   **二度と無制限の無音は起きない**
3. フィラー明文化 — 「委譲中は無音で待たせず短い相づちを先に伝える」をinstructionsへ追加

## 4. テスト不備の修正（再発防止）

実障害を検出できなかったテスト側の欠陥も修正:

- **ProviderStubが実プロバイダのpending-output契約をエミュレート** —
  未解決callがある状態での`response.create`はerrorイベントを返却するように
- **結合テスト追加** — delegation注入→`function_call_output`が`response.create`より
  先に届くこと・error不在を実WS接続で検証（`test/media-stream.integration.test.js`）
- **verify-live.js** — PASS条件を「tool出力後のcontinuation activity必須+error非許容」へ
  強化（旧条件はaudioDeltaのみで本障害を見逃していた）

## 5. レビュアーへの確認依頼

### 重点確認箇所

| ファイル | 確認点 |
|---|---|
| `lib/stream-auth.js` | HMAC検証・CallSid紐付け・期限切れ・fail-closedの境界 |
| `lib/twiml.js` | 3経路のトークン埋込み（パス/Parameter）、XMLエスケープ |
| `index.js` `/media-stream`周辺 | 遅延認証の境界（missingのみ遅延、invalidは即拒否）、非startフレーム拒否、認証タイムアウト |
| `index.js` `armToolWatchdog` | watchdogのarm/disarmタイミング、stage1/2の遷移、caller切断時の解除 |
| `lib/live-session.js` `toLiveToolResultItem` | 両shape受理の回帰修正 |
| `lib/knowledge-tool-runtime.js` | 音声経路は公開releaseのwhitelist項目のみ・`query`引数のみ・`admin_only`除外 |
| `lib/admin-v2-routes.js` | If-Match競合・Origin検査・roles・PII投影 |
| `src/knowledge/knowledge-service.ts` | draft→in_review→approved→published遷移、hash紐付け承認 |

### 設計上の判断ポイント（レビュー対象）

1. **遅延認証**: `<Parameter>`経路は`start`フレームまで待つため、認証完了前にprovider
   socketが作られる時間窓がある。invalidトークンはupgrade時点で即拒否するが、
   missing+Parameter経路の設計が妥当か確認いただきたい
2. **watchdogの回復手段**: `session.instructions.append`は`delegation_id`+`content`必須
   （実APIで確認）。stalled delegationにscoped appendする設計
3. **知識DBのrelease重複**: 並行実行により同一内容のreleaseが2件残っている
   （`..._3fa4cf72`と`..._9b492cc4`、52件完全同一で`currentReleaseId`は`9b492cc4`を指す。
   無害だが監査上の残件として報告）
4. **Jevはshadow専用**: 分類結果は記録のみで電話動作に一切関与しない設計を維持

### セキュリティ境界

- `TWILIO_STREAM_AUTH_ENABLED=true`時に`TWILIO_AUTH_TOKEN`未設定 → fail-closed
- draft/admin_only/撤回済み知識 → 音声応答に一切出ない（負例テスト済み）
- 人間転送 → 「人間の受諾証跡（whisper `1`）」必須、モデル分類だけでは転送しない
- escalation通知 ≠ 受諾（別操作・subject紐付け）
- `.env`/APIキー/電話番号はリポジトリへコミットしない

## 6. テスターへの依頼

### 配布資料

- **シナリオ**: `ai-reception-scenario-test-2026-09-18.md`（デスクトップ配布 —
  転送先の実番号・タイミング基準・全シナリオS-01〜S-14+A-01〜A-05を記載）
- **本レポート**（リポジトリ `docs/reports/`）

### 発信前の確認

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://speech-assistant-realtime-qvghygsdwq-an.a.run.app/   # → 200
```

### 重要な判定基準

- **無音は25秒を上限とする** — それを超えたらバグ報告（watchdogは10秒で動作するはず）
- S-02/S-07の転送は**実番号が鳴る**（配布資料の番号表を参照）— 受け手を用意してから実施
- Jevログの`jev_shadow`エントリは記録のみ — 電話動作への影響は仕様外ではない

### 障害報告に含めるもの

- 発生時刻（JST）、何を話したか、何秒無音か/何が起きたか
- 可能なら通話のCallSid（`CA...`で始まるID — ログ検索のキー）

## 7. 既知の制約・未実施事項

| 項目 | 状態 |
|---|---|
| 実電話での転送（S-02/S-07） | **未実施** — 実番号が鳴るため受け手用意後に実施 |
| 実電話での全シナリオ通し | S-01のみ実施（障害発見・修正済み）。S-02以降はテスター依頼中 |
| 知識DB | 公開済み52件のみ応答に使用。残りseedはdraft（公開はadmin v2の承認フロー経由） |
| Playwright E2E | in-memory repo使用のため`workers:1`・専用ポート。本番Firestoreは使わない |
| Live tool遅延認証 | 上記「設計上の判断ポイント」参照 |
| 性能数値 | 実測ベースのみ記載。負荷・同時通話数の性能検証は未実施 |

## 8. ロールバック

詳細は `docs/runbooks/voice-provider-rollback.md`。

即時切り戻し（GitHub Variable変更 + Deploy Cloud Runのworkflow_dispatch）:

```bash
# Live障害時: Realtimeへ復帰
gh variable set VOICE_PROVIDER --body realtime
# → Actions → Deploy Cloud Run → Run workflow (develop)

# stream auth障害時（緊急のみ・認証が外れる）
gh variable set TWILIO_STREAM_AUTH_ENABLED --body false
```

`gcloud run services update`での直接変更は次回デプロイで消えるため使わない。

## 9. 監視クエリ（Cloud Logging）

```bash
# 認証拒否・tool停滞・watchdog発動の監視
gcloud logging read "resource.labels.service_name=speech-assistant-realtime" \
  --project cor-jp-web --freshness=1h --format=json | \
  grep -i "media_stream.rejected\|tool_response\|close_incomplete\|jev_shadow"
```

注目audit action: `media_stream.rejected`、`live.tool_response.stalled/failed`、
`live.session.close_incomplete`、`knowledge.lookup`、`handoff.*`、`jev_shadow`。
