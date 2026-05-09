# discord-video-share

Cloudflare Workers と R2 を使った、短期間だけ共有できる動画アップロード用 Worker です。

## 概要

- `/` でアップロードページを表示
- R2 multipart upload で動画を分割アップロード
- `/v/:id` で動画の閲覧ページを表示
- `/file/:id` で動画ファイルを配信
- 定期実行で期限切れの動画と未完了アップロードセッションを削除

アップロードされた動画 ID には有効期限のタイムスタンプが含まれ、現在の実装では作成から約 3 日後に削除対象になります。

## セットアップ

依存関係をインストールします。

```bash
npm install
```

Cloudflare Workers の型を生成します。

```bash
npm run cf-typegen
```

ローカルで起動します。

```bash
npm run dev
```

デプロイします。

```bash
npm run deploy
```

## 必要な設定

`wrangler.jsonc` では、R2 bucket の binding として `BUCKET` を使います。

```jsonc
"r2_buckets": [
  {
    "bucket_name": "discord-videos",
    "binding": "BUCKET"
  }
]
```

アップロード用パスワードは secret として設定してください。

```bash
npx wrangler secret put UPLOAD_PASSWORD
```

## npm scripts

| Script | 内容 |
| --- | --- |
| `npm run dev` | Wrangler の開発サーバーを起動 |
| `npm run start` | `npm run dev` と同じ |
| `npm run deploy` | Worker をデプロイ |
| `npm run test` | Vitest を実行 |
| `npm run cf-typegen` | Cloudflare Workers の型を生成 |

## 主なエンドポイント

| Method | Path | 内容 |
| --- | --- | --- |
| `GET` | `/` | アップロードページ |
| `POST` | `/multipart/create` | multipart upload を開始 |
| `PUT` | `/multipart/part` | 分割された動画チャンクをアップロード |
| `POST` | `/multipart/finish` | multipart upload を完了 |
| `GET` | `/v/:id` | 動画閲覧ページ |
| `GET` | `/file/:id` | 動画ファイル本体 |

## 注意

この Worker は `UPLOAD_PASSWORD` を知っているユーザーだけがアップロードできる前提です。パスワードはコードや `wrangler.jsonc` に直接書かず、Cloudflare の secret として管理してください。
