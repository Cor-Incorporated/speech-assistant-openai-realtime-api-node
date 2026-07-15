# ADR 0006: 人間引き継ぎ第一弾は担当者携帯へのPSTN転送とする

- ステータス: 採用
- 日付: 2026-07-15
- 対象: AIから人間への引き継ぎ（エスカレーション）方式、Twilio TwiML設計
- 関係: [ADR-0002](./0002-operator-console-human-handoff.md) の実施順序を変更する（ADR-0002のコンソール構成は第二弾として維持）

## 背景

ADR-0002はブラウザベースのオペレーターコンソール（React + Twilio Voice SDK + Conference制御）による引き継ぎを設計したが、これは「ログイン中のオペレーターが常駐している」ことが前提となる。Cor.の現体制は少人数で、担当者が常時PCの前にいるとは限らない。

商用AI電話サービスの調査では、小規模事業者向けサービス（IVRy等）は携帯・固定電話へのPSTN転送を第一級の引き継ぎ手段としており、ブラウザ着信はコールセンター型組織向けのオプションという切り分けが明確だった。Twilio公式のOpenAI Realtime API向けwarm transferリファレンス実装（openai-programmable-sip）でも、転送先は電話番号（E.164）である。

## 決定

### 第一弾（本ADR）: 携帯PSTN転送 + Whisper

1. **転送**: `<Dial>` + `<Number>` で担当者の携帯へ転送する。`<Number>` は最大10個並べて同時呼び出し（先に出た人に接続、他は停止）できる。転送先番号は環境変数/Secretで管理し、リポジトリには書かない。
2. **Whisper（簡易warm transfer）**: `<Number url="...">` を使い、担当者が応答した直後・発信者と繋がる前に、AIが生成した通話サマリを `<Say>` で担当者にだけ読み上げ、`<Gather>` で受諾キー押下を求める。これにより:
   - 担当者は文脈を知ってから会話を始められる（warm transferの体験）
   - 担当者の留守番電話がAI要約を録音して接続扱いになる事故を防げる
3. **不応答フォールバック**: `<Dial action="...">` callbackで `DialCallStatus`（no-answer/busy/failed）を受け、フォールバックする: 発信者への案内→折り返し登録（callLogsへ記録）→担当者へメール通知（[ADR-0007](./0007-notification-unification-resend.md)の通知経路）。
4. **AI側トリガー**: Realtimeセッションにパスアップ判定tool（例: `transfer_to_human`）を追加し、tool発火でライブコールを転送TwiMLへリダイレクトする（issue #15を本方針へ更新）。

### 第二弾（ADR-0002を維持）: オペレーターコンソール + Conference

同時多数着信、通話モニタリング、ささやき指導、CRM画面連携が必要になった段階で、ADR-0002のコンソール構成に着手する。Conference構成のwarm transferはTwilio公式リファレンス実装（openai-programmable-sip）を採用候補とする。対応issue（#12, #13, #17, #11）は `phase-2` ラベルで維持する。

## 理由

- 追加インフラ・追加アプリなしで、担当者は普段の携帯で受けられる（取りこぼしが最少）
- Whisperにより実装コストを抑えつつwarm transferの体験を確保できる
- コスト: 日本の携帯への発信は約$0.185/分。転送中は着信+発信の両レッグ課金で概算約29円/分（$1=150円換算）。月100件×3分でも約9千円程度で、コンソール開発・運用コストより十分安い

## 影響

- 詳細設計: [handoff-phase1-pstn-transfer.md](../handoff-phase1-pstn-transfer.md)
- 関連issue: 携帯転送（Wave C1）、Whisper（Wave C2）、不応答フォールバック（Wave C3）、パスアップ判定tool（#15）
- Twilio署名検証をwhisper/callbackエンドポイントにも適用する

## 参考

- Twilio `<Number>`（whisper/url属性、同時呼び出し）: https://www.twilio.com/docs/voice/twiml/number
- Twilio公式warm transfer参照実装: https://github.com/mhughan-twilio/openai-programmable-sip
- Twilio日本料金: https://www.twilio.com/en-us/voice/pricing/jp
