// Instagram: a person's own Instagram professional account (Creator or
// Business) through the Instagram API with Instagram Login, with the access
// they gave nanou on Instagram's own sign-in page. Run by nanou's cli runtime
// (runtime/cli/README.md) as the `instagram` command: the runtime picks the
// account, reads its token and refuses every post, reply or comment change
// unless the gateway approved that one command on its card.
//
// Token: ~/.config/connectors/instagram/<username>.json, written by nanou's
// host after the sign-in: { username, user_id, owner, scope, access_token,
// expires_at, refreshed_at, connected_at }. It is a long-lived token (60
// days). It is renewed here when it has under a week left and is at least a
// day old (Instagram's rule), with the token alone: no client secret in the
// family's container. Unused for 60 days, it expires and the person reconnects.
//
// Posting: Instagram fetches the photo or video itself from a public HTTPS
// address, so a post takes the address of a temporary nanou media link
// (`media-link <file>` in the family's container: an unguessable address that
// lasts an hour), never a link to anywhere else. A reply or a comment change
// names its comment by an id nobody can read on a card, so the command also
// takes who wrote it (--to / --from) and checks it against the real comment
// before acting: what the family approved is what happens, or nothing does.

const API = process.env.FAMILY_INSTAGRAM_API ?? "https://graph.instagram.com/v23.0";
const REFRESH_URL = process.env.FAMILY_INSTAGRAM_REFRESH_URL ?? "https://graph.instagram.com/refresh_access_token";
/** The only addresses a post may take its media from: nanou's temporary media links. */
const MEDIA_PREFIX = process.env.FAMILY_INSTAGRAM_MEDIA_PREFIX ?? "https://relay.nanou.ai/v1/media/";
const RECONNECT = "Reconnect it on nanou.ai → Connectors → Instagram.";
const DAY = 86_400;
/** Renew the token when it has less than this left (and is at least a day old). */
const RENEW_BEFORE_S = 7 * DAY;
/** How long a post waits for Instagram to finish processing its media, and how often it asks. */
const PROCESS_WAIT_MS = Number(process.env.FAMILY_INSTAGRAM_WAIT_MS ?? 240_000);
const PROCESS_POLL_MS = Number(process.env.FAMILY_INSTAGRAM_POLL_MS ?? 10_000);
const MAX_CAPTION = 2200;
const MAX_REPLY = 1000;
const MAX_CAROUSEL = 20;
const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url";
const COMMENT_FIELDS = "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}";

/**
 * @typedef {{ words: string[], flags: Record<string, string | true>, flag: (k: string) => string | undefined,
 *   secret: () => Record<string, any>, saveSecret: (v: unknown) => void, owner: () => string, fail: (msg: string) => never }} Ctx
 */

const now = () => Math.floor(Date.now() / 1000);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** The access token in use this run. */
const tokens = new WeakMap();

/** The account's token, renewed first when it is close to expiring. @param {Ctx} ctx */
async function token(ctx) {
  if (tokens.has(ctx)) return tokens.get(ctx);
  const s = ctx.secret();
  if (!s?.access_token) ctx.fail(`the Instagram access of ${ctx.owner()} is unreadable. ${RECONNECT}`);
  const t = now();
  if (s.expires_at && s.expires_at <= t) ctx.fail(`the Instagram access of @${s.username ?? ctx.owner()} has expired. ${RECONNECT}`);
  const age = t - Number(s.refreshed_at ?? s.connected_at ?? 0);
  if (s.expires_at && s.expires_at - t < RENEW_BEFORE_S && age >= DAY) {
    const url = new URL(REFRESH_URL);
    url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: s.access_token }).toString();
    const res = await fetch(url).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && body.access_token) {
      ctx.saveSecret({ ...s, access_token: body.access_token, expires_at: t + Number(body.expires_in ?? 60 * DAY), refreshed_at: t });
      tokens.set(ctx, body.access_token);
      return body.access_token;
    }
    // Still valid for now: carry on with it and try renewing next time.
  }
  tokens.set(ctx, s.access_token);
  return s.access_token;
}

