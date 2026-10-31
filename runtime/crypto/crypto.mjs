#!/usr/bin/env node
// crypto: nanou's runtime for crypto connectors. It owns no service: every
// source (Coinbase, Kraken, Nexo, wallets…) is a self-contained folder under
// connectors/ whose manifest says `"tool": { "bin": "crypto" }` and whose
// `entry` module implements the source contract (runtime/crypto/README.md).
//
// The runtime finds the sources, asks each for its accounts, adds up
// holdings across sources, values them (public Coinbase exchange rates),
// merges histories, and runs a source's own commands (`wallet add`,
// `import-nexo`) only when its manifest declares them. Output is JSON.
//
// There is no command that moves money: the manifests can't declare one
// (scripts/check.mjs refuses it) and nanou's gateway refuses it again.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTORS = process.env.FAMILY_CONNECTORS_DIR ?? join(HERE, "..", "..", "connectors");
const DIR = process.env.FAMILY_CRYPTO_DIR ?? join(homedir(), ".config", "family-crypto");
const RATES_API = process.env.FAMILY_COINBASE_API ?? "https://api.coinbase.com";
/** Commands the runtime itself answers; a source can't take these names. */
const OWN = new Set(["accounts", "balances", "transactions", "prices"]);

/** A message for the person, raised by a source or the runtime: printed as {"error"} with exit code 1. */
class Refusal extends Error {}

