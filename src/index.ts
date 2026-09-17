import {
  DiscordHono,
  makeIntegerOption,
  makeLabel,
  makeModal,
  makeSlashCommand,
  makeStringOption,
  makeTextInput,
} from "discord-hono";
import { load } from "cheerio";

/** Supported library-system provider. OPAC is the first supported provider. */
export type LibraryProvider = "opac" | "unknown";

export interface LibraryRegistration {
  id: string;
  url: string;
  provider: LibraryProvider;
  label: string;
  addedBy: string;
  createdAt: string;
  seenIsbns?: string[];
}

export interface Subscription {
  scope: string;
  channelId: string;
  libraryId: string;
  createdAt: string;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  description?: string;
}

export interface NewArrival {
  isbn: string;
  title: string;
  url: string;
}

interface ProviderFeedback {
  scope: string;
  channelId?: string;
  userId: string;
  url: string;
  details: string;
  notifyChannel: boolean;
  createdAt: string;
}

type Env = { Bindings: { kv: KVNamespace; DISCORD_TOKEN?: string; DISCORD_APPLICATION_ID?: string; DISCORD_PUBLIC_KEY?: string } };

const LIBRARIES_PREFIX = "library:";
const SUBSCRIPTIONS_PREFIX = "subscription:";
const LIBRARY_SUBSCRIBERS_PREFIX = "subscription-index:library:";
const PENDING_PROVIDER_PREFIX = "pending-provider:";
const PROVIDER_FEEDBACK_PREFIX = "provider-feedback:";
const MAX_RESULTS = 10;

/** Normalize an OPAC URL and reject non-web URLs before persisting it. */
export function normalizeLibraryUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("URLを入力してください。");
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try { parsed = new URL(withScheme); } catch { throw new Error("有効なURLを入力してください。"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("http または https のURLを入力してください。");
  if (parsed.username || parsed.password) throw new Error("認証情報を含むURLは登録できません。");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_[^=]+|fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  const normalized = parsed.toString();
  if (normalized.length > 2048) throw new Error("URLが長すぎます。");
  return normalized;
}

/** Heuristic provider detection; it works without a request to the remote OPAC. */
export function detectProvider(input: string): LibraryProvider {
  const url = new URL(normalizeLibraryUrl(input));
  const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
  if (/\.opac\.|\/opac(?:\/|$)|opac\./.test(haystack)) return "opac";
  return "unknown";
}

export function providerLabel(provider: LibraryProvider): string {
  return { opac: "OPAC（図書館システム）", unknown: "未対応" }[provider];
}

function scopeFor(interaction: any): { key: string; label: string } {
  if (interaction.guild_id) return { key: `guild:${interaction.guild_id}`, label: "このサーバー" };
  const channel = interaction.channel_id ?? interaction.user?.id ?? interaction.member?.user?.id;
  return { key: `dm:${channel ?? "unknown"}`, label: "このDM" };
}

function actorId(interaction: any): string {
  return interaction.user?.id ?? interaction.member?.user?.id ?? "unknown";
}

function option(c: any, key: string): unknown { return c.get(key); }

function pendingProviderKey(scope: string, userId: string): string {
  return `${PENDING_PROVIDER_PREFIX}${scope}:${userId}`;
}

function libraryKey(scope: string): string { return `${LIBRARIES_PREFIX}${scope}`; }
function subscriptionKey(scope: string): string { return `${SUBSCRIPTIONS_PREFIX}${scope}`; }
function librarySubscribersKey(libraryId: string): string { return `${LIBRARY_SUBSCRIBERS_PREFIX}${libraryId}`; }

/** Return guild IDs currently subscribed to a library registration ID. */
export async function getGuildIdsForLibrary(kv: KVNamespace, libraryId: string): Promise<string[]> {
  const value = await kv.get<string[]>(librarySubscribersKey(libraryId), { type: "json" });
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((guildId): guildId is string => typeof guildId === "string" && guildId.length > 0)));
}

async function addGuildToLibraryIndex(kv: KVNamespace, libraryId: string, guildId: string): Promise<void> {
  const guildIds = await getGuildIdsForLibrary(kv, libraryId);
  if (guildIds.includes(guildId)) return;
  await kv.put(librarySubscribersKey(libraryId), JSON.stringify([...guildIds, guildId]));
}

