// Outlook: a person's Microsoft mail, calendars and OneDrive files through
// Microsoft Graph, with the access they gave nanou on Microsoft's own sign-in
// page (device code, no password and no client secret anywhere). Run by
// nanou's cli runtime (runtime/cli/README.md) as the `outlook` command: the
// runtime picks the account, reads its tokens and refuses every send or change
// unless the gateway approved that one command on its card.
//
// Tokens: ~/.config/connectors/outlook/<address>.json, written by nanou's host
// after the sign-in: { address, owner, client_id, scope, access_token,
// expires_at, refresh_token, connected_at }. Access lasts about an hour and is
// refreshed here, with the public client's id only; Microsoft hands a new
// refresh token each time and the file is replaced atomically.
//
// A reply, forward or event change names its target by an id nobody can read
// on a card, so the command also takes what the card shows (--to, --subject,
// --event) and checks it against the real message or event before acting:
// what the family approved is what happens, or nothing does.
//
// An upload sends one of nanou's own results (~/.nanou/workspace/out/, the
// only folder of the family's the jail lets it read, with `reads: results`)
// into the folder its card names, and never replaces a file already there.

const API = process.env.FAMILY_OUTLOOK_API ?? "https://graph.microsoft.com/v1.0";
const TOKEN_URL = process.env.FAMILY_OUTLOOK_TOKEN_URL ?? "https://login.microsoftonline.com/common/oauth2/v2.0/token";
/** What nanou's sign-in asks for (the manifest's auth.scope): the token file's own list wins. */
const SCOPE = "offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.ReadWrite";
/** Where nanou keeps what it made for the family: the only files an upload may send. */
const RESULTS = `${process.env.FAMILY_HOME ?? process.env.HOME ?? "/home/family"}/.nanou/workspace/out`;
/** Largest upload: Graph takes up to 250 MB in one request, nanou's results are far smaller. */
const UPLOAD_MAX = 25 * 1024 * 1024;
/** A OneDrive folder as a card shows it: "/Documents/School", no "..", none of OneDrive's forbidden characters. */
const DRIVE_PATH = /^\/?(?:[^/:*?"<>|\\]+\/?)*$/;
const REFRESH_MARGIN_S = 300;
const RECONNECT = "Reconnect it on nanou.ai → Connectors → Outlook.";
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const MAIL_FIELDS = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,webLink,importance";
const EVENT_FIELDS = "id,subject,start,end,isAllDay,location,organizer,attendees,isOnlineMeeting,onlineMeeting,showAs,responseStatus,webLink,bodyPreview,isCancelled,isOrganizer,seriesMasterId";
/** Folder names Graph knows in every mailbox. */
const WELL_KNOWN = { inbox: "inbox", sent: "sentitems", sentitems: "sentitems", drafts: "drafts", archive: "archive", deleted: "deleteditems", deleteditems: "deleteditems", junk: "junkemail", junkemail: "junkemail" };
const ANSWERS = { accept: "accept", yes: "accept", maybe: "tentativelyAccept", tentative: "tentativelyAccept", decline: "decline", no: "decline" };

/**
 * @typedef {{ words: string[], flags: Record<string, string | true>, flag: (k: string) => string | undefined,
 *   secret: () => Record<string, any>, saveSecret: (v: unknown) => void, owner: () => string, fail: (msg: string) => never }} Ctx
 */

const now = () => Math.floor(Date.now() / 1000);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** The access token in use this run, refreshed when it has under 5 minutes left. */
const tokens = new WeakMap();

/** @param {Ctx} ctx @param {boolean} [force] refresh even if it looks fresh (Graph said 401) */
async function token(ctx, force = false) {
  if (!force && tokens.has(ctx)) return tokens.get(ctx);
  const s = ctx.secret();
  if (!s?.access_token) ctx.fail(`the Outlook access of ${ctx.owner()} is unreadable. ${RECONNECT}`);
  if (!force && (!s.expires_at || s.expires_at - now() > REFRESH_MARGIN_S)) {
    tokens.set(ctx, s.access_token);
    return s.access_token;
  }
  if (!s.refresh_token || !s.client_id) ctx.fail(`the Outlook access of ${s.address ?? ctx.owner()} has expired. ${RECONNECT}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: s.client_id, grant_type: "refresh_token", refresh_token: s.refresh_token, scope: s.scope ?? SCOPE }),
  }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok || !body.access_token) {
    if (["invalid_grant", "interaction_required", "invalid_client", "unauthorized_client"].includes(body.error)) {
      ctx.fail(`the Outlook access of ${s.address ?? ctx.owner()} has expired or was revoked. ${RECONNECT}`);
    }
    ctx.fail(`Microsoft didn't renew the Outlook access (${body.error ?? res?.status ?? "no answer"}). Try again in a minute.`);
  }
  ctx.saveSecret({
    ...s,
    access_token: body.access_token,
    expires_at: now() + Number(body.expires_in ?? 3600),
    refresh_token: body.refresh_token ?? s.refresh_token,
  });
  tokens.set(ctx, body.access_token);
  return body.access_token;
}

/**
 * Call Microsoft Graph. Retries when throttled (429/503, Retry-After) and
 * renews the access once when Graph says it is no longer valid.
 * @param {Ctx} ctx @param {string} method @param {string} path "/me/messages", or a full nextLink on the API
 * @param {{ query?: Record<string, string | number | undefined>, body?: unknown, raw?: Uint8Array, headers?: Record<string, string> }} [opts]
 *   `raw`: bytes sent as they are (an upload), with their own content-type in `headers`
 * @returns {Promise<any>}
 */
async function graph(ctx, method, path, opts = {}) {
  const url = new URL(path.startsWith(API) ? path : `${API}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  let renewed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await token(ctx)}`,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
    if (res.status === 429 || res.status === 503) {
      await sleep(Math.min(Number(res.headers.get("retry-after") ?? 2), 30) * 1000);
      continue;
    }
    if (res.status === 401 && !renewed) {
      renewed = true;
      await token(ctx, true);
      continue;
    }
    if (res.status === 202 || res.status === 204) return {};
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const code = body?.error?.code ?? res.status;
    const message = String(body?.error?.message ?? "").slice(0, 200);
    if (res.status === 401) ctx.fail(`Microsoft no longer accepts the Outlook access. ${RECONNECT}`);
    if (res.status === 403) ctx.fail(`Outlook: not allowed (${code}). The account may not have given nanou that permission. ${RECONNECT}`);
    if (res.status === 404) ctx.fail(`Outlook: not found (${message || code}). Check the id with a read first.`);
    ctx.fail(`Outlook: ${message || code}`);
  }
  return ctx.fail("Outlook is busy (too many requests). Try again in a minute.");
}

/** Every page of a list, up to `max` items. @param {Ctx} ctx @param {string} path @param {Record<string, any>} query @param {number} max @param {Record<string, string>} [headers] */
async function list(ctx, path, query, max, headers) {
  /** @type {any[]} */
  const out = [];
  let page = await graph(ctx, "GET", path, { query, headers });
  out.push(...(page.value ?? []));
  while (out.length < max && typeof page["@odata.nextLink"] === "string" && page["@odata.nextLink"].startsWith(API)) {
    page = await graph(ctx, "GET", page["@odata.nextLink"], { headers });
    out.push(...(page.value ?? []));
  }
  return out.slice(0, max);
}

/** A --limit, capped. @param {Ctx} ctx @param {number} d @param {number} max */
const limit = (ctx, d, max) => Math.max(1, Math.min(Number(ctx.flag("limit") ?? d) || d, max));

/** "Ana <ana@x.com>" @param {any} r */
const who = (r) => {
  const a = r?.emailAddress ?? {};
  return a.name && a.address && a.name !== a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? "");
};

/** Addresses from "a@x.com, Ana <b@y.com>", checked. @param {Ctx} ctx @param {string | undefined} text @param {string} flag */
function addresses(ctx, text, flag) {
  if (!text) return [];
  const out = text
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (/<([^>]+)>/.exec(x)?.[1] ?? x).trim().toLowerCase());
  for (const a of out) if (!EMAIL.test(a)) ctx.fail(`${flag}: "${a}" isn't an email address`);
  return out;
}

