#!/usr/bin/env node
// crypto: read-only view of the family's crypto accounts.
//
// - Coinbase: live, through the Coinbase App API, signed in either with
//   "Sign in with Coinbase" (OAuth, read scopes only, set up from nanou.ai by
//   the provisioner) or, for older setups, a "View"-only CDP secret API key
//   (ECDSA). Neither can trade, send or withdraw.
// - Kraken: live, through Kraken's spot REST API with a key the person
//   creates with only Query Funds and Query Ledger Entries. Only those read
//   endpoints are ever called; a key that can withdraw is refused (checked on
//   every read, since a key's permissions can be changed later on Kraken).
// - Nexo: Nexo has no API for its main app, so this reads the transaction
//   CSV exported from the app (Transactions → Export), imported once with
//   `crypto import-nexo <file.csv>`.
// - Wallets: watch-only addresses (EVM chains, Bitcoin, Solana) read from
//   public blockchains (see wallets.mjs), added with `crypto wallet add`.
//
// There is no command that moves money.
//
// Setup (server owner): `just crypto-setup <family> <cdp-key.json> [owner]`.
// State lives in ~/.config/family-crypto/ (protected from the agent):
//   coinbase-<owner>.json  { name, privateKey } as downloaded from the CDP portal
//   coinbase-oauth/<user id>.json  { id, owner, name, access_token, refresh_token, expires_at, scope }
//   coinbase-oauth/client.json     nanou's OAuth client, to refresh (Coinbase wants the secret)
//     Access tokens last an hour; Coinbase rotates the refresh token on every
//     refresh, so it happens under a lock file and is written atomically.
//   kraken-<owner>.json    { key, secret } as pasted on nanou.ai (sealed to the host)
//   nexo-<owner>.csv       the latest imported Nexo export
//   wallets.json           watched addresses [{ address, label, owner, chains? }]
//
// Output is JSON, so the agent can read it reliably.

import { createHash, createHmac, createPrivateKey, createSign, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressKind, CHAINS, walletHoldings } from "./wallets.mjs";

const HOST = process.env.FAMILY_COINBASE_HOST ?? "api.coinbase.com";
const API = process.env.FAMILY_COINBASE_API ?? `https://${HOST}`;
const TOKEN_URL = process.env.FAMILY_COINBASE_TOKEN_URL ?? "https://login.coinbase.com/oauth2/token";
const KRAKEN_API = process.env.FAMILY_KRAKEN_API ?? "https://api.kraken.com";
const DIR = process.env.FAMILY_CRYPTO_DIR ?? join(homedir(), ".config", "family-crypto");

const HELP = `crypto: read-only crypto accounts (Coinbase and Kraken live, Nexo from its CSV export, watched wallets)

  crypto accounts                                   what is connected, per owner
  crypto balances [--owner ana] [--source coinbase|kraken|nexo|wallet] [--currency EUR]
                                                    holdings and their value (Nexo: estimated from the export)
  crypto transactions [--owner ana] [--source coinbase|kraken|nexo] [--asset BTC]
                      [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--search text] [--limit 50]
  crypto prices BTC ETH [--currency EUR]            spot prices (public)
  crypto import-nexo <file.csv> [--owner ana]     store a Nexo transaction export
  crypto wallet add <address> --label "Ledger" [--owner ana] [--chains ethereum,base]
                                                    watch an address (0x… on ${Object.keys(CHAINS).join("/")}, Bitcoin, Solana)
  crypto wallet check <address> [--chains ethereum,base]
                                                    look at an address once, without watching it
  crypto wallet list | crypto wallet remove <address|label>

Read-only: nothing here can trade, send or withdraw.`;

/** @param {string} msg */
function fail(msg) {
  process.stdout.write(`${JSON.stringify({ error: msg }, null, 2)}\n`);
  process.exit(1);
}

/** @param {unknown} value */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Parse `--flag value` pairs and positional words.
 * @param {string[]} argv @returns {{ flags: Record<string, string>, words: string[] }}
 */
function parse(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? (k !== "help" && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
    } else words.push(a);
  }
  return { flags, words };
}

/** Owners with a file named `<prefix>-<owner><ext>`. @param {string} prefix @param {string} ext */
function owners(prefix, ext) {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(ext))
    .map((f) => f.slice(prefix.length + 1, -ext.length));
}

