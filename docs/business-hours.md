# 営業時間情報の判定

`lib/business-hours.js` は営業時間の案内と折返し提案に使う純粋関数である。
**緊急時は24時間転送可**というユーザー方針を変更しない。
`emergency_transfer_allowed: true` は営業時間による制限を加えないという意味であり、
既存の転送方針、生命・身体の危険判定、認証、ActionGateを迂回する許可ではない。

会社の実営業時間は未設定である。未設定を24時間営業と案内してはならない。
このモジュールは環境変数を直接読まず、呼出し側が `BUSINESS_HOURS_JSON` を渡せる。
`lib/business-hours-tool.js` が `BUSINESS_HOURS_JSON` を読み、
`index.js` のLive/Realtime両経路で `check_business_hours` toolを登録・実行する。
設定はサーバー環境変数の変更後、プロセス再起動または新revisionのデプロイで反映する。
未設定の本番へ架空の営業時間を投入しない。

## API

```js
import { evaluateBusinessHours, parseBusinessHoursConfig } from '../lib/business-hours.js';
const result = evaluateBusinessHours(process.env.BUSINESS_HOURS_JSON, {
    now: '2026-11-02T12:00:00+09:00'
});
```

`now` はDate、epoch milliseconds、秒を含むtimezone付きISO datetimeを受ける。
省略時は現在時刻。timezoneなし文字列や存在しない日付は `invalid_now`。
`parseBusinessHoursConfig` は `{ ok, configured, config, issues }` を返す。
不正値は投げずに説明可能な判定を返し、入力オブジェクトを変更しない。

設定形式（下記はテスト用例であり、Corの営業時間ではない）:

```json
{
  "timeZone": "Asia/Tokyo",
  "weekly": {
    "mon": [{"start":"09:00","end":"12:00"},{"start":"13:00","end":"18:00"}],
    "tue": [{"start":"09:00","end":"18:00"}]
  },
  "exceptions": {
    "2026-11-03": [],
    "2026-11-07": [{"start":"14:00","end":"16:00"}]
  }
}
```

- timezoneはAsia/Tokyoのみ。省略してもAsia/Tokyo。
- 週次キーはsun/mon/tue/wed/thu/fri/sat。省略曜日は休業。
- 開始を含み終了を含まない。1日に複数区間を設定でき、重複区間は拒否。
- `24:00` は終了だけに使える。夜跨ぎは各曜日の `22:00–24:00` と `00:00–02:00` に分割する。
- 例外日は週次設定を丸ごと置換する。空配列は祝日・臨時休業。国民の祝日は自動推定しない。
- `weekly:{}` は明示的な全日休業。`exceptions` のみの設定も利用可能。
- 未設定、空文字、nullはunknown。JSON文字列の `null` や `{}` は不正設定として区別する。

返却項目:

| 項目 | 意味 |
|---|---|
| configured | 設定が渡されたか。不正設定でもtrue |
| state / open / closed | open/closed。未設定・不正時はunknown/null/null |
| time_zone / evaluated_at | 判定timezoneと判定時刻（UTC ISO、未判定時null） |
| next_available_at | 営業中は判定時刻、休業中は次の営業開始（UTC ISO）。次回なし/不明はnull |
| schedule_source | weekly/exception、未判定時null |
| reason | not_configured / invalid_config / invalid_now / within_business_hours / outside_business_hours / exception_open / exception_closed / no_upcoming_business_hours |
| emergency_transfer_allowed | 常にtrue。営業時間を緊急転送の制限に使わない |

次営業開始は週次と明示例外から求める。固定の1年探索上限を設けないため、
長期休業の連続例外も正しく扱う。次営業開始は担当者の応答や折返し完了の保証ではない。

## 根拠と確認

営業時間・timezone・複数区間・例外による分岐は
[Amazon Connect公式管理Docs](https://docs.aws.amazon.com/connect/latest/adminguide/set-hours-operation.html)と
[IVRy公式機能説明](https://ivry.jp/function/ivr-for-after-business-hours/)を参照した（2026-11-07閲覧）。
本実装は外部サービスへ問い合わせず、Node標準Dateと検証済みAsia/Tokyo固定オフセットを使う。
新規依存はない。

既存の転送判断は `src/domain/routing-policy.ts:evaluateTransferRequest`、
発信前ゲートは `index.js:startHandoff` にある。この情報判定を転送拒否条件へ追加しない。

検査: `node --test test/business-hours.test.js`。
曜日境界、営業開始/終了、昼休み、祝日の明示例外、臨時営業、日跨ぎ、長期休業、
不正日付/設定、未設定、JSON入力、入力非破壊を固定時刻で検査する。
実会社設定・電話越しの案内・本番動作は別途受入が必要。
`node --test test/business-hours-tool.test.js test/media-stream.integration.test.js` は
不正引数と実indexのLive delegated tool往復を外部課金なしで検査する。
