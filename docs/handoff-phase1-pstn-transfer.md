# 人間引き継ぎ第一弾 設計: 携帯PSTN転送 + Whisper

対応ADR: [ADR-0006](./adr/0006-handoff-phase1-pstn-transfer.md) ／ 対応Wave: C1（転送）、C2（Whisper）、C3（不応答フォールバック）

## ゴール

AIが対応困難と判断した通話を、担当者の携帯電話へ転送する。担当者は文脈（AI要約）を聞いてから応答でき、誰も出られない場合は折り返しフローへ確実に落ちる。

## シーケンス

```text
発信者 ── 050番号 ── AI受付(Realtime)
                        │ AIがtool `transfer_to_human` を発火（またはユーザーが人間対応を要求）
                        ▼
            backend: ライブコールを転送TwiMLへリダイレクト
            (Twilio REST API POST /Calls/{CallSid} で TwiML差し替え)
                        │
                        ▼
            <Dial callerId="050番号" timeout=20 action="/handoff/dial-status">
              <Number url="/handoff/whisper" statusCallback="/handoff/leg-status">担当者A</Number>
              <Number url="/handoff/whisper" ...>担当者B</Number>   ← 最大10番号同時呼、先に出た人に接続
            </Dial>
                        │
          ┌─────────────┴──────────────┐
          ▼ 担当者が応答                 ▼ 全員不応答/話中 (DialCallStatus != completed)
   /handoff/whisper:                  /handoff/dial-status:
   <Say>AIからの引き継ぎです。         <Say>担当者が不在です。折り返しご連絡
   ○○のご用件、△△様…</Say>           いたします</Say> → callLogsへ折り返し登録
   <Gather numDigits=1>1で接続</Gather>  → Resendで担当者へメール通知(Wave D1)
     │ 1押下 → ブリッジ成立              → <Hangup>
     │ 押下なし/切断 → その番号は不成立
```

## 新規エンドポイント

| エンドポイント | 役割 | 認証 |
|---|---|---|
| `POST /handoff/whisper` | 転送先応答直後に実行されるTwiML（要約`<Say>`+`<Gather>`受諾） | Twilio署名検証 |
| `POST /handoff/whisper-confirm` | `<Gather>` のaction。1押下でブリッジ継続、その他で`<Hangup>` | Twilio署名検証 |
| `POST /handoff/dial-status` | `<Dial>` のaction。DialCallStatusで成立/不成立を判定しフォールバック | Twilio署名検証 |
| `POST /handoff/leg-status` | `<Number>` のstatusCallback。各レッグの監査ログ用 | Twilio署名検証 |

既存の `validateTwilioSignature`（`lib/security.js`）を全エンドポイントに適用する。署名検証はURL完全一致前提のため、各エンドポイントの公開URLを署名検証設定に含めること。

## AI側トリガー（issue #15 対応）

- Realtimeセッションに tool `transfer_to_human` を追加する（既存の `finish_reception` toolフロー＝`lib/realtime-tool-flow.js` のパターンを踏襲）。
- 発火条件（プロンプトで指示）: 発信者が人間対応を明示要求／AIが2回聞き返しても用件を確定できない／クレーム等の高感情ケース。
- tool発火時、backendは (1) AIに「担当者へおつなぎします」と発話させ、(2) Twilio REST APIでライブコールを転送TwiMLへリダイレクトし、(3) OpenAI Realtimeセッションを終了する。
- 要約生成: `session.turns` から Whisper読み上げ用の短い要約（用件・発信者名・折り返し番号）を生成する。既存の抽出（`extractCallDetails`）を同期的に待つとレイテンシが大きいため、転送開始時点のturnsから軽量に生成する方式を実装時に選定する。

## 環境変数（案）

| 変数 | 既定 | 説明 |
|---|---|---|
| `HANDOFF_ENABLED` | `false` | 機能フラグ。falseなら tool自体をセッションに追加しない |
| `HANDOFF_NUMBERS` | （空） | `{"contract":"+81...","general":"+81..."}` のJSON。受託案件とその他の人間対応を用途別に1番号へ転送する。旧カンマ区切りも互換維持。**実番号はSecret/環境変数のみで管理し、リポジトリ・docに書かない** |
| `HANDOFF_DIAL_TIMEOUT_S` | `20` | 呼び出しタイムアウト（秒） |
| `HANDOFF_WHISPER_ACCEPT_DIGIT` | `1` | 受諾キー |
| `HANDOFF_WHISPER_REJECT_DIGIT` | `2` | コールセンターへ差し戻すキー |
| `HANDOFF_CALLER_ID` | （空） | `<Dial callerId>`。通常は自番号（050） |

## 監査ログ

既存の監査ログ形式（actor/action/target/timestamp）で以下を記録する: 転送開始（callSid、転送先は末尾4桁マスク）、whisper受諾/拒否、ブリッジ成立、不応答フォールバック実行。転送先電話番号は本番ログでマスクする（既存 `maskPhone` 方針）。

## コスト目安

日本の携帯への発信は約$0.185/分。転送中は着信+発信の両レッグ課金で概算約29円/分（$1=150円換算、為替は要確認）。固定電話へは約13円/分。

## テスト方針

- `node --test`: TwiML生成（Dial/Number/whisper/Gather）、DialCallStatus分岐、番号マスクのユニットテスト
- `transfer_to_human` は `destination=contract`（受託案件）または `destination=general`（その他の人間対応）を受け、該当する1番号だけを `<Dial>` する。採用・営業・一般案内はAI受付後に通知するため自動転送しない。
- 手動: 実050番号→AI→tool発火→検証用携帯への転送、で通し確認（結果をPR本文へ記録）
- 反証テスト: `HANDOFF_ENABLED=false` で転送toolがセッションに含まれないこと

## 第二弾（将来）

同時多数着信・モニタリング・ささやき指導が必要になった段階で、[ADR-0002](./adr/0002-operator-console-human-handoff.md) のオペレーターコンソール+Conference構成に進む。Conference型warm transferはTwilio公式参照実装 https://github.com/mhughan-twilio/openai-programmable-sip を採用候補とする。

## 参考

- `<Dial>`/`<Number>`（url属性=whisper、同時呼び出し）: https://www.twilio.com/docs/voice/twiml/number
- ライブコールのTwiML差し替え: https://www.twilio.com/docs/voice/api/call-resource#update-a-call-resource
- Twilio日本料金: https://www.twilio.com/en-us/voice/pricing/jp
