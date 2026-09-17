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

- `/register url:<URL>` — URLを正規化し、`.opac.jp` や `/opac/` を判定してOPACとして、このサーバー（DMではそのDM）に保存します。同じURLは重複登録されません。
- プロバイダーが不明なURL — URLからOPAC判定できない場合は、対応情報（サービス名・検索URL）を入力するモーダルを表示します。入力内容はKVに保存され、`yes` を選んだ場合だけ実行チャンネルにも受付通知を送ります。
- `/subscribe [library:<ID>]` — 実行したチャンネルを購読先にします。`library` を省略すると登録済みの全図書館、指定するとその図書館だけを対象にします。15分ごとのWorkers Cronが更新を確認します。
- `/search query:<検索語> [limit:<件数>]` — 登録済みOPACを並列検索し、Cheerioで結果リンク・タイトルを抽出します。サイトがBotアクセスを拒否した場合も検索リンクを表示します。

登録データは `libraries:guild:<guild_id>` または `libraries:dm:<channel_id>`、購読データは `subscription:<scope>:<channel_id>`、対応情報は `provider-feedback:<scope>:<timestamp>` に保存されます。

## 開発

```bash
bun run typecheck
bun run register
```
