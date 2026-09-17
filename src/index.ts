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

/** A library system which is useful when choosing the right search strategy. */
export type LibraryProvider = "opac" | "unknown";

export interface LibraryRegistration {
  id: string;
  url: string;
  provider: LibraryProvider;
  label: string;
  addedBy: string;
  createdAt: string;
  seenItemIds?: string[];
}

export interface Subscription {
  scope: string;
  channelId: string;
  libraryIds?: string[];
  createdAt: string;
  seenByLibrary?: Record<string, string[]>;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  description?: string;
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

const LIBRARIES_PREFIX = "libraries:";
const SUBSCRIPTIONS_PREFIX = "subscription:";
const PENDING_PROVIDER_PREFIX = "pending-provider:";
const PROVIDER_FEEDBACK_PREFIX = "provider-feedback:";
const MAX_LIBRARIES = 25;
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
  return { opac: "OPAC", unknown: "未対応" }[provider];
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

async function readLibraries(kv: KVNamespace, scope: string): Promise<LibraryRegistration[]> {
  const value = await kv.get(libraryKey(scope), "json");
  return Array.isArray(value) ? value as LibraryRegistration[] : [];
}

async function writeLibraries(kv: KVNamespace, scope: string, libraries: LibraryRegistration[]) {
  await kv.put(libraryKey(scope), JSON.stringify(libraries.slice(0, MAX_LIBRARIES)));
}

function makeId(url: string): string {
  return `lib_${Array.from(url).reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 7).toString(36)}`;
}

function displayHost(url: string): string { return new URL(url).hostname; }

export function buildSearchUrl(library: LibraryRegistration, query: string): string {
  const url = new URL(library.url);
  const marker = url.pathname.toLowerCase().indexOf("/opac/");
  const opacRoot = marker >= 0 ? url.pathname.slice(0, marker + "/opac/".length) : "/opac/";
  url.pathname = `${opacRoot}Search`;
  for (const key of ["q", "query", "keyword", "search", "page"]) url.searchParams.delete(key);
  url.searchParams.set("keyword", query.trim());
  return url.toString();
}

function decodeHtml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/\s+/g, " ").trim();
}

export function parseSearchResults(html: string, baseUrl: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const $ = load(html);
  $("a[href]").each((_index, element) => {
    const match = $(element);
    const title = match.text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 2 || title.length > 180) return;
    let url: string;
    try { url = new URL(match.attr("href") ?? "", baseUrl).toString(); } catch { return; }
    if (seen.has(url) || /^(検索|ログイン|次へ|前へ|menu|home|詳細|資料検索|新着資料|雑誌タイトル索引|データベース他|ブックリスト|文献依頼|カレンダー|すべて見る|詳しく探す)$/i.test(title)) return;
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
    const response = await fetch(target, { signal: AbortSignal.timeout(6000), headers: { accept: "text/html,application/json", "user-agent": "tosyokan-bot/0.1" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      const json = await response.json() as any;
      const rows = Array.isArray(json) ? json : json.items ?? json.results ?? [];
      return rows.slice(0, MAX_RESULTS).map((row: any, index: number) => ({ id: String(row.id ?? row.url ?? index), title: String(row.title ?? row.name ?? "無題"), url: String(row.url ?? target), description: row.description ? String(row.description) : undefined }));
    }
    return parseSearchResults(await response.text(), target);
  } catch { return []; }
}

function subscriptionKey(scope: string, channelId: string): string { return `${SUBSCRIPTIONS_PREFIX}${scope}:${channelId}`; }

async function postChannelMessage(rest: any, channelId: string, payload: Record<string, unknown>): Promise<void> {
  await rest("POST", "/channels/{channel.id}/messages" as any, [channelId], payload);
}

function parseFeed(xml: string, baseUrl: string): SearchResult[] {
  const results: SearchResult[] = [];
  const $ = load(xml, { xmlMode: true });
  $("item, entry").slice(0, MAX_RESULTS).each((_index, element) => {
    const entry = $(element);
    const title = entry.find("title").first().text().trim();
    const linkElement = entry.find("link").first();
    const href = linkElement.attr("href") ?? linkElement.text().trim();
    if (!title || !href) return;
    try { const url = new URL(href, baseUrl).toString(); results.push({ id: entry.find("guid, id").first().text().trim() || url, title, url }); } catch { /* ignore malformed feed entries */ }
  });
  return results;
}

async function pollLibrary(library: LibraryRegistration): Promise<SearchResult[]> {
  const base = new URL(library.url);
  const marker = base.pathname.toLowerCase().indexOf("/opac/");
  const opacRoot = marker >= 0 ? base.pathname.slice(0, marker + "/opac/".length) : "/opac/";
  const candidates = [`${opacRoot}Newly_arrived`, `${opacRoot}rss`, "/rss.xml", "/feed.xml"].map((path) => new URL(path, base).toString());
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(4000), headers: { accept: "application/rss+xml,application/atom+xml,text/html,text/xml", "user-agent": "tosyokan-bot/0.1" } });
      if (response.ok) {
        const body = await response.text();
        const results = parseFeed(body, candidate);
        const htmlResults = results.length ? results : parseSearchResults(body, candidate);
        if (htmlResults.length) return htmlResults;
      }
    } catch { /* try the next common feed path */ }
  }
  return searchLibrary(library, "新着");
}