async function removeGuildFromLibraryIndex(kv: KVNamespace, libraryId: string, guildId: string): Promise<void> {
  const guildIds = (await getGuildIdsForLibrary(kv, libraryId)).filter((id) => id !== guildId);
  if (guildIds.length === 0) await kv.delete(librarySubscribersKey(libraryId));
  else await kv.put(librarySubscribersKey(libraryId), JSON.stringify(guildIds));
}

async function readLibrary(kv: KVNamespace, scope: string): Promise<LibraryRegistration | null> {
  const value = await kv.get<LibraryRegistration>(libraryKey(scope), { type: "json" });
  return value && typeof value === "object" && !Array.isArray(value) ? value as LibraryRegistration : null;
}

async function writeLibrary(kv: KVNamespace, scope: string, library: LibraryRegistration | null): Promise<void> {
  if (library) await kv.put(libraryKey(scope), JSON.stringify(library));
  else await kv.delete(libraryKey(scope));
}

function makeId(url: string): string {
  return `lib_${Array.from(url).reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 7).toString(36)}`;
}

function displayHost(url: string): string { return new URL(url).hostname; }

export function buildSearchUrl(library: LibraryRegistration, query: string): string {
  const url = new URL(library.url);
  const marker = url.pathname.toLowerCase().indexOf("/opac/");
  const opacRoot = marker >= 0 ? url.pathname.slice(0, marker + "/opac/".length) : "/opac/";
  // OPAC's free-word search endpoint is shared by the supported systems.
  // Preserve optional filters such as `mtl`, but always replace the query.
  url.pathname = `${opacRoot}Free_word_search/search`;
  for (const key of ["q", "query", "keyword", "search", "page"]) url.searchParams.delete(key);
  url.searchParams.set("q", query.trim());
  return url.toString();
}

export function parseSearchResults(html: string, baseUrl: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const $ = load(html);
  // OPAC search pages render each hit as a `li.book`. The page also has many
  // navigation anchors, so parsing every `a[href]` produces false results.
  const cards = $("li.book, article.book, .book-list-item, .search-result-item, .result-item");
  cards.each((_index, element) => {
    const card = $(element);
    const titleElement = card.find("h3.item-id-titles, h3.item-id-title-vol-series, .item-id-titles, .item-id-title-vol-series").first();
    const title = titleElement.text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 2 || title.length > 180) return;
    const link = titleElement.find("a[href]").first().length
      ? titleElement.find("a[href]").first()
      : card.find("a[href*='/hlist'], a[href*='/detail'], a[href*='/show']").first();
    const href = link.attr("href");
    if (!href || /^javascript:/i.test(href)) return;
    let url: string;
    try { url = new URL(href, baseUrl).toString(); } catch { return; }
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ id: url, title, url });
    if (results.length >= MAX_RESULTS) return false;
  });
  return results;
}

/** Search one registered OPAC, returning an empty result when it blocks bots. */
export async function searchLibrary(library: LibraryRegistration, query: string): Promise<SearchResult[]> {
  const target = buildSearchUrl(library, query);
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(6000), headers: { accept: "text/html", "user-agent": "tosyokan-bot/0.1" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseSearchResults(await response.text(), target);
  } catch { return []; }
}

async function postChannelMessage(rest: any, channelId: string, payload: Record<string, unknown>): Promise<void> {
  await rest("POST", "/channels/{channel.id}/messages" as any, [channelId], payload);
}

function normalizeIsbn(value: string): string | undefined {
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^(?:97[89]\d{10}|\d{9}[\dX])$/.test(compact)) return compact;
  return undefined;
}