/** Owners to read for a source, honouring --owner. */
function selectOwners(prefix, ext, flags) {
  const all = owners(prefix, ext);
  return flags.owner ? all.filter((o) => o === flags.owner.toLowerCase()) : all;
}

// ---------------------------------------------------------------- Coinbase

const OAUTH_DIR = join(DIR, "coinbase-oauth");
/** Scopes a Coinbase sign-in may hold: reading only. */
const READ_SCOPES = new Set(["wallet:accounts:read", "wallet:transactions:read", "wallet:user:read"]);

/**
 * How one Coinbase login is read: a CDP key file, or an OAuth sign-in.
 * @typedef {{ kind: "key", owner: string, key: { name: string, privateKey: string } }
 *   | { kind: "oauth", owner: string, id: string, name: string | null }} CoinbaseLogin
 */

/** OAuth sign-ins in the container. @returns {Array<{ id: string, owner: string, name: string | null }>} */
function oauthLogins() {
  if (!existsSync(OAUTH_DIR)) return [];
  return readdirSync(OAUTH_DIR)
    .filter((f) => f.endsWith(".json") && f !== "client.json")
    .map((f) => {
      try {
        const t = JSON.parse(readFileSync(join(OAUTH_DIR, f), "utf8"));
        return { id: f.slice(0, -5), owner: String(t.owner ?? "family"), name: t.name ?? null };
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);
}

/** Every Coinbase login to read, honouring --owner. @returns {CoinbaseLogin[]} */
function coinbaseLogins(flags) {
  const want = flags.owner?.toLowerCase();
  return [
    ...selectOwners("coinbase", ".json", flags).map((owner) => ({ kind: /** @type {const} */ ("key"), owner, key: coinbaseKey(owner) })),
    ...oauthLogins()
      .filter((l) => !want || l.owner === want)
      .map((l) => ({ kind: /** @type {const} */ ("oauth"), ...l })),
  ];
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Hold `<file>.lock` while `fn` runs; a lock older than a minute is a crashed run's. @template T @param {string} file @param {() => Promise<T>} fn */
async function locked(file, fn) {
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
      if (i > 120) fail("another Coinbase refresh is stuck; try again in a minute");
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

const RECONNECT = "sign in to Coinbase again on nanou.ai → Connectors → Coinbase";

/**
 * A Coinbase access token with more than 2 minutes left, refreshed if needed.
 * Coinbase invalidates a refresh token once used, so concurrent runs wait on
 * the lock and re-read the file instead of refreshing twice.
 * @param {string} id
 */
async function oauthToken(id) {
  const file = join(OAUTH_DIR, `${id}.json`);
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const fresh = (/** @type {any} */ t) => t.access_token && Number(t.expires_at) - Date.now() / 1000 > 120;
  const first = read();
  if (fresh(first)) return first.access_token;
  return locked(file, async () => {
    const t = read();
    if (fresh(t)) return t.access_token;
    let client;
    try {
      client = JSON.parse(readFileSync(join(OAUTH_DIR, "client.json"), "utf8"));
    } catch {
      return fail(`the Coinbase sign-in of ${t.owner} can't be refreshed here (no client); ${RECONNECT}`);
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
      return fail(`Coinbase didn't answer the token refresh (${/** @type {Error} */ (err).message}); try again`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token || !j.refresh_token) {
      const reason = String(j.error ?? `HTTP ${res.status}`).slice(0, 60);
      return fail(reason === "invalid_grant" ? `Coinbase no longer accepts the sign-in of ${t.owner}; ${RECONNECT}` : `Coinbase refused the token refresh (${reason}); try again`);
    }
    const scopes = String(j.scope ?? t.scope ?? "").split(/[\s,]+/).filter(Boolean);
    if (!scopes.length || scopes.some((s) => !READ_SCOPES.has(s))) fail("Coinbase granted more than read-only access; refusing to use it");
    writeAtomic(file, { ...t, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), scope: scopes.join(","), refreshed_at: Math.floor(Date.now() / 1000) });
    return j.access_token;
  });
}

/** The Authorization header for one login and request. @param {CoinbaseLogin} login @param {string} path */
async function authHeader(login, path) {
  return login.kind === "key" ? `Bearer ${coinbaseJwt(login.key, "GET", path)}` : `Bearer ${await oauthToken(login.id)}`;
}

/** @param {string} owner @returns {{ name: string, privateKey: string }} */
function coinbaseKey(owner) {
  const key = JSON.parse(readFileSync(join(DIR, `coinbase-${owner}.json`), "utf8"));
  if (!key?.name || !key?.privateKey) fail(`coinbase key for ${owner} is incomplete; the server owner re-runs just crypto-setup`);
  return key;
}

/** base64url of a string or buffer. */
const b64u = (/** @type {string | Buffer} */ x) => Buffer.from(x).toString("base64url");

/** A 2-minute ES256 token for one request. @param {{ name: string, privateKey: string }} key @param {string} method @param {string} path */
function coinbaseJwt(key, method, path) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.name, nonce: randomBytes(16).toString("hex") }));
  const body = b64u(JSON.stringify({ iss: "cdp", sub: key.name, nbf: now, exp: now + 120, uri: `${method} ${HOST}${path.split("?")[0]}` }));
  const pem = createPrivateKey(key.privateKey.replace(/\\n/g, "\n"));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: pem, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

/**
 * GET from the Coinbase API, as one login (a key file or a sign-in), or public when null.
 * @param {string} path @param {CoinbaseLogin | null} login @returns {Promise<any>}
 */
async function coinbase(path, login) {
  const res = await fetch(`${API}${path}`, {
    headers: { ...(login ? { authorization: await authHeader(login, path) } : {}), "cb-version": "2024-10-01" },
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
      fail(login?.kind === "oauth" ? `Coinbase refused the sign-in of ${login.owner} (HTTP 401: ${detail}); ${RECONNECT}.` : `Coinbase refused the key (HTTP 401: ${detail}). The server owner re-runs just crypto-setup.`);
    }
    fail(`Coinbase GET ${path.split("?")[0]} failed: HTTP ${res.status} ${detail}`);
  }
  return json;
}

/** Every page of a v2 list. @param {string} path @param {CoinbaseLogin} key @param {number} max */
async function coinbaseAll(path, key, max = 1000) {
  const out = [];
  let next = path;
  while (next && out.length < max) {
    const page = await coinbase(next, key);
    out.push(...(page.data ?? []));
    next = page.pagination?.next_uri || null;
  }
  return out;
}

/** Units of each asset per one `currency` (public). @param {string} currency */
async function rates(currency) {
  const r = await coinbase(`/v2/exchange-rates?currency=${encodeURIComponent(currency)}`, null);
  return /** @type {Record<string, string>} */ (r.data?.rates ?? {});
}

/** Value of `amount` of `asset` in the rates' currency, or null. */
function value(amount, asset, table) {
  const rate = Number(table[asset]);
  return rate > 0 ? Math.round((amount / rate) * 100) / 100 : null;
}

/** Coinbase wallets with a balance. @param {CoinbaseLogin} login @param {Record<string, string>} table @param {string} currency */
async function coinbaseBalances(login, table, currency) {
  const { owner } = login;
  const accounts = await coinbaseAll("/v2/accounts?limit=100", login);
  return accounts
    .map((a) => ({ amount: Number(a.balance?.amount ?? 0), asset: a.balance?.currency ?? a.currency?.code, name: a.name }))
    .filter((a) => a.amount !== 0)
    .map((a) => ({ source: "coinbase", owner, asset: a.asset, amount: a.amount, [`value${currency}`]: value(a.amount, a.asset, table), wallet: a.name }));
}

/** Coinbase transactions across wallets, newest first. @param {CoinbaseLogin} login */
async function coinbaseTransactions(login, flags) {
  const { owner } = login;
  const key = login;
  const accounts = (await coinbaseAll("/v2/accounts?limit=100", key)).filter(
    (a) => !flags.asset || (a.currency?.code ?? a.balance?.currency) === flags.asset.toUpperCase(),
  );
  const out = [];
  for (const a of accounts) {
    // Skip wallets that never held anything (most of the list).
    if (Number(a.balance?.amount ?? 0) === 0 && !a.updated_at) continue;
    const txs = await coinbaseAll(`/v2/accounts/${a.id}/transactions?limit=100&order=desc`, key, 300);
    for (const t of txs) {
      out.push({
        source: "coinbase",
        owner,
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
}

// ---------------------------------------------------------------- Kraken

/** The only Kraken endpoints this tool calls: reads, plus the withdrawal probe. */
const KRAKEN_READ = new Set(["BalanceEx", "Ledgers", "WithdrawMethods"]);
const KRAKEN_RECONNECT = "paste a new key on nanou.ai → Connectors → Kraken";

/** @param {string} owner @returns {{ key: string, secret: string }} */
function krakenKey(owner) {
  const k = JSON.parse(readFileSync(join(DIR, `kraken-${owner}.json`), "utf8"));
  if (!k?.key || !k?.secret) fail(`the Kraken key of ${owner} is incomplete; ${KRAKEN_RECONNECT}`);
  return k;
}

let lastNonce = 0n;
/** Kraken wants every nonce of a key to be larger than the last: microseconds, kept increasing. */
function krakenNonce() {
  const now = BigInt(Date.now()) * 1000n + BigInt(process.hrtime()[1] % 1000);
  lastNonce = now > lastNonce ? now : lastNonce + 1n;
  return lastNonce.toString();
}

/**
 * API-Sign: HMAC-SHA512 of the path and SHA256(nonce + body), keyed with the decoded secret.
 * @param {string} path @param {string} nonce @param {string} body @param {string} secret
 */
function krakenSign(path, nonce, body, secret) {
  const digest = createHash("sha256").update(nonce + body).digest();
  return createHmac("sha512", Buffer.from(secret, "base64")).update(Buffer.concat([Buffer.from(path), digest])).digest("base64");
}

/**
 * POST a private Kraken read. Returns `{ result }` or `{ error }` (Kraken's error words).
 * @param {string} endpoint @param {Record<string, string>} params @param {string} owner
 */
async function krakenPrivate(endpoint, params, owner) {
  if (!KRAKEN_READ.has(endpoint)) fail(`refusing to call Kraken ${endpoint}: only reads are allowed`);
  const key = krakenKey(owner);
  const path = `/0/private/${endpoint}`;
  for (let attempt = 0; ; attempt++) {
    const nonce = krakenNonce();
    const body = new URLSearchParams({ nonce, ...params }).toString();
    let res;
    try {
      res = await fetch(`${KRAKEN_API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "API-Key": key.key, "API-Sign": krakenSign(path, nonce, body, key.secret) },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return fail(`Kraken didn't answer (${/** @type {Error} */ (err).message}); try again`);
    }
    const j = await res.json().catch(() => ({ error: [`HTTP ${res.status}`] }));
    const errors = /** @type {string[]} */ (j.error ?? []);
    // Two reads at once with the same key can cross; one retry with a fresh nonce.
    if (errors.some((e) => /Invalid nonce/i.test(e)) && attempt === 0) continue;
    return errors.length ? { error: errors } : { result: j.result };
  }
}

/** Fails on a key Kraken refuses, and on a key that can withdraw. @param {string} owner */
async function krakenSafe(owner) {
  const probe = await krakenPrivate("WithdrawMethods", {}, owner);
  if (probe.result) fail(`the Kraken key of ${owner} can withdraw funds, so nanou won't use it. Create a key with only Query Funds and Query Ledger Entries and ${KRAKEN_RECONNECT}`);
  const err = probe.error?.join(", ") ?? "";
  if (/Invalid key|Invalid signature/i.test(err)) fail(`Kraken refused the key of ${owner} (${err}); ${KRAKEN_RECONNECT}`);
}

/** XXBT → BTC, ZEUR → EUR, ETH2.S → ETH2, XDG → DOGE: Kraken's codes as people know them. @param {string} code */
function krakenAsset(code) {
  let a = String(code).split(".")[0].toUpperCase();
  if (a.length === 4 && /^[XZ]/.test(a) && !["ZEUS"].includes(a)) a = a.slice(1);
  return { XBT: "BTC", XDG: "DOGE" }[a] ?? a;
}

/** Kraken holdings with a balance. @param {string} owner @param {Record<string, string>} table @param {string} currency */
async function krakenBalances(owner, table, currency) {
  await krakenSafe(owner);
  const r = await krakenPrivate("BalanceEx", {}, owner);
  if (r.error) fail(`Kraken balances failed: ${r.error.join(", ")}`);
  return Object.entries(r.result ?? {})
    .map(([code, b]) => ({ code, amount: Number(/** @type {any} */ (b).balance ?? 0) }))
    .filter((b) => b.amount !== 0)
    .map(({ code, amount }) => {
      const asset = krakenAsset(code);
      return { source: "kraken", owner, asset, amount, [`value${currency}`]: value(amount, asset, table), wallet: code.includes(".") ? "Earn" : "Spot" };
    });
}

/** Kraken ledger entries (deposits, trades, staking…), newest first, at most `max`. @param {string} owner */
/** Histories cut short at their cap, so `count` isn't taken for the whole history. */
const partial = [];

async function krakenTransactions(owner, flags, max = 300) {
  await krakenSafe(owner);
  /** @type {Record<string, string>} */
  const params = { with_cursor: "true" };
  if (flags.from) params.start = String(Math.floor(Date.parse(`${flags.from}T00:00:00Z`) / 1000) - 1);
  if (flags.to) params.end = String(Math.floor(Date.parse(`${flags.to}T23:59:59Z`) / 1000));
  const out = [];
  let cursor = null;
  do {
    const r = await krakenPrivate("Ledgers", cursor ? { ...params, cursor } : params, owner);
    if (r.error) fail(`Kraken history failed: ${r.error.join(", ")}`);
    for (const [id, e] of Object.entries(r.result?.ledger ?? {})) {
      const x = /** @type {any} */ (e);
      const asset = krakenAsset(x.asset);
      if (flags.asset && asset !== flags.asset.toUpperCase()) continue;
      out.push({
        source: "kraken",
        owner,
        date: new Date(Number(x.time) * 1000).toISOString(),
        type: [x.type, x.subtype].filter(Boolean).join(" "),
        asset,
        amount: Number(x.amount),
        fee: Number(x.fee) || undefined,
        ref: x.refid ?? id,
      });
    }
    cursor = r.result?.cursor?.next ?? null;
  } while (cursor && out.length < max);
  if (cursor) partial.push(`kraken ${owner}: only the newest ${out.length} entries were read; use --from/--to for older ones`);
  return out;
}

// ---------------------------------------------------------------- Nexo

/** Minimal RFC 4180 CSV parser. @param {string} text @returns {string[][]} */
function csv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** Rows of an owner's Nexo export as objects keyed by header. @param {string} owner */
function nexoRows(owner) {
  const path = join(DIR, `nexo-${owner}.csv`);
  const [header, ...rows] = csv(readFileSync(path, "utf8").replace(/^﻿/, ""));
  const dateCol = col(header, /date/i);
  const dates = dateCol ? rows.map((r) => r[header.findIndex((h) => h.trim() === dateCol)] ?? "").filter(Boolean).sort() : [];
  return {
    // The newest transaction in the file, else when it was imported.
    exported: dates.at(-1) ?? statSync(path).mtime.toISOString(),
    header,
    rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()]))),
  };
}

/** The column whose name matches. @param {string[]} header @param {RegExp} re */
const col = (header, re) => header.map((h) => h.trim()).find((h) => re.test(h));

/** Nexo transactions as normalised rows. @param {string} owner */
function nexoTransactions(owner) {
  const { header, rows, exported } = nexoRows(owner);
  const c = {
    date: col(header, /date/i),
    type: col(header, /^type$/i),
    inCur: col(header, /input currency/i),
    inAmt: col(header, /input amount/i),
    outCur: col(header, /output currency/i),
    outAmt: col(header, /output amount/i),
    usd: col(header, /usd|equivalent/i),
    details: col(header, /details/i),
  };
  return {
    exported,
    txs: rows.map((r) => ({
      source: "nexo",
      owner,
      date: c.date ? r[c.date] : undefined,
      type: c.type ? r[c.type] : undefined,
      in: c.inCur ? `${r[c.inAmt] ?? ""} ${r[c.inCur]}`.trim() : undefined,
      out: c.outCur ? `${r[c.outAmt] ?? ""} ${r[c.outCur]}`.trim() : undefined,
      usd: c.usd ? r[c.usd] : undefined,
      details: c.details ? r[c.details] : undefined,
      raw: c.type ? undefined : r,
    })),
  };
}

/** Nexo row types that convert one asset into another inside Nexo. */
const NEXO_EXCHANGES = new Set(["exchange", "exchange to withdraw", "exchange deposited on"]);
/** Nexo row types that only move funds between its own savings and term wallets. */
const NEXO_INTERNAL = /^(locking|unlocking) term deposit$/i;

/**
 * Holdings estimated from the export. In Nexo exports the Output Amount is
 * always positive and the direction is in the sign of the Input Amount:
 * - exchanges spend |input| of the input asset and credit the output asset
 *   (an output of 0, as in "Exchange Deposited On", credits |input| 1:1);
 * - term deposit locking/unlocking stays inside Nexo and is skipped;
 * - everything else (interest, top-ups, withdrawals, transfers to and from
 *   the Nexo Pro wallet) changes the input asset by the signed input amount.
 * Funds moved to Nexo Pro leave this estimate (Pro is a separate account).
 * @param {string} owner @param {Record<string, string>} table @param {string} currency
 */
function nexoBalances(owner, table, currency) {
  const { txs, exported } = nexoTransactions(owner);
  /** @type {Record<string, number>} */
  const held = {};
  const add = (/** @type {string} */ asset, /** @type {number} */ n) => (held[asset] = (held[asset] ?? 0) + n);
  const num = (/** @type {string | undefined} */ s) => Number(String(s ?? "").replace(/[^0-9.eE+\-]/g, "")) || 0;
  let toPro = 0;
  for (const t of txs) {
    const [inAmt, inCur] = (t.in ?? "").split(" ");
    const [outAmt, outCur] = (t.out ?? "").split(" ");
    const type = String(t.type ?? "").trim().toLowerCase();
    if (!/^approved/i.test(t.details ?? "approved") || NEXO_INTERNAL.test(type) || !inCur) continue;
    if (NEXO_EXCHANGES.has(type)) {
      add(inCur, -Math.abs(num(inAmt)));
      if (outCur) add(outCur, num(outAmt) > 0 ? num(outAmt) : Math.abs(num(inAmt)));
    } else {
      add(inCur, num(inAmt));
      if (type === "transfer to pro wallet") toPro++;
    }
  }
  // A clearly negative net means the export misses rows for that asset.
  const gaps = Object.entries(held)
    .filter(([, amount]) => amount < -0.01)
    .map(([asset, amount]) => `${Math.round(amount * 100) / 100} ${asset}`);
  return Object.entries(held)
    .filter(([, amount]) => amount > 1e-6)
    .map(([asset, amount]) => ({
      source: "nexo",
      owner,
      asset,
      amount: Math.round(amount * 1e8) / 1e8,
      [`value${currency}`]: value(amount, asset.replace(/X$/, ""), table),
      estimatedFrom: `export of ${exported.slice(0, 10)}`,
      ...(toPro ? { note: "excludes funds moved to Nexo Pro" } : {}),
      ...(gaps.length ? { gaps: `the export doesn't add up for ${gaps.join(", ")}; figures may be incomplete` } : {}),
    }));
}

// ---------------------------------------------------------------- wallets

/** @typedef {{ address: string, label: string, owner: string, chains?: string[], added: string }} Wallet */

/** @returns {Wallet[]} */
function loadWallets() {
  const path = join(DIR, "wallets.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

/** Atomic, owner-only write. @param {Wallet[]} wallets */
function saveWallets(wallets) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const path = join(DIR, "wallets.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(wallets, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Valued holdings of every watched wallet matching --owner. */
async function walletBalances(flags, table, currency) {
  const wallets = loadWallets().filter((w) => !flags.owner || w.owner === flags.owner.toLowerCase());
  const results = await Promise.all(wallets.map(async (w) => ({ w, ...(await walletHoldings(w)) })));
  const holdings = [];
  /** @type {string[]} */
  const errors = [];
  for (const { w, holdings: hs, errors: es } of results) {
    for (const h of hs) {
      holdings.push({ source: "wallet", owner: w.owner, asset: h.asset, amount: Math.round(h.amount * 1e8) / 1e8, [`value${currency}`]: value(h.amount, h.asset, table), wallet: w.label, chain: h.chain });
    }
    for (const e of es) errors.push(`${w.label} ${e}`);
  }
  return { holdings, errors };
}

// ---------------------------------------------------------------- commands

/** @param {string} source @param {Record<string, string>} flags */
const wants = (source, flags) => !flags.source || flags.source.toLowerCase() === source;

/** Whether a date string falls in --from/--to. */
function inRange(date, flags) {
  const d = String(date ?? "").slice(0, 10);
  return (!flags.from || d >= flags.from) && (!flags.to || d <= flags.to);
}

async function main() {
  const { flags, words } = parse(process.argv.slice(2));
  const [cmd, ...rest] = words;
  if (!cmd || flags.help) return console.log(HELP);
  const currency = (flags.currency ?? "EUR").toUpperCase();

  if (cmd === "accounts") {
    return print({
      coinbase: [...owners("coinbase", ".json"), ...oauthLogins().map((l) => l.owner)].filter((o, i, all) => all.indexOf(o) === i),
      coinbaseSignIns: oauthLogins().map((l) => ({ owner: l.owner, name: l.name })),
      kraken: owners("kraken", ".json"),
      nexo: owners("nexo", ".csv").map((o) => ({ owner: o, imported: statSync(join(DIR, `nexo-${o}.csv`)).mtime.toISOString().slice(0, 10) })),
      wallets: loadWallets().map((w) => ({ label: w.label, owner: w.owner, address: w.address })),
      ...(owners("coinbase", ".json").length + oauthLogins().length + owners("kraken", ".json").length + owners("nexo", ".csv").length + loadWallets().length === 0
        ? { note: "Nothing connected yet. Coinbase: each person signs in on nanou.ai → Connectors → Coinbase. Kraken: each person pastes a read-only key on nanou.ai → Connectors → Kraken. Nexo: send the app's transaction CSV export and run crypto import-nexo. Wallets: anyone can send a public address in chat (crypto wallet check, then wallet add)." }
        : {}),
    });
  }

  if (cmd === "prices") {
    if (!rest.length) fail("name at least one asset, e.g. crypto prices BTC ETH");
    const table = await rates(currency);
    return print(Object.fromEntries(rest.map((a) => [a.toUpperCase(), value(1, a.toUpperCase(), table)])));
  }

  if (cmd === "balances") {
    const table = await rates(currency);
    const out = [];
    if (wants("coinbase", flags)) for (const l of coinbaseLogins(flags)) out.push(...(await coinbaseBalances(l, table, currency)));
    if (wants("kraken", flags)) for (const o of selectOwners("kraken", ".json", flags)) out.push(...(await krakenBalances(o, table, currency)));
    if (wants("nexo", flags)) for (const o of selectOwners("nexo", ".csv", flags)) out.push(...nexoBalances(o, table, currency));
    /** @type {string[]} */
    let errors = [];
    if (wants("wallet", flags)) {
      const w = await walletBalances(flags, table, currency);
      out.push(...w.holdings);
      errors = w.errors;
    }
    if (!out.length && !errors.length && !coinbaseLogins(flags).length && !selectOwners("kraken", ".json", flags).length && !selectOwners("nexo", ".csv", flags).length && !loadWallets().length) {
      fail("no crypto account is connected for that owner; see crypto accounts");
    }
    const total = Math.round(out.reduce((s, b) => s + (b[`value${currency}`] ?? 0), 0) * 100) / 100;
    return print({ currency, [`total${currency}`]: total, holdings: out, ...(errors.length ? { errors } : {}) });
  }

  if (cmd === "transactions") {
    const limit = Number(flags.limit) || 50;
    const out = [];
    if (wants("coinbase", flags)) for (const l of coinbaseLogins(flags)) out.push(...(await coinbaseTransactions(l, flags)));
    if (wants("kraken", flags)) for (const o of selectOwners("kraken", ".json", flags)) out.push(...(await krakenTransactions(o, flags)));
    /** @type {Record<string, string>} */
    const exports = {};
    if (wants("nexo", flags)) {
      for (const o of selectOwners("nexo", ".csv", flags)) {
        const { txs, exported } = nexoTransactions(o);
        exports[o] = exported.slice(0, 10);
        out.push(...txs.filter((t) => !flags.asset || `${t.in} ${t.out}`.toUpperCase().includes(flags.asset.toUpperCase())));
      }
    }
    const needle = flags.search?.toLowerCase();
    const rows = out
      .filter((t) => inRange(t.date, flags))
      .filter((t) => !needle || JSON.stringify(t).toLowerCase().includes(needle))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return print({ count: rows.length, shown: Math.min(limit, rows.length), ...(partial.length ? { partial } : {}), ...(Object.keys(exports).length ? { nexoExports: exports } : {}), transactions: rows.slice(0, limit) });
  }

  if (cmd === "import-nexo") {
    const [file] = rest;
    if (!file || !existsSync(file)) fail("give the path of the Nexo CSV export");
    const [header] = csv(readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (!header || !header.some((h) => /type/i.test(h)) || !header.some((h) => /currency/i.test(h))) {
      fail("that doesn't look like a Nexo transaction export (expected columns like Type, Input Currency, Output Currency)");
    }
    const owner = String(flags.owner ?? "").toLowerCase();
    if (!owner) fail("say whose it is: --owner <name>");
    if (!/^[a-z0-9-]+$/.test(owner)) fail("owner must be a lowercase name");
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    copyFileSync(file, join(DIR, `nexo-${owner}.csv`));
    const { txs } = nexoTransactions(owner);
    return print({ ok: true, owner, rows: txs.length, newest: txs.map((t) => t.date).sort().at(-1), columns: header });
  }

  if (cmd === "wallet") {
    const [sub, target] = rest;
    const wallets = loadWallets();
    if (sub === "list" || !sub) return print(wallets);
    if (sub === "check") {
      const address = String(target ?? "").trim();
      const kind = addressKind(address);
      if (!kind) fail("that doesn't look like a 0x…, Bitcoin or Solana address");
      const chains = flags.chains ? flags.chains.split(",").map((c) => c.trim().toLowerCase()) : undefined;
      const unknown = (chains ?? []).filter((c) => !(c in CHAINS));
      if (kind === "evm" && unknown.length) fail(`unknown chain ${unknown.join(", ")}; known: ${Object.keys(CHAINS).join(", ")}`);
      const [{ holdings, errors }, table] = await Promise.all([walletHoldings({ address, ...(kind === "evm" && chains ? { chains } : {}) }), rates(currency)]);
      const valued = holdings.map((h) => ({ ...h, amount: Math.round(h.amount * 1e8) / 1e8, [`value${currency}`]: value(h.amount, h.asset, table) }));
      const total = Math.round(valued.reduce((s, h) => s + (h[`value${currency}`] ?? 0), 0) * 100) / 100;
      const watched = wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
      return print({ kind, address, currency, [`total${currency}`]: total, holdings: valued, watched: watched ? { label: watched.label, owner: watched.owner } : false, ...(errors.length ? { errors } : {}) });
    }
    if (sub === "add") {
      const address = String(target ?? "").trim();
      const kind = addressKind(address);
      if (!kind) fail("that doesn't look like a 0x…, Bitcoin or Solana address");
      if (wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) fail("already watched; see crypto wallet list");
      const owner = String(flags.owner ?? "").toLowerCase();
      if (!owner) fail("say whose it is: --owner <name>");
      if (!/^[a-z0-9-]+$/.test(owner)) fail("owner must be a lowercase name");
      const chains = flags.chains ? flags.chains.split(",").map((c) => c.trim().toLowerCase()) : undefined;
      const unknown = (chains ?? []).filter((c) => !(c in CHAINS));
      if (kind === "evm" && unknown.length) fail(`unknown chain ${unknown.join(", ")}; known: ${Object.keys(CHAINS).join(", ")}`);
      /** @type {Wallet} */
      const w = { address, label: String(flags.label ?? `${kind} ${address.slice(0, 6)}…${address.slice(-4)}`), owner, ...(kind === "evm" && chains ? { chains } : {}), added: new Date().toISOString().slice(0, 10) };
      saveWallets([...wallets, w]);
      const { holdings, errors } = await walletHoldings(w);
      return print({ ok: true, kind, wallet: w, holdings, ...(errors.length ? { errors } : {}) });
    }
    if (sub === "remove") {
      const t = String(target ?? "").toLowerCase();
      const kept = wallets.filter((w) => w.address.toLowerCase() !== t && w.label.toLowerCase() !== t);
      if (kept.length === wallets.length) fail(`no watched wallet ${target}`);
      saveWallets(kept);
      return print({ ok: true, removed: wallets.length - kept.length });
    }
    fail("crypto wallet check|add|list|remove");
  }

  fail(`unknown command ${cmd}\n\n${HELP}`);
}

main().catch((err) => fail(String(err?.message ?? err)));
