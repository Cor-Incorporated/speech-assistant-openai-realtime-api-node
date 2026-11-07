# 通話・エスカレーション一覧の継続取得

最新500件に条件一致がない場合でも、次ページで古い未処理案件へ進めるようにした。
対象は管理v2 APIの通話一覧とエスカレーション一覧。

- `nextCursor` は不透明な文字列として、そのまま次のGETの `cursor` へ渡す。
- `items: []` でも `hasMore: true` なら取得は続く。`partial` は残りの走査対象があることを表し、全件数ではない。
- 1要求は最大501レコードを読み、最大500レコードを走査する。一致件数の上限は `limit`（1〜200、既定50）。
- 絞り込み条件を変えたらカーソルを破棄して先頭から読む。不正な文字列、別一覧・別条件のカーソルは400 `INVALID_CURSOR`。
- 旧形式のID単体カーソルは再利用できない。アップデート時に開いていた一覧は再読込する。

順序は通話が `startedAt DESC`、エスカレーションが `createdAt DESC`。同時刻はドキュメントIDの降順で固定する。
エスカレーション一覧のページ内ACK優先並べ替えは行わず、未受諾だけを見る場合は既存の `unacknowledged=true` を使う。
カーソルには時刻とIDの位置を保持するため、対象ドキュメントが削除されても継続できる。
読み込み途中にカーソルより前へ追加されたレコードは、先頭から再読込すると表示される。複数ページにまたがるスナップショット一貫性は保証しない。

Firestoreの既存時刻インデックスと同方向の `__name__` 順序を使う。新しい複合インデックス定義は追加しない。
根拠: [クエリカーソル](https://firebase.google.com/docs/firestore/query-data/query-cursors)、[既定のドキュメント名順序](https://firebase.google.com/docs/firestore/query-data/index-overview#default_ordering_and_the_name_field)。

`test/record-pagination.test.js` は501件目の未受諾案件・折り返し案件、同時刻、カーソル対象削除、途中追加、不正カーソル、memory/Firestoreの一致を検査する。
Firestore側は実Repositoryとローカルquery stub、およびインストール済みSDKのクエリ変換で検査する。外部Firestoreへの接続は未検証。