/** Extract the latest books from an OPAC's newly-arrived HTML page. */
export function parseNewArrivals(html: string, baseUrl: string): NewArrival[] {
  const results: NewArrival[] = [];
  const seen = new Set<string>();
  const $ = load(html);
  const containers = $("li, article, tr, .book, .book-list-item, .item, .material, .newly-arrived, [class*='book'], [class*='item'], [class*='material'], [class*='new']");
  containers.each((_index, element) => {
    const container = $(element);
    const text = container.text().replace(/\s+/g, " ").trim();
    const isbn = text.match(/(?:97[89](?:[\s-]?\d){10}|\d(?:[\s-]?\d){8}[\s-]?[\dXx])/g)?.map(normalizeIsbn).find(Boolean);
    if (!isbn || seen.has(isbn)) return;
    const link = container.find("a[href]").first();
    const href = link.attr("href");
    if (!href) return;
    let url: string;
    try { url = new URL(href, baseUrl).toString(); } catch { return; }
    const title = container.find(".title, .book-title, .item-title, h2, h3, h4").first().text().replace(/\s+/g, " ").trim() || link.text().replace(/\s+/g, " ").trim();
    if (!title) return;
    seen.add(isbn);
    results.push({ isbn, title, url });
    if (results.length >= MAX_RESULTS) return false;
  });
  return results;
}

async function fetchNewArrivals(library: LibraryRegistration): Promise<NewArrival[]> {
  const base = new URL(library.url);
  const marker = base.pathname.toLowerCase().indexOf("/opac/");
  const opacRoot = marker >= 0 ? base.pathname.slice(0, marker + "/opac/".length) : "/opac/";
  const target = new URL(`${opacRoot}Newly_arrived`, base).toString();
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(6000), headers: { accept: "text/html", "user-agent": "tosyokan-bot/0.1" } });
    if (!response.ok) return [];
    return parseNewArrivals(await response.text(), target);
  } catch { return []; }
}