const recipients = (/** @type {string[]} */ list) => list.map((address) => ({ emailAddress: { address } }));
const quote = (/** @type {string} */ s) => s.replace(/'/g, "''");
/** A subject without its Re:/Fw: prefixes, lowercased, for comparing what a card says with the real thing. @param {string} s */
const plainSubject = (s) =>
  String(s ?? "")
    .replace(/^\s*((re|fw|fwd|aw|wg|tr|rv|sv|vs|odp|r)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** A message as the person would describe it. @param {any} m */
const mailRow = (m) => ({
  id: m.id,
  at: m.receivedDateTime,
  from: who(m.from),
  to: (m.toRecipients ?? []).map(who),
  ...(m.ccRecipients?.length ? { cc: m.ccRecipients.map(who) } : {}),
  subject: m.subject ?? "",
  preview: m.bodyPreview ?? "",
  unread: m.isRead === false,
  ...(m.hasAttachments ? { attachments: true } : {}),
  ...(m.importance && m.importance !== "normal" ? { importance: m.importance } : {}),
  thread: m.conversationId,
  link: m.webLink,
});

/** An event in the asked time zone. @param {any} e */
const eventRow = (e) => ({
  id: e.id,
  subject: e.subject ?? "",
  start: e.isAllDay ? String(e.start?.dateTime ?? "").slice(0, 10) : String(e.start?.dateTime ?? "").slice(0, 16),
  end: e.isAllDay ? String(e.end?.dateTime ?? "").slice(0, 10) : String(e.end?.dateTime ?? "").slice(0, 16),
  timeZone: e.start?.timeZone,
  ...(e.isAllDay ? { allDay: true } : {}),
  ...(e.location?.displayName ? { where: e.location.displayName } : {}),
  organizer: who(e.organizer),
  ...(e.attendees?.length ? { guests: e.attendees.map((/** @type {any} */ a) => `${who(a)} (${a.status?.response ?? "none"})`) } : {}),
  ...(e.isOrganizer ? { mine: true } : { myAnswer: e.responseStatus?.response }),
  ...(e.onlineMeeting?.joinUrl ? { join: e.onlineMeeting.joinUrl } : {}),
  ...(e.isCancelled ? { cancelled: true } : {}),
  ...(e.seriesMasterId ? { recurring: true } : {}),
  preview: e.bodyPreview ?? "",
  link: e.webLink,
});

/** The offset of `tz` from UTC at a moment, in ms. @param {number} at @param {string} tz */
function offsetAt(at, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at;
}

/** A time zone name Intl knows, or a refusal. @param {Ctx} ctx @param {string | undefined} tz */
function zone(ctx, tz) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return ctx.fail(`--tz: "${tz}" isn't a time zone (use a name like Europe/Madrid)`);
  }
}

/**
 * A moment as UTC ISO: "2026-11-05T10:00:00Z" or "+01:00" as given, else a
 * wall-clock time (or a date's midnight) in `tz`.
 * @param {Ctx} ctx @param {string} text @param {string} tz @param {string} flag
 */
function toUtc(ctx, text, tz, flag) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text.trim());
  if (!m) ctx.fail(`${flag}: "${text}" isn't a date (YYYY-MM-DD) or a time (YYYY-MM-DDTHH:MM)`);
  if (m[7]) {
    const at = Date.parse(text.trim().replace(" ", "T"));
    if (Number.isNaN(at)) ctx.fail(`${flag}: "${text}" isn't a valid time`);
    return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  let at = wall - offsetAt(wall, tz);
  at = wall - offsetAt(at, tz); // twice, for a moment near a daylight-saving change
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * An event's start or end for Graph: an all-day date, a moment with an
 * offset (sent in UTC), or a wall-clock time in --tz.
 * @param {Ctx} ctx @param {string} text @param {string | undefined} tz @param {string} flag
 * @returns {{ dateTime: string, timeZone: string, allDay: boolean }}
 */
function when(ctx, text, tz, flag) {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { dateTime: `${t}T00:00:00`, timeZone: tz ?? "UTC", allDay: true };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(t)) return { dateTime: toUtc(ctx, t, "UTC", flag).slice(0, 19), timeZone: "UTC", allDay: false };
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(t);
  if (!m) ctx.fail(`${flag}: "${text}" isn't a date (YYYY-MM-DD) or a time (YYYY-MM-DDTHH:MM)`);
  if (!tz) ctx.fail(`${flag}: say which time zone ${t} is in with --tz (like Europe/Madrid), or give the time with its offset`);
  return { dateTime: `${m[1]}T${m[2]}${m[3] ?? ":00"}`, timeZone: tz, allDay: false };
}