/** The account's Instagram user id. @param {Ctx} ctx */
const me = (ctx) => {
  const id = String(ctx.secret()?.user_id ?? "");
  if (!/^[0-9]{1,32}$/.test(id)) ctx.fail(`the Instagram access of ${ctx.owner()} doesn't say which account it is. ${RECONNECT}`);
  return id;
};

/**
 * Call the Instagram API. Retries when throttled.
 * @param {Ctx} ctx @param {string} method @param {string} path "/me", "/<id>/media"
 * @param {Record<string, string | number | boolean | undefined>} [params] query for GET/DELETE, form for POST
 * @returns {Promise<any>}
 */
async function ig(ctx, method, path, params = {}) {
  const url = new URL(path.startsWith("https://") ? path : `${API}${path}`);
  const form = new URLSearchParams();
  // A paging link already carries its token; otherwise the token goes in the request, as Instagram documents it.
  const all = url.searchParams.has("access_token") ? params : { ...params, access_token: await token(ctx) };
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === "") continue;
    (method === "POST" ? form : url.searchParams).set(k, String(v));
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? form.toString() : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const e = body?.error ?? {};
    const code = Number(e.code ?? 0);
    // 4, 17, 32, 613: rate limits. Wait a little and try again, a few times.
    if ([4, 17, 32, 613].includes(code) || res.status === 429) {
      await sleep(Math.min(2000 * 2 ** attempt, 15_000));
      continue;
    }
    const message = String(e.error_user_msg ?? e.message ?? "").slice(0, 240);
    if (code === 190 || res.status === 401) ctx.fail(`Instagram no longer accepts the access of @${ctx.secret()?.username ?? ctx.owner()}. ${RECONNECT}`);
    if (code === 10 || code === 200 || res.status === 403) ctx.fail(`Instagram: not allowed (${message || code}). The account may not have given nanou that permission. ${RECONNECT}`);
    if (code === 100 && /does not exist|cannot be loaded|Unsupported get request/i.test(message)) ctx.fail(`Instagram: not found (${message}). Check the id with a read first.`);
    ctx.fail(`Instagram: ${message || `HTTP ${res.status}`}`);
  }
  return ctx.fail("Instagram is busy (too many requests). Try again in a few minutes.");
}

/** A --limit, capped. @param {Ctx} ctx @param {number} d @param {number} max */
const limit = (ctx, d, max) => Math.max(1, Math.min(Number(ctx.flag("limit") ?? d) || d, max));

/** An id word: Instagram ids are digits. @param {Ctx} ctx @param {number} i @param {string} what */
function idWord(ctx, i, what) {
  const id = ctx.words[i];
  if (!/^[0-9]{1,32}$/.test(id ?? "")) ctx.fail(`which ${what}? Give its id (from instagram media or instagram comments).`);
  return id;
}

/** "@ana" or "ana" → "ana". @param {string | undefined} v */
const handle = (v) => String(v ?? "").trim().replace(/^@/, "").toLowerCase();

/** One media item as the family reads it. @param {any} m */
const media = (m) => ({
  id: m.id,
  kind: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_product_type === "STORY" ? "story" : String(m.media_type ?? "").toLowerCase(),
  caption: m.caption ?? "",
  at: m.timestamp,
  link: m.permalink,
  likes: m.like_count,
  comments: m.comments_count,
});

/** One comment with its replies. @param {any} c @param {string} mine the account's username */
const comment = (c, mine) => {
  const replies = (c.replies?.data ?? []).map((/** @type {any} */ r) => ({ id: r.id, from: r.username, text: r.text, at: r.timestamp }));
  return {
    id: c.id,
    from: c.username,
    text: c.text,
    at: c.timestamp,
    likes: c.like_count,
    hidden: c.hidden || undefined,
    replies,
    answered: replies.some((/** @type {any} */ r) => handle(r.from) === mine),
  };
};