/** @param {string} msg @returns {never} */
function fail(msg) {
  throw new Refusal(msg);
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

/**
 * @typedef {{ owner: string, [k: string]: unknown }} Account  a source's handle on one person's login; never a secret
 * @typedef {{ id: string, source: string, commands: Record<string, string>, module: any }} Source
 */

/** Every crypto source, in catalog order, with its module loaded. @returns {Promise<Source[]>} */
async function sources() {
  const found = [];
  for (const d of readdirSync(CONNECTORS, { withFileTypes: true })) {
    const file = join(CONNECTORS, d.name, "connector.json");
    if (!d.isDirectory() || !existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf8"));
    if (m.tool?.bin !== "crypto" || typeof m.entry !== "string") continue;
    const entry = resolve(CONNECTORS, d.name, m.entry);
    if (!entry.startsWith(resolve(CONNECTORS, d.name) + "/")) continue;
    found.push({ order: m.order ?? 0, id: m.id, source: m.tool.source, commands: m.tool.commands ?? {}, module: (await import(pathToFileURL(entry).href)).default });
  }
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Units of each asset per one `currency`, from Coinbase's public rates, fetched once. */
function pricing(/** @type {string} */ currency) {
  /** @type {Promise<Record<string, string>> | null} */
  let table = null;
  const load = () =>
    (table ??= fetch(`${RATES_API}/v2/exchange-rates?currency=${encodeURIComponent(currency)}`, { signal: AbortSignal.timeout(30_000) })
      .then((r) => r.json())
      .then((j) => j.data?.rates ?? {})
      .catch(() => ({})));
  /** Value of `amount` of `asset` in `currency`, or null when there is no price. */
  return async (/** @type {number} */ amount, /** @type {string} */ asset) => {
    const rate = Number((await load())[asset]);
    return rate > 0 ? Math.round((amount / rate) * 100) / 100 : null;
  };
}

/** What a source gets from the runtime: where its files are, and how to report. */
function context(/** @type {Source} */ s, /** @type {string} */ currency, /** @type {ReturnType<typeof pricing>} */ value, /** @type {{ notes: string[], errors: string[] }} */ out) {
  return {
    /** The family's crypto folder: install.file lands here; nothing else should be read or written. */
    dir: DIR,
    currency,
    fail,
    value,
    /** Something the person should know about a figure (a cut-short history, an old export). */
    note: (/** @type {string} */ msg) => out.notes.push(`${s.id}: ${msg}`),
    /** A part that couldn't be read: shown as missing, never as zero. */
    warn: (/** @type {string} */ msg) => out.errors.push(`${s.id}: ${msg}`),
  };
}

/** Whether a source is asked for (--source). */
const wants = (/** @type {Source} */ s, /** @type {Record<string, string>} */ flags) => !flags.source || flags.source.toLowerCase() === s.source;

/** A source's accounts, honouring --owner. @returns {Promise<Account[]>} */
async function accountsOf(/** @type {Source} */ s, ctx, /** @type {Record<string, string>} */ flags) {
  const all = /** @type {Account[]} */ (await s.module.accounts(ctx));
  const owner = flags.owner?.toLowerCase();
  return owner ? all.filter((a) => a.owner === owner) : all;
}

/** Whether a date string falls in --from/--to. */
function inRange(/** @type {unknown} */ date, /** @type {Record<string, string>} */ flags) {
  const d = String(date ?? "").slice(0, 10);
  return (!flags.from || d >= flags.from) && (!flags.to || d <= flags.to);
}

/** The commands a source declares beyond the runtime's own, as typed: `wallet add`, `import-nexo`. */
const extra = (/** @type {Source} */ s) => Object.keys(s.commands).filter((c) => !OWN.has(c));

function help(/** @type {Source[]} */ all) {
  const names = all.map((s) => s.source).join("|");
  return [
    `crypto: read-only crypto accounts (${all.map((s) => s.id).join(", ")})`,
    "",
    "  crypto accounts                                   what is connected, per owner",
    `  crypto balances [--owner ana] [--source ${names}] [--currency EUR]`,
    "  crypto transactions [--owner ana] [--source …] [--asset BTC] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--search text] [--limit 50]",
    "  crypto prices BTC ETH [--currency EUR]            spot prices (public)",
    ...all.flatMap((s) => s.module.help ?? []).map((l) => `  ${l}`),
    "",
    "Read-only: nothing here can trade, send or withdraw.",
  ].join("\n");
}

async function main() {
  const { flags, words } = parse(process.argv.slice(2));
  const all = await sources();
  const [cmd, ...rest] = words;
  if (!cmd || flags.help) return console.log(help(all));
  const currency = (flags.currency ?? "EUR").toUpperCase();
  const value = pricing(currency);
  const out = { notes: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]) };
  const reported = () => ({ ...(out.notes.length ? { notes: out.notes } : {}), ...(out.errors.length ? { errors: out.errors } : {}) });

  if (cmd === "accounts") {
    /** @type {Record<string, Account[]>} */
    const connected = {};
    for (const s of all) connected[s.source] = await s.module.accounts(context(s, currency, value, out));
    const none = Object.values(connected).every((a) => a.length === 0);
    return print({ ...connected, ...(none ? { note: all.flatMap((s) => s.module.howToConnect ?? []).join(" ") } : {}), ...reported() });
  }

  if (cmd === "prices") {
    if (!rest.length) fail("name at least one asset, e.g. crypto prices BTC ETH");
    const assets = rest.map((a) => a.toUpperCase());
    return print(Object.fromEntries(await Promise.all(assets.map(async (a) => [a, await value(1, a)]))));
  }

  if (cmd === "balances") {
    const holdings = [];
    let accounts = 0;
    for (const s of all.filter((x) => wants(x, flags))) {
      const ctx = context(s, currency, value, out);
      for (const account of await accountsOf(s, ctx, flags)) {
        accounts++;
        for (const h of await s.module.balances(ctx, account)) {
          const { priceAs, ...rest } = h;
          holdings.push({ source: s.source, owner: account.owner, ...rest, [`value${currency}`]: await value(h.amount, priceAs ?? h.asset) });
        }
      }
    }
    if (!accounts && !out.errors.length) fail("no crypto account is connected for that owner; see crypto accounts");
    const total = Math.round(holdings.reduce((sum, b) => sum + (b[`value${currency}`] ?? 0), 0) * 100) / 100;
    return print({ currency, [`total${currency}`]: total, holdings, ...reported() });
  }

  if (cmd === "transactions") {
    const limit = Number(flags.limit) || 50;
    const rows = [];
    for (const s of all.filter((x) => wants(x, flags) && x.commands.transactions)) {
      const ctx = context(s, currency, value, out);
      for (const account of await accountsOf(s, ctx, flags)) {
        for (const t of await s.module.transactions(ctx, account, { from: flags.from, to: flags.to, asset: flags.asset?.toUpperCase() })) {
          rows.push({ source: s.source, owner: account.owner, ...t });
        }
      }
    }
    const needle = flags.search?.toLowerCase();
    const shown = rows
      .filter((t) => inRange(t.date, flags))
      .filter((t) => !needle || JSON.stringify(t).toLowerCase().includes(needle))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return print({ count: shown.length, shown: Math.min(limit, shown.length), ...reported(), transactions: shown.slice(0, limit) });
  }

  // A source's own command, typed as its manifest declares it: one or two words.
  const two = `${cmd} ${rest[0] ?? ""}`;
  for (const s of all) {
    const name = extra(s).find((c) => c === two) ?? extra(s).find((c) => c === cmd);
    if (!name) continue;
    const run = s.module.commands?.[name];
    if (typeof run !== "function") fail(`${s.id} declares \`${name}\` but doesn't implement it`);
    const args = name.includes(" ") ? rest.slice(1) : rest;
    return print(await run(context(s, currency, value, out), args, flags));
  }
  fail(`unknown command ${cmd}\n\n${help(all)}`);
}

main().catch((err) => {
  print({ error: err instanceof Refusal ? err.message : String(err?.message ?? err) });
  process.exit(1);
});
