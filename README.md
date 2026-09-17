# tosyokan-bot

Bun + Cloudflare Workers + discord-hono で動く図書館OPACボットです。指定の [創英社系OPAC](https://soei-ed-library.opac.jp/opac/top) を基準に、OPACプロバイダーへ対応します。

## セットアップ

```bash
bun install
bun run register     # Discordにスラッシュコマンドを登録
bun run deploy       # Workersへデプロイ
```

`DISCORD_APPLICATION_ID`、`DISCORD_TOKEN`、`DISCORD_PUBLIC_KEY` はWranglerのsecretまたは環境変数として設定してください。KV namespace binding は `wrangler.jsonc` の `kv` を使用します。

## コマンド

- `/register url:<URL>` — URLを正規化し、`.opac.jp` や `/opac/` を判定してOPACとして、このサーバー（DMではそのDM）に保存します。1スコープにつき登録できる図書館は1件です。
- `/unregister` — このサーバー／DMに登録した図書館を削除します。登録は1スコープにつき1件に限定し、サーバーの購読対象からも外れます。
- プロバイダーが不明なURL — URLからOPAC判定できない場合は、対応図書館を増やすための情報（図書館名・URL・システム名・検索方法）を入力するモーダルを表示します。入力内容はKVに保存され、`yes` を選んだ場合だけ実行チャンネルにも受付通知を送ります。
- `/subscribe` — サーバー内で実行したチャンネルを購読先にします。そのサーバーに登録された1つの図書館だけが対象です。DMからの購読設定はできません。1時間ごとのWorkers Cronが新着ページを確認します。
- `/unsubscribe` — 現在購読中のチャンネルから、このサーバーの更新通知を解除します。別チャンネルから実行した場合は、現在の購読チャンネルを案内します。
- `/search query:<検索語> [limit:<件数>]` — 登録OPACの `Free_word_search/search?q=...` を取得し、Cheerioで結果リンク・タイトルを抽出します。

登録データは `library:guild:<guild_id>` または `library:dm:<channel_id>` に1件ずつ、購読データは `subscription:guild:<guild_id>` に1件、図書館IDから購読サーバーを逆引きする配列を `subscription-index:library:<library_id>` に保存します。新着ISBNは各図書館レコードの `seenIsbns`、対応情報は `provider-feedback:<scope>:<timestamp>` に保存されます。Cronはこの逆引きインデックスを使い、同じ図書館への新着ページ取得を1時間ごとに1回だけ実行します。

## 開発

```bash
bun run typecheck
bun run register
```