/** The day after a YYYY-MM-DD. @param {string} d */
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A mail folder's id from a well-known name, an id, or its display name. @param {Ctx} ctx @param {string} ref */
async function folderId(ctx, ref) {
  const key = ref.toLowerCase().replace(/[\s_-]/g, "");
  if (key in WELL_KNOWN) return WELL_KNOWN[/** @type {keyof typeof WELL_KNOWN} */ (key)];
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(ref)) return ref;
  const all = await list(ctx, "/me/mailFolders", { $top: 100, $select: "id,displayName" }, 500);
  const hit = all.find((f) => String(f.displayName).toLowerCase() === ref.toLowerCase());
  if (!hit) ctx.fail(`no mail folder "${ref}" (see: outlook folders)`);
  return hit.id;
}

/** A calendar's path from its id or name (default: the main calendar). @param {Ctx} ctx @param {string | undefined} ref */
async function calendarPath(ctx, ref) {
  if (!ref) return "/me";
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(ref)) return `/me/calendars/${encodeURIComponent(ref)}`;
  const all = await list(ctx, "/me/calendars", { $top: 100, $select: "id,name" }, 500);
  const hit = all.find((c) => String(c.name).toLowerCase() === ref.toLowerCase());
  if (!hit) ctx.fail(`no calendar "${ref}" (see: outlook calendars)`);
  return `/me/calendars/${encodeURIComponent(hit.id)}`;
}