async function processSubscriptions(env: Env["Bindings"], rest: any): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.kv.list({ prefix: SUBSCRIPTIONS_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const key of listed.keys) {
    const subscription = await env.kv.get(key.name, "json") as Subscription | null;
    if (!subscription) continue;
    subscription.seenByLibrary ??= {};
    const libraries = await readLibraries(env.kv, subscription.scope);
    for (const library of libraries) {
      if (subscription.libraryIds?.length && !subscription.libraryIds.includes(library.id)) continue;
      const updates = await pollLibrary(library);
      const previous = new Set(subscription.seenByLibrary[library.id] ?? []);
      const fresh = updates.filter((item) => !previous.has(item.id));
      subscription.seenByLibrary[library.id] = updates.map((item) => item.id).concat(subscription.seenByLibrary[library.id] ?? []).slice(0, 100);
      if (previous.size > 0 && fresh.length > 0) {
        const content = [`📚 **${library.label}** に新しい情報があります。`, ...fresh.slice(0, 5).map((item) => `・[${item.title}](${item.url})`)].join("\n");
        try { await postChannelMessage(rest, subscription.channelId, { content }); } catch { /* channel may have been deleted */ }
      }
    }
      await env.kv.put(key.name, JSON.stringify(subscription));
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

const providerInfoModal = makeModal("provider-info", "OPAC対応情報を提供", [
  makeLabel("サービス名・検索URL", makeTextInput("details", "OPACのサービス名や検索結果URL").required(true).max_length(1000)),
  makeLabel("チャンネル通知", makeTextInput("notify", "yes または no").required(false).max_length(10).placeholder("yes / no")),
]);

export const commands = [
  makeSlashCommand("ping", "接続状態を確認します"),
  makeSlashCommand("register", "図書館のURLを登録します").options([makeStringOption("url", "図書館システムのURL（https://example.jp）").required(true)]),
  makeSlashCommand("subscribe", "このチャンネルに図書館の更新を通知します").options([makeStringOption("library", "対象の図書館ID（省略すると全て）").required(false)]),
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
      const libraries = await readLibraries(c.env.kv, scope.key);
      const existing = libraries.find((library) => library.url === url);
      if (existing) return c.flags("EPHEMERAL").res(`既に登録済みです（${existing.id}）。\n${url}`);
      const registration: LibraryRegistration = { id: makeId(url), url, provider, label: displayHost(url), addedBy: actorId(c.interaction), createdAt: new Date().toISOString() };
      libraries.unshift(registration);
      await writeLibraries(c.env.kv, scope.key, libraries);
      return c.res(`✅ ${scope.label} に登録しました\n**${registration.label}**（${providerLabel(provider)}）\n${url}\nID: \`${registration.id}\`\n\`/subscribe\` で通知を有効にできます。`);
    } catch (error) { return c.flags("EPHEMERAL").res(`登録できませんでした: ${error instanceof Error ? error.message : "URLを確認してください。"}`); }
  })
  .command("subscribe", async (c) => {
    const scope = scopeFor(c.interaction);
    const channelId = c.interaction.channel_id;
    if (!channelId) return c.flags("EPHEMERAL").res("通知先チャンネルを特定できませんでした。");
    const libraries = await readLibraries(c.env.kv, scope.key);
    if (!libraries.length) return c.flags("EPHEMERAL").res("先に `/register url:...` で図書館を登録してください。");
    const requested = String(option(c, "library") ?? "").trim();
    const selected = requested ? libraries.find((library) => library.id === requested || library.label === requested) : undefined;
    if (requested && !selected) return c.flags("EPHEMERAL").res(`図書館IDが見つかりません。登録済み: ${libraries.map((library) => `\`${library.id}\``).join(", ")}`);
    const key = subscriptionKey(scope.key, channelId);
    const current = await c.env.kv.get(key, "json") as Subscription | null;
    const ids = selected ? Array.from(new Set([...(current?.libraryIds ?? []), selected.id])) : undefined;
    const subscription: Subscription = { scope: scope.key, channelId, libraryIds: ids, createdAt: current?.createdAt ?? new Date().toISOString(), seenByLibrary: current?.seenByLibrary };
    await c.env.kv.put(key, JSON.stringify(subscription));
    return c.res(`🔔 ${selected ? `**${selected.label}**` : "登録した図書館すべて"} の更新通知をこのチャンネルで受け取ります。`);
  })
  .command("search", async (c) => {
    const scope = scopeFor(c.interaction);
    const query = String(option(c, "query") ?? "").trim();
    const limit = Math.min(10, Math.max(1, Number(option(c, "limit") ?? 5)));
    if (!query) return c.flags("EPHEMERAL").res("検索語を入力してください。");
    return c.resDefer(async () => {
      const libraries = await readLibraries(c.env.kv, scope.key);
      if (!libraries.length) return c.followup("先に `/register` で図書館を登録してください。");
      const groups = await Promise.all(libraries.map(async (library) => ({ library, results: await searchLibrary(library, query) })));
      const lines = groups.flatMap(({ library, results }) => results.slice(0, limit).map((item) => `**${library.label}** · [${item.title}](${item.url})`));
      if (!lines.length) return c.followup(`「${query}」に一致する結果が見つかりませんでした。\n検索リンク: ${libraries.map((library) => `[${library.label}](${buildSearchUrl(library, query)})`).join(" / ")}`);
      const body = lines.slice(0, limit * libraries.length).join("\n");
      return c.followup(`🔎 「${query}」の検索結果\n${body.slice(0, 1850)}${body.length > 1850 ? "\n…（結果を一部省略）" : ""}`);
    });
  })
  .modal("provider-info", async (c) => {
    const scope = scopeFor(c.interaction);
    const userId = actorId(c.interaction);
    const pendingKey = pendingProviderKey(scope.key, userId);
    const pending = await c.env.kv.get(pendingKey, "json") as { scope: string; channelId?: string; userId: string; url: string } | null;
    if (!pending) return c.flags("EPHEMERAL").res("この入力フォームは期限切れです。もう一度 `/register` を実行してください。");
    const details = String(option(c, "details") ?? "").trim();
    if (!details) return c.flags("EPHEMERAL").res("対応情報が空です。もう一度入力してください。");
    const notifyValue = String(option(c, "notify") ?? "").trim().toLowerCase();
    const notifyChannel = /^(yes|y|true|1|はい|通知|する)$/i.test(notifyValue);
    const feedback: ProviderFeedback = { ...pending, details, notifyChannel, createdAt: new Date().toISOString() };
    await c.env.kv.put(`${PROVIDER_FEEDBACK_PREFIX}${scope.key}:${Date.now()}`, JSON.stringify(feedback));
    await c.env.kv.delete(pendingKey);
    if (notifyChannel && pending.channelId) {
      try { await postChannelMessage(c.rest, pending.channelId, { content: `📝 <@${userId}> さんから未対応OPACの情報提供を受け付けました。\n${pending.url}` }); } catch { /* channel may no longer be available */ }
    }
    return c.res(`情報を受け付けました。\n${notifyChannel ? "このチャンネルにも受付通知を送りました。" : "チャンネル通知は送信しませんでした。"}`);
  })
  .cron("*/15 * * * *", async (c) => processSubscriptions(c.env, c.rest));

export default app;
