// Kraken, for nanou's crypto runtime: balances and ledger entries through
// Kraken's spot REST API, with a key the person creates with only Query Funds
// and Query Ledger Entries. Only those read endpoints are ever called, and a
// key that can withdraw is refused, checked on every read since a key's
// permissions can change later on Kraken.
//
// The key is { key, secret } in <dir>/kraken-<owner>.json, saved there by
// nanou's installer from what the person pasted on nanou.ai (manifest:
// install.file). Self-contained: Node built-ins only.

import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.FAMILY_KRAKEN_API ?? "https://api.kraken.com";
/** The only Kraken endpoints called: reads, plus the withdrawal probe. */
const READ = new Set(["BalanceEx", "Ledgers", "WithdrawMethods"]);
const RECONNECT = "paste a new key on nanou.ai → Connectors → Kraken";
/** Ledger entries read per history, newest first; older ones need --from/--to. */
const MAX = 300;

/** @param {any} ctx @param {string} owner @returns {{ key: string, secret: string }} */
function keyOf(ctx, owner) {
  const k = JSON.parse(readFileSync(join(ctx.dir, `kraken-${owner}.json`), "utf8"));
  if (!k?.key || !k?.secret) ctx.fail(`the Kraken key of ${owner} is incomplete; ${RECONNECT}`);
  return k;
}

let lastNonce = 0n;
/** Kraken wants every nonce of a key to be larger than the last: microseconds, kept increasing. */
function nonce() {
  const now = BigInt(Date.now()) * 1000n + BigInt(process.hrtime()[1] % 1000);
  lastNonce = now > lastNonce ? now : lastNonce + 1n;
  return lastNonce.toString();
}

/**
 * API-Sign: HMAC-SHA512 of the path and SHA256(nonce + body), keyed with the decoded secret.
 * @param {string} path @param {string} n @param {string} body @param {string} secret
 */
export function sign(path, n, body, secret) {
  const digest = createHash("sha256").update(n + body).digest();
  return createHmac("sha512", Buffer.from(secret, "base64")).update(Buffer.concat([Buffer.from(path), digest])).digest("base64");
}

/**
 * POST a private Kraken read. Returns `{ result }` or `{ error }` (Kraken's error words).
 * @param {any} ctx @param {string} endpoint @param {Record<string, string>} params @param {string} owner
 */
async function call(ctx, endpoint, params, owner) {
  if (!READ.has(endpoint)) ctx.fail(`refusing to call Kraken ${endpoint}: only reads are allowed`);
  const key = keyOf(ctx, owner);
  const path = `/0/private/${endpoint}`;
  for (let attempt = 0; ; attempt++) {
    const n = nonce();
    const body = new URLSearchParams({ nonce: n, ...params }).toString();
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "API-Key": key.key, "API-Sign": sign(path, n, body, key.secret) },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return ctx.fail(`Kraken didn't answer (${/** @type {Error} */ (err).message}); try again`);
    }
    const j = await res.json().catch(() => ({ error: [`HTTP ${res.status}`] }));
    const errors = /** @type {string[]} */ (j.error ?? []);
    // Two reads at once with the same key can cross; one retry with a fresh nonce.
    if (errors.some((e) => /Invalid nonce/i.test(e)) && attempt === 0) continue;
    return errors.length ? { error: errors } : { result: j.result };
  }
}

/** Fails on a key Kraken refuses, and on a key that can withdraw. @param {any} ctx @param {string} owner */
async function safe(ctx, owner) {
  const probe = await call(ctx, "WithdrawMethods", {}, owner);
  if (probe.result) ctx.fail(`the Kraken key of ${owner} can withdraw funds, so nanou won't use it. Create a key with only Query Funds and Query Ledger Entries and ${RECONNECT}`);
  const err = probe.error?.join(", ") ?? "";
  if (/Invalid key|Invalid signature/i.test(err)) ctx.fail(`Kraken refused the key of ${owner} (${err}); ${RECONNECT}`);
}

/** XXBT → BTC, ZEUR → EUR, ETH2.S → ETH2, XDG → DOGE: Kraken's codes as people know them. @param {string} code */
export function asset(code) {
  let a = String(code).split(".")[0].toUpperCase();
  if (a.length === 4 && /^[XZ]/.test(a) && !["ZEUS"].includes(a)) a = a.slice(1);
  return { XBT: "BTC", XDG: "DOGE" }[a] ?? a;
}

export default {
  help: [],
  howToConnect: ["Kraken: each person pastes a read-only key on nanou.ai → Connectors → Kraken."],

  /** Who connected Kraken: one account per kraken-<owner>.json. */
  accounts(/** @type {any} */ ctx) {
    if (!existsSync(ctx.dir)) return [];
    return readdirSync(ctx.dir)
      .filter((f) => /^kraken-[a-z0-9-]+\.json$/.test(f))
      .map((f) => ({ owner: f.slice("kraken-".length, -".json".length) }));
  },

  /** Holdings with a balance; staked or Earn balances (ETH.F, DOT.S…) as wallet "Earn". */
  async balances(/** @type {any} */ ctx, /** @type {{ owner: string }} */ { owner }) {
    await safe(ctx, owner);
    const r = await call(ctx, "BalanceEx", {}, owner);
    if (r.error) ctx.fail(`Kraken balances failed: ${r.error.join(", ")}`);
    return Object.entries(r.result ?? {})
      .map(([code, b]) => ({ code, amount: Number(/** @type {any} */ (b).balance ?? 0) }))
      .filter((b) => b.amount !== 0)
      .map(({ code, amount }) => ({ asset: asset(code), amount, wallet: code.includes(".") ? "Earn" : "Spot" }));
  },

  /** Ledger entries (deposits, trades, staking…), at most MAX, with a note when the history goes further back. */
  async transactions(/** @type {any} */ ctx, /** @type {{ owner: string }} */ { owner }, /** @type {{ from?: string, to?: string, asset?: string }} */ q) {
    await safe(ctx, owner);
    /** @type {Record<string, string>} */
    const params = { with_cursor: "true" };
    if (q.from) params.start = String(Math.floor(Date.parse(`${q.from}T00:00:00Z`) / 1000) - 1);
    if (q.to) params.end = String(Math.floor(Date.parse(`${q.to}T23:59:59Z`) / 1000));
    const out = [];
    let cursor = null;
    do {
      const r = await call(ctx, "Ledgers", cursor ? { ...params, cursor } : params, owner);
      if (r.error) ctx.fail(`Kraken history failed: ${r.error.join(", ")}`);
      for (const [id, e] of Object.entries(r.result?.ledger ?? {})) {
        const x = /** @type {any} */ (e);
        const a = asset(x.asset);
        if (q.asset && a !== q.asset) continue;
        out.push({
          date: new Date(Number(x.time) * 1000).toISOString(),
          type: [x.type, x.subtype].filter(Boolean).join(" "),
          asset: a,
          amount: Number(x.amount),
          fee: Number(x.fee) || undefined,
          ref: x.refid ?? id,
        });
      }
      cursor = r.result?.cursor?.next ?? null;
    } while (cursor && out.length < MAX);
    if (cursor) ctx.note(`${owner}: only the newest ${out.length} entries were read; use --from/--to for older ones`);
    return out;
  },
};
