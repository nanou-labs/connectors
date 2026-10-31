// Slack: read a person's Slack workspace and, once approved on a card, post
// or react in it, with their own Slack user token. Run by nanou's cli runtime
// (runtime/cli/README.md) as the `slack` command: the runtime picks the
// account, reads the token and refuses `send` and `react` unless the gateway
// approved them.

const API = process.env.FAMILY_SLACK_API ?? "https://slack.com/api";

/**
 * @typedef {{ words: string[], flags: Record<string, string | true>, flag: (k: string) => string | undefined,
 *   secret: () => Record<string, any>, fail: (msg: string) => never,
 *   state: { get: (name: string, fallback: any) => any, set: (name: string, value: unknown) => void } }} Ctx
 */

/**
 * Call a Slack Web API method: GET for reads (query string), POST JSON for
 * writes. Waits and retries when rate limited.
 * @param {Ctx} ctx @param {string} method e.g. "conversations.history"
 * @param {Record<string, unknown>} [params] @param {{ write?: boolean }} [opts]
 */
async function slack(ctx, method, params = {}, opts = {}) {
  const headers = { authorization: `Bearer ${ctx.secret().token}` };
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (opts.write) {
      res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(params),
      });
    } else {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)]),
      );
      res = await fetch(`${API}/${method}?${qs}`, { headers });
    }
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 3) * 1000));
  }
  const body = await res.json();
  if (method === "auth.test") body.scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!body.ok) ctx.fail(`Slack ${method}: ${body.error ?? res.status}${body.needed ? ` (needs scope ${body.needed})` : ""}`);
  return body;
}

/** Page through a cursor-paginated list method. @param {Ctx} ctx @param {string} method @param {string} key */
async function all(ctx, method, key, params = {}, max = 2000) {
  const out = [];
  let cursor;
  do {
    const page = await slack(ctx, method, { limit: 200, ...params, cursor });
    out.push(...(page[key] ?? []));
    cursor = page.response_metadata?.next_cursor;
  } while (cursor && out.length < max);
  return out;
}

/**
 * The workspace's people (id → name), cached for a day in the account's state.
 * @param {Ctx} ctx @returns {Promise<Record<string, { name: string, handle: string, email?: string }>>}
 */
async function users(ctx) {
  const cache = ctx.state.get("users", null);
  if (cache && Date.now() - cache.at < 86_400_000) return cache.users;
  const list = await all(ctx, "users.list", "members");
  const map = Object.fromEntries(
    list.map((u) => [u.id, { name: u.profile?.real_name || u.real_name || u.name, handle: u.name, email: u.profile?.email }]),
  );
  ctx.state.set("users", { at: Date.now(), users: map });
  return map;
}

/** Channels and DMs the person is in, with readable names. @param {Ctx} ctx */
async function channels(ctx) {
  const dir = await users(ctx);
  const list = await all(ctx, "users.conversations", "channels", { types: "public_channel,private_channel,mpim,im", exclude_archived: true });
  return list.map((c) => ({
    id: c.id,
    name: c.is_im ? `@${dir[c.user]?.handle ?? c.user}` : `#${c.name}`,
    kind: c.is_im ? "dm" : c.is_mpim ? "group dm" : c.is_private ? "private" : "public",
    ...(c.is_im ? { with: dir[c.user]?.name } : {}),
  }));
}

/**
 * Resolve `#name`, `name`, `@handle`, an email or an id to a conversation id.
 * Opening a new DM is a write, so it is only done when `write` is set (an
 * approved `send`).
 * @param {Ctx} ctx @param {string} ref @param {boolean} [write]
 */
async function channelId(ctx, ref, write = false) {
  if (/^[CGD][A-Z0-9]{6,}$/.test(ref)) return ref;
  const mine = await channels(ctx);
  const want = ref.toLowerCase();
  const hit = mine.find((c) => c.name.toLowerCase() === want || c.name.toLowerCase() === `#${want}`);
  if (hit) return hit.id;
  const dir = await users(ctx);
  const userId = Object.entries(dir).find(
    ([, u]) =>
      `@${u.handle}`.toLowerCase() === want ||
      u.handle?.toLowerCase() === want.replace(/^@/, "") ||
      u.email?.toLowerCase() === want ||
      u.name?.toLowerCase() === want.replace(/^@/, ""),
  )?.[0];
  if (userId) {
    const dm = mine.find((c) => c.kind === "dm" && c.name === `@${dir[userId].handle}`);
    if (dm) return dm.id;
    if (!write) ctx.fail(`no DM with ${ref} yet; it will be opened when a message is sent`);
    return (await slack(ctx, "conversations.open", { users: userId }, { write: true })).channel.id;
  }
  ctx.fail(`no channel or person matches "${ref}" (see: slack channels --search, slack users --search)`);
}