async function processSubscriptions(env: Env["Bindings"], rest: any): Promise<void> {
  let cursor: string | undefined;
  do {
    // Poll once per library ID. Several guilds may subscribe to the same
    // registration, so iterating subscriptions directly would duplicate the
    // remote request for every guild.
    const listed = await env.kv.list({ prefix: LIBRARY_SUBSCRIBERS_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const key of listed.keys) {
      const libraryId = key.name.slice(LIBRARY_SUBSCRIBERS_PREFIX.length);
      if (!libraryId) continue;
      const guildIds = await getGuildIdsForLibrary(env.kv, libraryId);
      const entries: Array<{ guildId: string; subscription: Subscription; library: LibraryRegistration }> = [];
      for (const guildId of guildIds) {
        const scope = `guild:${guildId}`;
        const subscription = await env.kv.get<Subscription>(subscriptionKey(scope), { type: "json" });
        if (!subscription || subscription.libraryId !== libraryId) continue;
        const library = await readLibrary(env.kv, scope);
        if (library?.id !== libraryId) continue;
        entries.push({ guildId, subscription, library });
      }
      if (!entries.length) continue;

      // All entries in this index point to the same normalized library ID.
      const firstEntry = entries[0];
      if (!firstEntry) continue;
      const updates = await fetchNewArrivals(firstEntry.library);
      if (!updates.length) continue;
      for (const entry of entries) {
        const previous = new Set(entry.library.seenIsbns ?? []);
        const fresh = updates.filter((item) => !previous.has(item.isbn));
        entry.library.seenIsbns = updates.map((item) => item.isbn).slice(0, 100);
        if (previous.size > 0 && fresh.length > 0) {
          const content = [`📚 **${entry.library.label}** に新着資料があります。`, ...fresh.slice(0, 5).map((item) => `・[${item.title}](${item.url})（ISBN: \`${item.isbn}\`）`)].join("\n");
          try { await postChannelMessage(rest, entry.subscription.channelId, { content }); } catch { /* channel may have been deleted */ }
        }
        await writeLibrary(env.kv, `guild:${entry.guildId}`, entry.library);
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

const providerInfoModal = makeModal("provider-info", "対応図書館の情報提供", [
  makeLabel("図書館・システム情報", makeTextInput("details", "図書館名、URL、システム名、検索方法").required(true).max_length(1000)),
  makeLabel("チャンネル通知", makeTextInput("notify", "yes または no").required(false).max_length(10).placeholder("yes / no")),
]);

export const commands = [
  makeSlashCommand("ping", "接続状態を確認します"),
  makeSlashCommand("register", "図書館のURLを登録します").options([makeStringOption("url", "図書館システムのURL（https://example.jp）").required(true)]),
  makeSlashCommand("unregister", "登録済みの図書館を削除します"),
  makeSlashCommand("subscribe", "このチャンネルに登録図書館の更新を通知します"),
  makeSlashCommand("unsubscribe", "このサーバーの更新通知を解除します"),
  makeSlashCommand("search", "登録した図書館を横断検索します").options([makeStringOption("query", "書名・著者・キーワード").required(true), makeIntegerOption("limit", "表示件数（1〜10）").required(false).min_value(1).max_value(10)]),
];

const app = new DiscordHono<Env>()
  .command("ping", (c) => c.res("Pong! 図書館ボットは稼働中です。"))
  .command("register", async (c) => {
    const scope = scopeFor(c.interaction);
    try {
      const url = normalizeLibraryUrl(String(option(c, "url") ?? ""));
      const provider = detectProvider(url);
      if (provider === "unknown") {
        await c.env.kv.put(pendingProviderKey(scope.key, actorId(c.interaction)), JSON.stringify({
          scope: scope.key,
          channelId: c.interaction.channel_id,
          userId: actorId(c.interaction),
          url,
        }), { expirationTtl: 600 });
        return c.resModal(providerInfoModal);
      }
      const library = await readLibrary(c.env.kv, scope.key);
      if (library) return c.flags("EPHEMERAL").res(`このスコープには既に図書館が登録されています（${library.id}）。\n先に \`/unregister\` で解除してください。`);
      const registration: LibraryRegistration = { id: makeId(url), url, provider, label: displayHost(url), addedBy: actorId(c.interaction), createdAt: new Date().toISOString() };
      await writeLibrary(c.env.kv, scope.key, registration);
      return c.res(`✅ ${scope.label} に登録しました\n**${registration.label}**（${providerLabel(provider)}）\n${url}\nID: \`${registration.id}\`\n\`/subscribe\` で通知を有効にできます。`);
    } catch (error) { return c.flags("EPHEMERAL").res(`登録できませんでした: ${error instanceof Error ? error.message : "URLを確認してください。"}`); }
  })
  .command("unregister", async (c) => {
    const scope = scopeFor(c.interaction);
    const library = await readLibrary(c.env.kv, scope.key);
    if (!library) return c.flags("EPHEMERAL").res("このスコープには図書館が登録されていません。");
    const current = c.interaction.guild_id
      ? await c.env.kv.get<Subscription>(subscriptionKey(scope.key), { type: "json" })
      : null;
    await writeLibrary(c.env.kv, scope.key, null);
    if (c.interaction.guild_id) {
      await c.env.kv.delete(subscriptionKey(scope.key));
      for (const libraryId of new Set([library.id, current?.libraryId].filter((id): id is string => Boolean(id)))) {
        await removeGuildFromLibraryIndex(c.env.kv, libraryId, c.interaction.guild_id);
      }
    }
    return c.res(`🗑️ **${library.label}** を${scope.label}から解除しました。`);
  })
  .command("subscribe", async (c) => {
    if (!c.interaction.guild_id) return c.flags("EPHEMERAL").res("`/subscribe` はサーバー内で設定してください。DMに登録した図書館はサーバーの購読対象にはなりません。");
    const scope = scopeFor(c.interaction);
    const channelId = c.interaction.channel_id;
    if (!channelId) return c.flags("EPHEMERAL").res("通知先チャンネルを特定できませんでした。");
    const current = await c.env.kv.get<Subscription>(subscriptionKey(scope.key), { type: "json" });
    if (current && current.channelId !== channelId) {
      return c.flags("EPHEMERAL").res(`このサーバーはすでに <#${current.channelId}> を購読チャンネルに設定しています。\n先に現在のチャンネルで \`/unsubscribe\` を実行してから、こちらで購読してください。`);
    }
    const library = await readLibrary(c.env.kv, scope.key);
    if (!library) return c.flags("EPHEMERAL").res("先に `/register url:...` で図書館を登録してください。");
    if (current?.libraryId && current.libraryId !== library.id) {
      await removeGuildFromLibraryIndex(c.env.kv, current.libraryId, c.interaction.guild_id);
    }
    const subscription: Subscription = { scope: scope.key, channelId, libraryId: library.id, createdAt: current?.createdAt ?? new Date().toISOString() };
    await c.env.kv.put(subscriptionKey(scope.key), JSON.stringify(subscription));
    await addGuildToLibraryIndex(c.env.kv, library.id, c.interaction.guild_id);
    return c.res(`🔔 **${library.label}** の更新をこのチャンネルで受け取ります。`);
  })
  .command("unsubscribe", async (c) => {
    if (!c.interaction.guild_id) return c.flags("EPHEMERAL").res("`/unsubscribe` はサーバー内で実行してください。");
    const scope = scopeFor(c.interaction);
    const channelId = c.interaction.channel_id;
    if (!channelId) return c.flags("EPHEMERAL").res("解除元チャンネルを特定できませんでした。");
    const current = await c.env.kv.get<Subscription>(subscriptionKey(scope.key), { type: "json" });
    if (!current) return c.flags("EPHEMERAL").res("このサーバーには購読チャンネルが設定されていません。");
    if (current.channelId !== channelId) {
      return c.flags("EPHEMERAL").res(`現在の購読チャンネルは <#${current.channelId}> です。そこで \`/unsubscribe\` を実行してください。`);
    }
    await c.env.kv.delete(subscriptionKey(scope.key));
    if (current.libraryId) await removeGuildFromLibraryIndex(c.env.kv, current.libraryId, c.interaction.guild_id);
    return c.res("🔕 このサーバーの図書館更新通知を解除しました。");
  })
  .command("search", async (c) => {
    const scope = scopeFor(c.interaction);
    const query = String(option(c, "query") ?? "").trim();
    const limit = Math.min(10, Math.max(1, Number(option(c, "limit") ?? 5)));
    if (!query) return c.flags("EPHEMERAL").res("検索語を入力してください。");
    return c.resDefer(async () => {
      const library = await readLibrary(c.env.kv, scope.key);
      if (!library) return c.followup("先に `/register` で図書館を登録してください。");
      const results = await searchLibrary(library, query);
      const lines = results.slice(0, limit).map((item) => `**${library.label}** · [${item.title}](${item.url})`);
      if (!lines.length) return c.followup(`「${query}」に一致する結果が見つかりませんでした。\n検索リンク: [${library.label}](${buildSearchUrl(library, query)})`);
      const body = lines.join("\n");
      return c.followup(`🔎 「${query}」の検索結果\n${body.slice(0, 1850)}${body.length > 1850 ? "\n…（結果を一部省略）" : ""}`);
    });
  })
  .modal("provider-info", async (c) => {
    const scope = scopeFor(c.interaction);
    const userId = actorId(c.interaction);
    const pendingKey = pendingProviderKey(scope.key, userId);
    const pending = await c.env.kv.get<{ scope: string; channelId?: string; userId: string; url: string }>(pendingKey, { type: "json" });
    if (!pending) return c.flags("EPHEMERAL").res("この入力フォームは期限切れです。もう一度 `/register` を実行してください。");
    const details = String(option(c, "details") ?? "").trim();
    if (!details) return c.flags("EPHEMERAL").res("対応情報が空です。もう一度入力してください。");
    const notifyValue = String(option(c, "notify") ?? "").trim().toLowerCase();
    const notifyChannel = /^(yes|y|true|1|はい|通知|する)$/i.test(notifyValue);
    const feedback: ProviderFeedback = { ...pending, details, notifyChannel, createdAt: new Date().toISOString() };
    await c.env.kv.put(`${PROVIDER_FEEDBACK_PREFIX}${scope.key}:${Date.now()}`, JSON.stringify(feedback));
    await c.env.kv.delete(pendingKey);
    if (notifyChannel && pending.channelId) {
      try { await postChannelMessage(c.rest, pending.channelId, { content: `📝 <@${userId}> さんから対応図書館追加の情報提供を受け付けました。\n${pending.url}` }); } catch { /* channel may no longer be available */ }
    }
    return c.res(`対応図書館追加の情報を受け付けました。\n${notifyChannel ? "このチャンネルにも受付通知を送りました。" : "チャンネル通知は送信しませんでした。"}`);
  })
  .cron("0 * * * *", async (c) => processSubscriptions(c.env, c.rest));

export default app;
