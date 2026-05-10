# ADR 0005: Clerkを管理画面の認証基盤に採用する

- ステータス: 採用
- 日付: 2026-05-10
- 対象: PoC MVP管理画面 (React + Fastify backend) の認証
- 関連: [ADR 0004 MVPスコープ凍結](./0004-mvp-scope-2026-05.md), [ADR 0002 (PoC対象外, 後継)](./0002-operator-console-human-handoff.md)

## 背景

ADR 0002 では「初期リリースの認証基盤を何にするか」が未決事項として残っていました。PoC (2026年5月中旬納期) では、最低限「認証されたオペレーターのみが通話履歴・設定を閲覧/編集できる」状態が必要です。

候補は次の3つでした。

1. Firebase Authentication
2. Clerk (Free tier)
3. 自前のJWT認証 (`jsonwebtoken` ベタ実装)

PoCの制約 (納期厳守、フロントエンド工数の最小化、運用者数は数人〜十数人) を踏まえて選定します。

## 決定

PoC MVPでは **Clerk (Free tier)** を採用します。

- React側: `@clerk/clerk-react` の `<SignIn />` / `<SignedIn>` で認証ガード。
- backend側: `@clerk/fastify` または手動の `verifyToken` でClerk JWTを検証する。
- ユーザー管理はClerkダッシュボードで行い、招待制とする。
- 初期はEmail + Password、または Google OAuth のみ有効化する。

将来 (フェーズ2以降) に必要になった場合のみ、Firebase Auth等への移行を検討する。

## 理由

| 観点 | Firebase Auth | Clerk Free | 自前JWT |
| --- | --- | --- | --- |
| 導入工数 | 中 (Firebase初期化必要) | 低 (React/Node SDK完備) | 高 (UI/招待/パスワードリセット自作) |
| MAU課金 | 50k MAUまで無料、その後従量 | 10k MAUまで無料 | 無料 |
| 招待・パスワードリセットUI | 自作 | 標準提供 | 自作 |
| 既存Firestoreとの結合 | 良 | JWTカスタムクレームで連携 | 良 |
| 後フェーズ移行 | 容易 | JWT互換のため移行可 | 容易 |

PoC運用者は数人想定で10k MAUに収まり、SDKと管理UIが揃っているClerkが工数最小です。Firestore接続はbackendがClerk JWT検証後にservice accountで読み書きするため、Firebase Authでなくても問題ありません。

## 実装方針

1. `frontend/` (新規) に Vite + React + TypeScript + Clerk構成を作る。
2. `frontend/.env` の `VITE_CLERK_PUBLISHABLE_KEY` でPublishable Keyを参照する。
3. backendに `CLERK_SECRET_KEY` と `CLERK_PUBLISHABLE_KEY` をSecret Manager経由で注入する。
4. `/admin/*` ルートは Clerk JWTのIssuer / Audience を検証してから処理する。
5. 既存の `/incoming-call`, `/media-stream` (Twilio用) はClerk認証を必要としない (Twilio署名検証でガード)。
6. ログアウトはClerkの `<UserButton />` でカバーする。
7. Free tierのMAUを監視するため、Clerk Dashboardのアラートを有効化する。

## 影響

- 新規ENV: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`。
- 新規依存: `@clerk/clerk-react` (frontend), `@clerk/fastify` または `@clerk/backend` (server)。
- Cloud Run service accountには変更なし。
- Twilio webhook経路はClerk認証の対象外で、引き続きTwilio署名検証でガードする。
- Free tier上限を超えそうな場合は、フェーズ2でPro / Firebase Authへの移行を検討する。

## 受け入れ条件

- 未ログインで `/admin/calls` にアクセスすると401で拒否される。
- 招待されたユーザーがClerkで認証すると、管理画面の通話履歴とAI設定にアクセスできる。
- backend ログにClerk JWTの本文 (PII) は出力しない。
- Clerk側のユーザー削除でアクセスが即時無効になる。

## 参考

- Clerk Pricing: https://clerk.com/pricing
- Clerk React Quickstart: https://clerk.com/docs/quickstarts/react
- Clerk Backend SDK: https://clerk.com/docs/references/backend/overview