/** The id after the command. @param {Ctx} ctx @param {string} what */
function idOf(ctx, what) {
  const id = ctx.words[0];
  if (!id || !/^[A-Za-z0-9+/=_-]{8,}$/.test(id)) ctx.fail(`which ${what}? Give its id (from a read) right after the command`);
  return encodeURIComponent(id);
}

/** The signed-in address (the token file has it; Graph if not). @param {Ctx} ctx */
async function myAddress(ctx) {
  const s = ctx.secret();
  if (s.address) return String(s.address).toLowerCase();
  const me = await graph(ctx, "GET", "/me", { query: { $select: "mail,userPrincipalName" } });
  return String(me.mail ?? me.userPrincipalName ?? "").toLowerCase();
}

/**
 * The event the command names, checked against the title on its card
 * (--event): an approved change acts on exactly the event the family saw.
 * @param {Ctx} ctx
 */
async function namedEvent(ctx) {
  const id = idOf(ctx, "event");
  const title = ctx.flag("event");
  if (!title) ctx.fail("say which event by its current title too, with --event \"…\" (it shows on the card)");
  const e = await graph(ctx, "GET", `/me/events/${id}`, { query: { $select: "id,subject,isOrganizer,attendees,start" } });
  if (plainSubject(e.subject) !== plainSubject(title)) ctx.fail(`that event is "${e.subject}", not "${title}": nothing was changed`);
  return { id, event: e };
}

/**
 * The message a reply or forward is about, checked against --subject when the
 * card shows one.
 * @param {Ctx} ctx
 */
async function namedMessage(ctx) {
  const id = idOf(ctx, "message");
  const m = await graph(ctx, "GET", `/me/messages/${id}`, { query: { $select: "id,subject,from,replyTo,toRecipients,ccRecipients" } });
  const subject = ctx.flag("subject");
  if (subject && plainSubject(m.subject) !== plainSubject(subject)) ctx.fail(`that message is "${m.subject}", not "${subject}": nothing was sent`);
  return { id, message: m };
}

/** "Documents/School" for "/Documents/School/", checked; "" for the top. @param {Ctx} ctx @param {string | undefined} text @param {string} flag */
function drivePath(ctx, text, flag) {
  const t = String(text ?? "").trim();
  if (t.includes("..") || !DRIVE_PATH.test(t)) ctx.fail(`${flag} is a OneDrive folder like /Documents/School`);
  return t.replace(/^\/+|\/+$/g, "");
}

/** Graph's address of a folder by its path ("" is the top). @param {string} path */
const folderAt = (path) => (path ? `/me/drive/root:/${path.split("/").map(encodeURIComponent).join("/")}:` : "/me/drive/root");

const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) => a.length === b.length && a.every((x) => b.includes(x));

