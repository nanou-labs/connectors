// Coinbase, for nanou's crypto runtime: balances and history through the
// Coinbase App API, read either with "Sign in with Coinbase" (OAuth, read
// scopes only) or with a "View"-only CDP secret API key (ECDSA). Neither can
// trade, send or withdraw. Self-contained: Node built-ins only.
//
// Files in the family's crypto folder (ctx.dir):
//   coinbase-<owner>.json          { name, privateKey } as downloaded from the CDP portal
//   coinbase-oauth/<user id>.json  { id, owner, name, access_token, refresh_token, expires_at, scope }
//   coinbase-oauth/client.json     nanou's OAuth client, to refresh (Coinbase wants the secret)
// Access tokens last an hour; Coinbase rotates the refresh token on every
// refresh, so it happens under a lock file and is written atomically.

import { createPrivateKey, createSign, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const HOST = process.env.FAMILY_COINBASE_HOST ?? "api.coinbase.com";
const API = process.env.FAMILY_COINBASE_API ?? `https://${HOST}`;
const TOKEN_URL = process.env.FAMILY_COINBASE_TOKEN_URL ?? "https://login.coinbase.com/oauth2/token";
/** Scopes a Coinbase sign-in may hold: reading only. */
const READ_SCOPES = new Set(["wallet:accounts:read", "wallet:transactions:read", "wallet:user:read"]);
const RECONNECT = "sign in to Coinbase again on nanou.ai → Connectors → Coinbase";

/**
 * One Coinbase login: a CDP key file, or an OAuth sign-in. Never holds the secret itself.
 * @typedef {{ owner: string, kind: "key" } | { owner: string, kind: "oauth", id: string, name: string | null }} Login
 */

const oauthDir = (/** @type {any} */ ctx) => join(ctx.dir, "coinbase-oauth");

/** OAuth sign-ins in the folder. @returns {Login[]} */
function oauthLogins(/** @type {any} */ ctx) {
  const dir = oauthDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "client.json")
    .map((f) => {
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return { owner: String(t.owner ?? "family"), kind: /** @type {const} */ ("oauth"), id: f.slice(0, -5), name: t.name ?? null };
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Hold `<file>.lock` while `fn` runs; a lock older than a minute is a crashed run's. @template T @param {any} ctx @param {string} file @param {() => Promise<T>} fn */
async function locked(ctx, file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock);
      } catch {
        /* gone already */
      }
      if (i > 120) ctx.fail("another Coinbase refresh is stuck; try again in a minute");
      await sleep(250);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already removed */
    }
  }
}

/** Write JSON readable only by the family, atomically (a crash leaves the old file). */
function writeAtomic(/** @type {string} */ file, /** @type {unknown} */ data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * A Coinbase access token with more than 2 minutes left, refreshed if needed.
 * Coinbase invalidates a refresh token once used, so concurrent runs wait on
 * the lock and re-read the file instead of refreshing twice.
 * @param {any} ctx @param {string} id
 */
async function oauthToken(ctx, id) {
  const file = join(oauthDir(ctx), `${id}.json`);
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const fresh = (/** @type {any} */ t) => t.access_token && Number(t.expires_at) - Date.now() / 1000 > 120;
  const first = read();
  if (fresh(first)) return first.access_token;
  return locked(ctx, file, async () => {
    const t = read();
    if (fresh(t)) return t.access_token;
    let client;
    try {
      client = JSON.parse(readFileSync(join(oauthDir(ctx), "client.json"), "utf8"));
    } catch {
      return ctx.fail(`the Coinbase sign-in of ${t.owner} can't be refreshed here (no client); ${RECONNECT}`);
    }
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id, client_secret: client.client_secret }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return ctx.fail(`Coinbase didn't answer the token refresh (${/** @type {Error} */ (err).message}); try again`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token || !j.refresh_token) {
      const reason = String(j.error ?? `HTTP ${res.status}`).slice(0, 60);
      return ctx.fail(reason === "invalid_grant" ? `Coinbase no longer accepts the sign-in of ${t.owner}; ${RECONNECT}` : `Coinbase refused the token refresh (${reason}); try again`);
    }
    const scopes = String(j.scope ?? t.scope ?? "").split(/[\s,]+/).filter(Boolean);
    if (!scopes.length || scopes.some((s) => !READ_SCOPES.has(s))) ctx.fail("Coinbase granted more than read-only access; refusing to use it");
    writeAtomic(file, { ...t, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), scope: scopes.join(","), refreshed_at: Math.floor(Date.now() / 1000) });
    return j.access_token;
  });
}