/** Messages with names instead of ids, and ISO times. @param {Ctx} ctx @param {any[]} messages */
async function readable(ctx, messages) {
  const dir = await users(ctx);
  const name = (/** @type {string} */ id) => dir[id]?.name ?? id;
  return messages.map((m) => ({
    ts: m.ts,
    at: new Date(Number(m.ts) * 1000).toISOString(),
    from: m.user ? name(m.user) : (m.username ?? m.bot_profile?.name ?? "bot"),
    text: String(m.text ?? "").replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${name(id)}`),
    ...(m.reply_count ? { replies: m.reply_count, thread_ts: m.thread_ts } : {}),
    ...(m.files?.length ? { files: m.files.map((/** @type {any} */ f) => f.name) } : {}),
  }));
}

/** A --limit, capped. @param {Ctx} ctx @param {number} d */
const limit = (ctx, d) => Math.min(Number(ctx.flag("limit") ?? d) || d, 200);

export default {
  help: [
    "Read:",
    "  slack whoami                                   who the token belongs to, and what it can do",
    "  slack channels [--search text] [--limit 100]   channels, groups and DMs you are in",
    "  slack history --channel <#name|@user|id> [--limit 30] [--since YYYY-MM-DD]",
    "  slack thread --channel <#name|id> --ts <message ts>",
    "  slack search <query> [--limit 20]              Slack search syntax (from:@x in:#y after:2026-10-01)",
    "  slack users [--search text]",
    "Change (each one waits for an approval card):",
    '  slack send --channel <#name|@user|email|id> --text "..." [--thread-ts <ts>]',
    "  slack react --channel <#name|id> --ts <ts> --emoji thumbsup",
  ],
  commands: {
    /** @param {Ctx} ctx */
    async whoami(ctx) {
      const me = await slack(ctx, "auth.test");
      const has = (/** @type {string[]} */ ...need) => need.every((x) => me.scopes.includes(x));
      /** @type {Record<string, boolean>} */
      const features = {
        "channels (public)": has("channels:read"),
        "channels (private)": has("groups:read"),
        "DMs and group DMs": has("im:read", "mpim:read"),
        "read history": has("channels:history") || has("groups:history") || has("im:history"),
        search: has("search:read"),
        "people names": has("users:read"),
        "post messages": has("chat:write"),
        "open new DMs": has("im:write"),
        reactions: has("reactions:write"),
      };
      return {
        team: me.team,
        user: me.user,
        url: me.url,
        works: Object.keys(features).filter((k) => features[k]),
        missing: Object.keys(features).filter((k) => !features[k]),
        scopes: me.scopes,
      };
    },
    /** @param {Ctx} ctx */
    async channels(ctx) {
      const q = ctx.flag("search")?.toLowerCase();
      const list = (await channels(ctx)).filter((c) => !q || c.name.toLowerCase().includes(q) || c.with?.toLowerCase().includes(q));
      return list.slice(0, Number(ctx.flag("limit") ?? 100));
    },
    /** @param {Ctx} ctx */
    async history(ctx) {
      const ch = ctx.flag("channel");
      if (!ch) ctx.fail("history needs --channel");
      const since = ctx.flag("since");
      const res = await slack(ctx, "conversations.history", {
        channel: await channelId(ctx, ch),
        limit: limit(ctx, 30),
        oldest: since ? Date.parse(since) / 1000 : undefined,
      });
      return readable(ctx, res.messages.reverse());
    },
    /** @param {Ctx} ctx */
    async thread(ctx) {
      const ch = ctx.flag("channel");
      const ts = ctx.flag("ts");
      if (!ch || !ts) ctx.fail("thread needs --channel and --ts");
      const res = await slack(ctx, "conversations.replies", { channel: await channelId(ctx, ch), ts, limit: 200 });
      return readable(ctx, res.messages);
    },
    /** @param {Ctx} ctx */
    async search(ctx) {
      const query = ctx.words.join(" ") || ctx.flag("query");
      if (!query) ctx.fail("search needs a query");
      const res = await slack(ctx, "search.messages", { query, count: limit(ctx, 20), sort: "timestamp" });
      const hits = res.messages?.matches ?? [];
      const out = await readable(ctx, hits);
      return out.map((m, i) => ({ ...m, channel: hits[i].channel?.name ? `#${hits[i].channel.name}` : hits[i].channel?.id, link: hits[i].permalink }));
    },
    /** @param {Ctx} ctx */
    async users(ctx) {
      const q = ctx.flag("search")?.toLowerCase();
      const dir = await users(ctx);
      return Object.entries(dir)
        .map(([id, u]) => ({ id, ...u }))
        .filter((u) => !q || [u.name, u.handle, u.email].some((v) => v?.toLowerCase().includes(q)))
        .slice(0, 50);
    },
    /** @param {Ctx} ctx */
    async send(ctx) {
      const ch = ctx.flag("channel");
      const text = ctx.flag("text");
      if (!ch || !text) ctx.fail("send needs --channel and --text");
      const res = await slack(ctx, "chat.postMessage", { channel: await channelId(ctx, ch, true), text, thread_ts: ctx.flag("thread-ts") }, { write: true });
      const link = await slack(ctx, "chat.getPermalink", { channel: res.channel, message_ts: res.ts }).catch(() => null);
      return { sent: true, channel: res.channel, ts: res.ts, link: link?.permalink };
    },
    /** @param {Ctx} ctx */
    async react(ctx) {
      const ch = ctx.flag("channel");
      const ts = ctx.flag("ts");
      const emoji = ctx.flag("emoji");
      if (!ch || !ts || !emoji) ctx.fail("react needs --channel, --ts and --emoji");
      await slack(ctx, "reactions.add", { channel: await channelId(ctx, ch), timestamp: ts, name: emoji.replace(/:/g, "") }, { write: true });
      return { reacted: true };
    },
  },
};