export default {
  help: [
    "Read:",
    "  outlook me                                     the signed-in Microsoft account",
    "  outlook mail [--folder inbox|sent|drafts|archive|<name>] [--search text] [--from addr] [--since YYYY-MM-DD] [--unread] [--thread <id>] [--limit 20]",
    "  outlook message <id>                           one message in full, with its attachments' names",
    "  outlook folders                                mail folders, with unread counts",
    "  outlook calendars                              calendars they can see",
    "  outlook events [--from YYYY-MM-DD] [--days 7 | --to YYYY-MM-DD] [--calendar <name>] [--search text] [--tz Europe/Madrid]",
    "  outlook event <id> [--tz Europe/Madrid]        one event in full",
    "  outlook files [--search text | --path /Documents] [--limit 30]   OneDrive files and their links",
    "  outlook drive [--path /Documents] [--depth 2]  OneDrive's folders, as a tree: where a new file fits",
    "Send or change (each one waits for an approval card):",
    '  outlook upload --file "Week plan.pdf" --folder "/Documents/School"',
    "      one of nanou's results (by its name in ~/.nanou/workspace/out) as a new file in that folder,",
    "      made if missing; never over a file already there. Prints its link",
    '  outlook send --to a@x.com[,b@y.com] [--cc …] [--bcc …] --subject "…" --body "…"',
    '  outlook reply <message id> --to <who the reply goes to> [--subject "<its subject>"] --body "…"',
    "      --to is checked: the sender alone replies to them, the sender and everyone else replies to all",
    '  outlook forward <message id> --to a@x.com [--subject "<its subject>"] [--body "…"]',
    '  outlook event add --subject "…" --start 2026-11-05T10:00 --end 2026-11-05T11:00 --tz Europe/Madrid [--calendar <name>] [--location "…"] [--attendees a@x.com,b@y.com] [--body "…"]',
    "      a date alone (--start 2026-11-05) is an all-day event; guests get an invitation from Outlook",
    '  outlook event update <id> --event "<its title now>" [--subject "…"] [--start …] [--end …] [--tz …] [--location "…"] [--body "…"]',
    '  outlook event delete <id> --event "<its title>"           (guests get a cancellation when it is theirs)',
    '  outlook event respond <id> --event "<its title>" --answer accept|maybe|decline [--comment "…"]',
  ],
  booleans: ["unread"],
  commands: {
    /** @param {Ctx} ctx */
    async me(ctx) {
      const me = await graph(ctx, "GET", "/me", { query: { $select: "displayName,mail,userPrincipalName" } });
      const s = ctx.secret();
      return { name: me.displayName, address: me.mail ?? me.userPrincipalName, owner: ctx.owner(), connectedAt: s.connected_at ? new Date(s.connected_at * 1000).toISOString() : undefined, can: String(s.scope ?? SCOPE).split(" ").filter((x) => x !== "offline_access") };
    },

    /** @param {Ctx} ctx */
    async folders(ctx) {
      const all = await list(ctx, "/me/mailFolders", { $top: 100, $select: "id,displayName,unreadItemCount,totalItemCount" }, 500);
      return all.map((f) => ({ id: f.id, name: f.displayName, unread: f.unreadItemCount, total: f.totalItemCount }));
    },

    /** @param {Ctx} ctx */
    async mail(ctx) {
      const n = limit(ctx, 20, 100);
      const search = ctx.flag("search");
      const folder = ctx.flag("folder");
      const from = ctx.flag("from");
      const since = ctx.flag("since");
      const thread = ctx.flag("thread");
      const unread = ctx.flags.unread === true;
      if (from && !EMAIL.test(from)) ctx.fail(`--from: "${from}" isn't an email address`);
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) ctx.fail("--since is a date, YYYY-MM-DD");
      const path = folder ? `/me/mailFolders/${encodeURIComponent(await folderId(ctx, folder))}/messages` : search || thread ? "/me/messages" : "/me/mailFolders/inbox/messages";
      /** @type {Record<string, string | number | undefined>} */
      const query = { $top: Math.min(n, 50), $select: MAIL_FIELDS };
      if (search) {
        // Graph's $search can't be combined with $filter or $orderby: --from and --since go into the search words.
        const words = [search.replace(/"/g, ""), from ? `from:${from}` : "", since ? `received>=${since}` : ""].filter(Boolean).join(" ");
        query.$search = `"${words}"`;
      } else if (thread) {
        query.$filter = `conversationId eq '${quote(thread)}'`;
      } else {
        // The sort property first in the filter, or Graph refuses it as inefficient.
        const filter = [`receivedDateTime ge ${since ?? "1900-01-01"}T00:00:00Z`];
        if (unread) filter.push("isRead eq false");
        if (from) filter.push(`from/emailAddress/address eq '${quote(from)}'`);
        query.$filter = filter.join(" and ");
        query.$orderby = "receivedDateTime desc";
      }
      let rows = (await list(ctx, path, query, thread ? 200 : n)).map(mailRow);
      if (search && unread) rows = rows.filter((r) => r.unread);
      if (thread) rows = rows.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-n);
      return rows;
    },

    /** @param {Ctx} ctx */
    async message(ctx) {
      const id = idOf(ctx, "message");
      const m = await graph(ctx, "GET", `/me/messages/${id}`, {
        query: { $select: `${MAIL_FIELDS},bccRecipients,replyTo,body` },
        headers: { prefer: 'outlook.body-content-type="text"' },
      });
      const files = m.hasAttachments ? await list(ctx, `/me/messages/${id}/attachments`, { $select: "name,contentType,size,isInline" }, 50) : [];
      const text = String(m.body?.content ?? "");
      return {
        ...mailRow(m),
        ...(m.replyTo?.length ? { replyTo: m.replyTo.map(who) } : {}),
        body: text.length > 20_000 ? `${text.slice(0, 20_000)}\n[… cut: ${text.length - 20_000} more characters]` : text,
        ...(files.length ? { attachments: files.filter((f) => !f.isInline).map((f) => ({ name: f.name, type: f.contentType, size: f.size })) } : {}),
      };
    },

    /** @param {Ctx} ctx */
    async calendars(ctx) {
      const all = await list(ctx, "/me/calendars", { $top: 100, $select: "id,name,canEdit,isDefaultCalendar,owner" }, 500);
      return all.map((c) => ({ id: c.id, name: c.name, ...(c.isDefaultCalendar ? { main: true } : {}), canEdit: c.canEdit, owner: who({ emailAddress: c.owner }) }));
    },

    /** @param {Ctx} ctx */
    async events(ctx) {
      const tz = zone(ctx, ctx.flag("tz")) ?? "UTC";
      const fromText = ctx.flag("from") ?? new Date().toISOString().slice(0, 10);
      const start = toUtc(ctx, fromText, tz, "--from");
      const toText = ctx.flag("to");
      const days = Math.max(1, Math.min(Number(ctx.flag("days") ?? 7) || 7, 366));
      const end = toText ? toUtc(ctx, /^\d{4}-\d{2}-\d{2}$/.test(toText) ? nextDay(toText) : toText, tz, "--to") : new Date(Date.parse(start) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      if (Date.parse(end) <= Date.parse(start)) ctx.fail("--to must come after --from");
      const base = await calendarPath(ctx, ctx.flag("calendar"));
      const all = await list(ctx, `${base}/calendarView`, { startDateTime: start, endDateTime: end, $top: 100, $select: EVENT_FIELDS, $orderby: "start/dateTime" }, limit(ctx, 50, 500), {
        prefer: `outlook.timezone="${tz}"`,
      });
      const q = ctx.flag("search")?.toLowerCase();
      return all.map(eventRow).filter((e) => !q || e.subject.toLowerCase().includes(q) || e.where?.toLowerCase().includes(q));
    },

    /** @param {Ctx} ctx */
    async event(ctx) {
      const id = idOf(ctx, "event");
      const tz = zone(ctx, ctx.flag("tz")) ?? "UTC";
      const e = await graph(ctx, "GET", `/me/events/${id}`, {
        query: { $select: `${EVENT_FIELDS},body` },
        headers: { prefer: `outlook.timezone="${tz}", outlook.body-content-type="text"` },
      });
      return { ...eventRow(e), body: String(e.body?.content ?? "").slice(0, 20_000) };
    },

    /** @param {Ctx} ctx */
    async files(ctx) {
      const n = limit(ctx, 30, 200);
      const search = ctx.flag("search");
      const path = ctx.flag("path");
      if (path && (path.includes("..") || !/^\/?[^:*?"<>|]*$/.test(path))) ctx.fail("--path is a OneDrive folder like /Documents/School");
      const at = search
        ? `/me/drive/root/search(q='${encodeURIComponent(quote(search))}')`
        : path && path.replace(/^\/+|\/+$/g, "")
          ? `/me/drive/root:/${path
              .replace(/^\/+|\/+$/g, "")
              .split("/")
              .map(encodeURIComponent)
              .join("/")}:/children`
          : "/me/drive/root/children";
      const all = await list(ctx, at, { $top: Math.min(n, 200), $select: "id,name,size,lastModifiedDateTime,webUrl,folder,file,parentReference" }, n);
      return all.map((f) => ({
        id: f.id,
        name: f.name,
        ...(f.folder ? { folder: true, items: f.folder.childCount } : { type: f.file?.mimeType, size: f.size }),
        modified: f.lastModifiedDateTime,
        ...(f.parentReference?.path ? { in: String(f.parentReference.path).replace(/^\/drive\/root:?/, "") || "/" } : {}),
        link: f.webUrl,
      }));
    },

    /**
     * The folders of their OneDrive, as a tree a few levels deep, with how many
     * items each holds: what nanou looks at before saving a file, so it goes
     * where the person keeps that kind of thing.
     * @param {Ctx} ctx
     */
    async drive(ctx) {
      const top = drivePath(ctx, ctx.flag("path"), "--path");
      const depth = Math.max(1, Math.min(Number(ctx.flag("depth") ?? 2) || 2, 3));
      let budget = 200;
      /** @param {string} path @param {number} level @returns {Promise<any[]>} */
      const walk = async (path, level) => {
        if (budget <= 0) return [];
        const items = await list(ctx, `${folderAt(path)}/children`, { $top: 200, $select: "name,folder,webUrl" }, 200);
        const folders = items.filter((f) => f.folder).slice(0, budget);
        budget -= folders.length;
        const out = [];
        for (const f of folders) {
          const at = path ? `${path}/${f.name}` : f.name;
          const inside = level < depth && f.folder.childCount > 0 ? await walk(at, level + 1) : [];
          out.push({ path: `/${at}`, items: f.folder.childCount, ...(inside.length ? { folders: inside } : {}) });
        }
        return out;
      };
      return { path: `/${top}`, folders: await walk(top, 1), ...(budget <= 0 ? { more: "only the first 200 folders: look deeper with --path" } : {}) };
    },

    /**
     * One of nanou's results into a OneDrive folder: `--file` names it inside
     * the results folder ("Week plan.pdf", "school/Trip.pdf"), as its card
     * shows it. Never over a file already there: Graph picks a new name.
     * @param {Ctx} ctx
     */
    async upload(ctx) {
      const { readFileSync, realpathSync, statSync } = await import("node:fs");
      const { basename, join } = await import("node:path");
      // Connected before OneDrive saving existed: Microsoft has to be asked once more.
      const scope = String(ctx.secret()?.scope ?? SCOPE);
      if (!/\bFiles\.ReadWrite\b/.test(scope)) {
        ctx.fail(`saving to OneDrive needs one more permission from ${ctx.owner()}: reconnect it once on nanou.ai → Connectors → Outlook (Microsoft asks to allow saving files), then try again.`);
      }
      const given = String(ctx.flag("file") ?? "").trim();
      if (!given || given.startsWith("/") || given.split("/").some((p) => p === "" || p === "." || p === "..")) {
        ctx.fail('--file is one of nanou\'s results by its name, like "Week plan.pdf"');
      }
      let results = RESULTS;
      let real = "";
      try {
        results = realpathSync(RESULTS);
        real = realpathSync(join(results, given));
      } catch {
        ctx.fail(`there is no ${given} in nanou's results`);
      }
      if (!real.startsWith(`${results}/`)) ctx.fail("only files nanou made can be uploaded");
      const st = statSync(real);
      if (!st.isFile()) ctx.fail(`${given} isn't a file`);
      if (st.size > UPLOAD_MAX) ctx.fail(`${given} is over ${UPLOAD_MAX / 1024 / 1024} MB`);
      const folder = drivePath(ctx, ctx.flag("folder"), "--folder");
      const name = basename(real);
      const target = folder ? `${folder}/${name}` : name;
      const f = await graph(ctx, "PUT", `/me/drive/root:/${target.split("/").map(encodeURIComponent).join("/")}:/content`, {
        query: { "@microsoft.graph.conflictBehavior": "rename" },
        raw: readFileSync(real),
        headers: { "content-type": "application/octet-stream" },
      });
      return { saved: true, name: f.name, folder: `/${folder}`, link: f.webUrl, ...(f.name !== name ? { renamed: `a file named ${name} was already there` } : {}) };
    },

    /** @param {Ctx} ctx */
    async send(ctx) {
      const to = addresses(ctx, ctx.flag("to"), "--to");
      const subject = ctx.flag("subject");
      const body = ctx.flag("body");
      if (!to.length || !subject || !body) ctx.fail('send needs --to, --subject and --body "…"');
      const cc = addresses(ctx, ctx.flag("cc"), "--cc");
      const bcc = addresses(ctx, ctx.flag("bcc"), "--bcc");
      await graph(ctx, "POST", "/me/sendMail", {
        body: {
          message: { subject, body: { contentType: "Text", content: body }, toRecipients: recipients(to), ccRecipients: recipients(cc), bccRecipients: recipients(bcc) },
          saveToSentItems: true,
        },
      });
      return { sent: true, to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject };
    },

    /** @param {Ctx} ctx */
    async reply(ctx) {
      const to = addresses(ctx, ctx.flag("to"), "--to");
      const body = ctx.flag("body");
      if (!to.length || !body) ctx.fail('reply needs --to (who it goes to) and --body "…"');
      const { id, message: m } = await namedMessage(ctx);
      const me = await myAddress(ctx);
      const addr = (/** @type {any[]} */ l) => (l ?? []).map((r) => String(r?.emailAddress?.address ?? "").toLowerCase()).filter(Boolean);
      const sender = addr(m.replyTo?.length ? m.replyTo : [m.from]);
      const everyone = [...new Set([...sender, ...addr(m.toRecipients), ...addr(m.ccRecipients)])].filter((a) => a !== me);
      const all = same(to, sender) ? false : same(to, everyone) ? true : null;
      if (all === null) {
        ctx.fail(`the reply would go to ${sender.join(", ")}${everyone.length > sender.length ? ` (or, to everyone: ${everyone.join(", ")})` : ""}, not ${to.join(", ")}: nothing was sent. To write to someone else, use outlook send or forward.`);
      }
      await graph(ctx, "POST", `/me/messages/${id}/${all ? "replyAll" : "reply"}`, { body: { comment: body } });
      return { sent: true, replied: all ? "all" : "sender", to, subject: m.subject };
    },

    /** @param {Ctx} ctx */
    async forward(ctx) {
      const to = addresses(ctx, ctx.flag("to"), "--to");
      if (!to.length) ctx.fail("forward needs --to");
      const { id, message: m } = await namedMessage(ctx);
      await graph(ctx, "POST", `/me/messages/${id}/forward`, { body: { toRecipients: recipients(to), comment: ctx.flag("body") ?? "" } });
      return { sent: true, forwarded: m.subject, to };
    },

    /** @param {Ctx} ctx */
    async "event add"(ctx) {
      const subject = ctx.flag("subject");
      const startText = ctx.flag("start");
      if (!subject || !startText) ctx.fail("event add needs --subject and --start (and --end, unless it is all day)");
      const tz = zone(ctx, ctx.flag("tz"));
      const start = when(ctx, startText, tz, "--start");
      const endText = ctx.flag("end") ?? (start.allDay ? nextDay(startText.trim()) : undefined);
      if (!endText) ctx.fail("event add needs --end (a time like 2026-11-05T11:00)");
      const end = when(ctx, endText, tz, "--end");
      if (start.allDay !== end.allDay) ctx.fail("--start and --end are both dates (all day) or both times");
      const guests = addresses(ctx, ctx.flag("attendees"), "--attendees");
      const location = ctx.flag("location");
      const body = ctx.flag("body");
      const base = await calendarPath(ctx, ctx.flag("calendar"));
      const e = await graph(ctx, "POST", `${base}/events`, {
        body: {
          subject,
          start: { dateTime: start.dateTime, timeZone: start.timeZone },
          end: { dateTime: end.dateTime, timeZone: end.timeZone },
          isAllDay: start.allDay,
          ...(location ? { location: { displayName: location } } : {}),
          ...(guests.length ? { attendees: guests.map((address) => ({ emailAddress: { address }, type: "required" })) } : {}),
          ...(body ? { body: { contentType: "Text", content: body } } : {}),
        },
      });
      return { saved: true, id: e.id, subject: e.subject, ...(guests.length ? { invited: guests } : {}), link: e.webLink };
    },

    /** @param {Ctx} ctx */
    async "event update"(ctx) {
      const { id } = await namedEvent(ctx);
      const tz = zone(ctx, ctx.flag("tz"));
      /** @type {Record<string, unknown>} */
      const patch = {};
      const subject = ctx.flag("subject");
      if (subject) patch.subject = subject;
      const startText = ctx.flag("start");
      const endText = ctx.flag("end");
      if (startText) {
        const s = when(ctx, startText, tz, "--start");
        patch.start = { dateTime: s.dateTime, timeZone: s.timeZone };
        patch.isAllDay = s.allDay;
      }
      if (endText) {
        const e = when(ctx, endText, tz, "--end");
        patch.end = { dateTime: e.dateTime, timeZone: e.timeZone };
      }
      if (startText && !endText) ctx.fail("a new --start needs its --end too");
      const location = ctx.flag("location");
      if (location) patch.location = { displayName: location };
      const body = ctx.flag("body");
      if (body) patch.body = { contentType: "Text", content: body };
      if (Object.keys(patch).length === 0) ctx.fail("nothing to change: give --subject, --start/--end, --location or --body");
      const e = await graph(ctx, "PATCH", `/me/events/${id}`, { body: patch });
      return { saved: true, id: e.id, subject: e.subject, link: e.webLink };
    },

    /** @param {Ctx} ctx */
    async "event delete"(ctx) {
      const { id, event } = await namedEvent(ctx);
      await graph(ctx, "DELETE", `/me/events/${id}`);
      return { deleted: true, subject: event.subject, ...(event.isOrganizer && event.attendees?.length ? { cancelledFor: event.attendees.map(who) } : {}) };
    },

    /** @param {Ctx} ctx */
    async "event respond"(ctx) {
      const answer = ANSWERS[/** @type {keyof typeof ANSWERS} */ (String(ctx.flag("answer") ?? "").toLowerCase())];
      if (!answer) ctx.fail("--answer is accept, maybe or decline");
      const { id, event } = await namedEvent(ctx);
      if (event.isOrganizer) ctx.fail(`"${event.subject}" is their own event: there is no invitation to answer`);
      const comment = ctx.flag("comment");
      await graph(ctx, "POST", `/me/events/${id}/${answer}`, { body: { sendResponse: true, ...(comment ? { comment } : {}) } });
      return { answered: answer, subject: event.subject };
    },
  },
};