/** Every comment on one post, newest first, up to `max`. @param {Ctx} ctx @param {string} id @param {number} max */
async function commentsOf(ctx, id, max) {
  /** @type {any[]} */
  const out = [];
  let page = await ig(ctx, "GET", `/${id}/comments`, { fields: COMMENT_FIELDS, limit: Math.min(max, 50) });
  out.push(...(page.data ?? []));
  while (out.length < max && typeof page.paging?.next === "string" && page.paging.next.startsWith(new URL(API).origin)) {
    page = await ig(ctx, "GET", page.paging.next);
    out.push(...(page.data ?? []));
  }
  return out.slice(0, max);
}

/** Text compared loosely: case, spacing and quotes don't matter. @param {string | undefined} v */
const loose = (v) => String(v ?? "").toLowerCase().replace(/[\s"“”'‘’«»]+/g, " ").trim();

/**
 * The comment an id names, checked against what its card shows: who wrote it
 * (`--to` / `--from`) and its words (`--quote`, its start is enough).
 * @param {Ctx} ctx @param {string} id @param {string} flag
 */
async function checkedComment(ctx, id, flag) {
  const want = handle(ctx.flag(flag));
  if (!want) ctx.fail(`--${flag} must name who wrote the comment (its @username), so the card says whose comment it is.`);
  const quote = loose(ctx.flag("quote"));
  if (!quote) ctx.fail("--quote must give the comment's words (its start is enough), so the card shows which comment it is.");
  const c = await ig(ctx, "GET", `/${id}`, { fields: "id,text,username,hidden" });
  if (handle(c.username) !== want) ctx.fail(`that comment is by @${c.username}, not @${want}. Nothing was changed: check the comment with instagram comments.`);
  const text = loose(c.text);
  if (!text.startsWith(quote.slice(0, Math.max(1, Math.min(quote.length, 120))))) {
    ctx.fail(`that comment says "${String(c.text ?? "").slice(0, 80)}", not what --quote gives. Nothing was changed: check the comment with instagram comments.`);
  }
  return c;
}

/** A media link the post may use. @param {Ctx} ctx @param {string | undefined} v @param {string} flag */
function mediaUrl(ctx, v, flag) {
  const url = String(v ?? "").trim();
  if (!url) ctx.fail(`--${flag} is the temporary link of the file to post: make one with media-link <file>.`);
  if (!url.startsWith(MEDIA_PREFIX) || /\s/.test(url)) ctx.fail(`--${flag} must be a nanou media link (${MEDIA_PREFIX}…): make one with media-link <file>.`);
  return url;
}

/** The caption, checked. @param {Ctx} ctx */
function caption(ctx) {
  const c = ctx.flag("caption") ?? "";
  if (c.length > MAX_CAPTION) ctx.fail(`the caption is ${c.length} characters; Instagram takes at most ${MAX_CAPTION}.`);
  if ((c.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) ctx.fail("Instagram takes at most 30 hashtags in a caption.");
  return c;
}

/** Stop before a post when the account has used today's posts. @param {Ctx} ctx @param {string} uid */
async function roomToPost(ctx, uid) {
  const q = await ig(ctx, "GET", `/${uid}/content_publishing_limit`, { fields: "config,quota_usage" });
  const row = q.data?.[0] ?? {};
  const total = Number(row.config?.quota_total ?? 0);
  if (total && Number(row.quota_usage ?? 0) >= total) ctx.fail(`this account has posted ${row.quota_usage} times through apps in the last 24 hours, Instagram's limit. Try again later.`);
}

/** Wait until Instagram has processed a container, then publish it. @param {Ctx} ctx @param {string} uid @param {string} container */
async function publish(ctx, uid, container) {
  const until = Date.now() + PROCESS_WAIT_MS;
  for (;;) {
    const st = await ig(ctx, "GET", `/${container}`, { fields: "status_code,status" });
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") ctx.fail(`Instagram couldn't use that media (${String(st.status ?? st.status_code).slice(0, 160)}). Check the format: photos JPEG, reels MP4 or MOV, 3 s to 15 min.`);
    if (Date.now() > until) ctx.fail("Instagram is still processing the media. Nothing was posted: try again in a few minutes.");
    await sleep(PROCESS_POLL_MS);
  }
  const done = await ig(ctx, "POST", `/${uid}/media_publish`, { creation_id: container });
  const m = await ig(ctx, "GET", `/${done.id}`, { fields: MEDIA_FIELDS }).catch(() => ({ id: done.id }));
  return { posted: true, ...media(m) };
}

export default {
  help: [
    "Read:",
    "  instagram me                                  the connected account (username, kind, followers, posts)",
    "  instagram media [--limit 12]                  recent posts and reels, with links, likes and comment counts",
    "  instagram comments <post id> [--limit 50]     a post's comments and their replies",
    "  instagram comments [--since YYYY-MM-DD] [--posts 10]   comments on the recent posts, the unanswered first",
    "  instagram quota                               posts used of the last 24 hours' limit",
    "Post or change (each one waits for an approval card):",
    '  instagram post photo --url <media link> [--caption "…"]',
    '  instagram post carousel --urls <media link>,<media link>[,…] [--caption "…"]     2 to 20 photos or videos',
    '  instagram post reel --url <media link> [--caption "…"] [--cover <media link>] [--feed yes|no]',
    "      media links come from media-link <file>: photos are made JPEG, videos stay MP4/MOV",
    '  instagram reply <comment id> --to <@who wrote it> --quote "<its words>" --text "…"',
    '  instagram comment hide <comment id> --from <@who wrote it> --quote "<its words>"',
    '  instagram comment unhide <comment id> --from <@who wrote it> --quote "<its words>"',
    '  instagram comment delete <comment id> --from <@who wrote it> --quote "<its words>"',
    "      --to/--from and --quote are checked against the real comment: if they don't match, nothing changes",
  ],
  booleans: [],
  commands: {
    /** @param {Ctx} ctx */
    async me(ctx) {
      const m = await ig(ctx, "GET", "/me", { fields: "user_id,username,name,account_type,followers_count,follows_count,media_count" });
      const s = ctx.secret();
      return {
        username: m.username,
        name: m.name,
        kind: m.account_type === "MEDIA_CREATOR" ? "creator" : String(m.account_type ?? "").toLowerCase(),
        followers: m.followers_count,
        following: m.follows_count,
        posts: m.media_count,
        owner: ctx.owner(),
        expiresAt: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : undefined,
      };
    },

    /** @param {Ctx} ctx */
    async media(ctx) {
      const page = await ig(ctx, "GET", `/${me(ctx)}/media`, { fields: MEDIA_FIELDS, limit: limit(ctx, 12, 50) });
      return (page.data ?? []).map(media);
    },

    /** @param {Ctx} ctx */
    async comments(ctx) {
      const mine = handle(ctx.secret()?.username);
      if (ctx.words[0]) {
        const id = idWord(ctx, 0, "post");
        return (await commentsOf(ctx, id, limit(ctx, 50, 200))).map((c) => comment(c, mine));
      }
      const since = ctx.flag("since");
      if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) ctx.fail("--since is a date, YYYY-MM-DD.");
      const from = since ? Date.parse(`${since}T00:00:00Z`) : Date.now() - 3 * DAY * 1000;
      const posts = Math.max(1, Math.min(Number(ctx.flag("posts") ?? 10) || 10, 25));
      const recent = (await ig(ctx, "GET", `/${me(ctx)}/media`, { fields: MEDIA_FIELDS, limit: posts })).data ?? [];
      const out = [];
      for (const p of recent) {
        if (!p.comments_count) continue;
        for (const c of await commentsOf(ctx, p.id, 50)) {
          if (Date.parse(c.timestamp) < from || handle(c.username) === mine) continue;
          out.push({ post: { id: p.id, caption: String(p.caption ?? "").slice(0, 80), link: p.permalink }, ...comment(c, mine) });
        }
      }
      return out.sort((a, b) => Number(a.answered) - Number(b.answered) || Date.parse(b.at) - Date.parse(a.at));
    },

    /** @param {Ctx} ctx */
    async quota(ctx) {
      const q = await ig(ctx, "GET", `/${me(ctx)}/content_publishing_limit`, { fields: "config,quota_usage" });
      const row = q.data?.[0] ?? {};
      return { used: Number(row.quota_usage ?? 0), limit: Number(row.config?.quota_total ?? 0) || undefined, hours: row.config?.quota_duration ? Number(row.config.quota_duration) / 3600 : 24 };
    },

    /** @param {Ctx} ctx */
    async "post photo"(ctx) {
      const uid = me(ctx);
      const url = mediaUrl(ctx, ctx.flag("url"), "url");
      const text = caption(ctx);
      await roomToPost(ctx, uid);
      const c = await ig(ctx, "POST", `/${uid}/media`, { image_url: url, caption: text });
      return publish(ctx, uid, c.id);
    },

    /** @param {Ctx} ctx */
    async "post carousel"(ctx) {
      const uid = me(ctx);
      const urls = String(ctx.flag("urls") ?? "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean);
      if (urls.length < 2 || urls.length > MAX_CAROUSEL) ctx.fail(`--urls takes 2 to ${MAX_CAROUSEL} media links, separated by commas.`);
      const checked = urls.map((u) => mediaUrl(ctx, u, "urls"));
      const text = caption(ctx);
      await roomToPost(ctx, uid);
      const children = [];
      for (const u of checked) {
        const video = /\.(mp4|mov)(\?|$)/i.test(u);
        const child = await ig(ctx, "POST", `/${uid}/media`, video ? { media_type: "VIDEO", video_url: u, is_carousel_item: true } : { image_url: u, is_carousel_item: true });
        children.push(child.id);
      }
      const c = await ig(ctx, "POST", `/${uid}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: text });
      return publish(ctx, uid, c.id);
    },

    /** @param {Ctx} ctx */
    async "post reel"(ctx) {
      const uid = me(ctx);
      const url = mediaUrl(ctx, ctx.flag("url"), "url");
      const cover = ctx.flag("cover") === undefined ? undefined : mediaUrl(ctx, ctx.flag("cover"), "cover");
      const feed = ctx.flag("feed");
      if (feed !== undefined && !["yes", "no"].includes(feed)) ctx.fail("--feed is yes (also in the grid, the default) or no (Reels tab only).");
      const text = caption(ctx);
      await roomToPost(ctx, uid);
      const c = await ig(ctx, "POST", `/${uid}/media`, { media_type: "REELS", video_url: url, caption: text, cover_url: cover, share_to_feed: feed === "no" ? false : true });
      return publish(ctx, uid, c.id);
    },

    /** @param {Ctx} ctx */
    async reply(ctx) {
      const id = idWord(ctx, 0, "comment");
      const text = String(ctx.flag("text") ?? "").trim();
      if (!text) ctx.fail('--text is the reply: instagram reply <comment id> --to <@who> --quote "<their words>" --text "…"');
      if (text.length > MAX_REPLY) ctx.fail(`the reply is ${text.length} characters; keep it under ${MAX_REPLY}.`);
      const c = await checkedComment(ctx, id, "to");
      const r = await ig(ctx, "POST", `/${id}/replies`, { message: text });
      return { replied: true, id: r.id, to: c.username, comment: c.text };
    },

    /** @param {Ctx} ctx */
    async "comment hide"(ctx) {
      const id = idWord(ctx, 0, "comment");
      const c = await checkedComment(ctx, id, "from");
      await ig(ctx, "POST", `/${id}`, { hide: true });
      return { hidden: true, id, from: c.username, text: c.text };
    },

    /** @param {Ctx} ctx */
    async "comment unhide"(ctx) {
      const id = idWord(ctx, 0, "comment");
      const c = await checkedComment(ctx, id, "from");
      await ig(ctx, "POST", `/${id}`, { hide: false });
      return { hidden: false, id, from: c.username, text: c.text };
    },

    /** @param {Ctx} ctx */
    async "comment delete"(ctx) {
      const id = idWord(ctx, 0, "comment");
      const c = await checkedComment(ctx, id, "from");
      await ig(ctx, "DELETE", `/${id}`);
      return { deleted: true, id, from: c.username, text: c.text };
    },
  },
};