/** @param {any} ctx @param {string} owner @returns {{ name: string, privateKey: string }} */
function keyOf(ctx, owner) {
  const key = JSON.parse(readFileSync(join(ctx.dir, `coinbase-${owner}.json`), "utf8"));
  if (!key?.name || !key?.privateKey) ctx.fail(`the Coinbase key of ${owner} is incomplete; upload it again on nanou.ai → Connectors → Coinbase`);
  return key;
}

/** base64url of a string or buffer. */
const b64u = (/** @type {string | Buffer} */ x) => Buffer.from(x).toString("base64url");

/** A 2-minute ES256 token for one request. @param {{ name: string, privateKey: string }} key @param {string} method @param {string} path */
function jwt(key, method, path) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.name, nonce: randomBytes(16).toString("hex") }));
  const body = b64u(JSON.stringify({ iss: "cdp", sub: key.name, nbf: now, exp: now + 120, uri: `${method} ${HOST}${path.split("?")[0]}` }));
  const pem = createPrivateKey(key.privateKey.replace(/\\n/g, "\n"));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: pem, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

/** The Authorization header for one login and request. @param {any} ctx @param {Login} login @param {string} path */
async function authHeader(ctx, login, path) {
  return login.kind === "key" ? `Bearer ${jwt(keyOf(ctx, login.owner), "GET", path)}` : `Bearer ${await oauthToken(ctx, login.id)}`;
}

/** GET from the Coinbase API as one login. @param {any} ctx @param {string} path @param {Login} login @returns {Promise<any>} */
async function get(ctx, path, login) {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: await authHeader(ctx, login, path), "cb-version": "2024-10-01" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const detail = json?.errors?.[0]?.message ?? json?.message ?? json?.raw ?? "";
    if (res.status === 401) {
      ctx.fail(login.kind === "oauth" ? `Coinbase refused the sign-in of ${login.owner} (HTTP 401: ${detail}); ${RECONNECT}.` : `Coinbase refused the key of ${login.owner} (HTTP 401: ${detail}); upload a new view-only key on nanou.ai → Connectors → Coinbase.`);
    }
    ctx.fail(`Coinbase GET ${path.split("?")[0]} failed: HTTP ${res.status} ${detail}`);
  }
  return json;
}

/** Every page of a v2 list. @param {any} ctx @param {string} path @param {Login} login @param {number} max */
async function all(ctx, path, login, max = 1000) {
  const out = [];
  let next = path;
  while (next && out.length < max) {
    const page = await get(ctx, next, login);
    out.push(...(page.data ?? []));
    next = page.pagination?.next_uri || null;
  }
  return out;
}

export default {
  help: [],
  howToConnect: ["Coinbase: each person signs in on nanou.ai → Connectors → Coinbase."],

  /** Key files and sign-ins; one person may have both. */
  accounts(/** @type {any} */ ctx) {
    const keys = existsSync(ctx.dir)
      ? readdirSync(ctx.dir)
          .filter((f) => /^coinbase-[a-z0-9-]+\.json$/.test(f))
          .map((f) => ({ owner: f.slice("coinbase-".length, -".json".length), kind: /** @type {const} */ ("key") }))
      : [];
    return [...keys, ...oauthLogins(ctx)];
  },

  /** Wallets with a balance. */
  async balances(/** @type {any} */ ctx, /** @type {Login} */ login) {
    const accounts = await all(ctx, "/v2/accounts?limit=100", login);
    return accounts
      .map((a) => ({ amount: Number(a.balance?.amount ?? 0), asset: a.balance?.currency ?? a.currency?.code, wallet: a.name }))
      .filter((a) => a.amount !== 0)
      .map((a) => ({ asset: a.asset, amount: a.amount, wallet: a.wallet }));
  },

  /** Transactions across wallets, at most 300 per wallet. */
  async transactions(/** @type {any} */ ctx, /** @type {Login} */ login, /** @type {{ asset?: string }} */ q) {
    const accounts = (await all(ctx, "/v2/accounts?limit=100", login)).filter((a) => !q.asset || (a.currency?.code ?? a.balance?.currency) === q.asset);
    const out = [];
    for (const a of accounts) {
      // Skip wallets that never held anything (most of the list).
      if (Number(a.balance?.amount ?? 0) === 0 && !a.updated_at) continue;
      const txs = await all(ctx, `/v2/accounts/${a.id}/transactions?limit=100&order=desc`, login, 300);
      for (const t of txs) {
        out.push({
          date: t.created_at,
          type: t.type,
          status: t.status,
          asset: t.amount?.currency,
          amount: Number(t.amount?.amount ?? 0),
          native: t.native_amount ? `${t.native_amount.amount} ${t.native_amount.currency}` : undefined,
          title: [t.details?.title, t.details?.subtitle].filter(Boolean).join(" · ") || t.description || undefined,
        });
      }
    }
    return out;
  },
};
