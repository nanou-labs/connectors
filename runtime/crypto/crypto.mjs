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
// Each source runs in a process of its own (source.mjs), one after another,
// and never in this one: it sees only its own folder. Under nanou, the
// launcher sets NANOU_SANDBOX and every source process is jailed by it (its
// own files and its manifest's hosts only); this process reads no secret.
//
// There is no command that moves money: the manifests can't declare one
// (scripts/check.mjs refuses it) and nanou's gateway refuses it again.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTORS = process.env.FAMILY_CONNECTORS_DIR ?? join(HERE, "..", "..", "connectors");
const SOURCE = join(HERE, "source.mjs");
/** nanou's sandbox command (nanou-sandbox <id> -- …), set by its launcher; unset, sources run unjailed. */
const SANDBOX = process.env.NANOU_SANDBOX ?? "";
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
 * @typedef {{ id: string, source: string, commands: Record<string, string> }} Source
 */

/** Every crypto source, in catalog order, from the manifests (their code runs in source.mjs). @returns {Source[]} */
function sources() {
  const found = [];
  for (const d of readdirSync(CONNECTORS, { withFileTypes: true })) {
    const file = join(CONNECTORS, d.name, "connector.json");
    if (!d.isDirectory() || !existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf8"));
    if (m.tool?.bin !== "crypto" || typeof m.entry !== "string") continue;
    found.push({ order: m.order ?? 0, id: m.id, source: m.tool.source, commands: m.tool.commands ?? {} });
  }
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * Run one op of one source in its own (jailed, under nanou) process; its
 * notes and errors join the output's.
 * @param {Source} s @param {string} op @param {Record<string, unknown>} req
 * @param {{ notes: string[], errors: string[] }} out @returns {Promise<any>}
 */
function run(s, op, req, out) {
  const argv = [process.execPath, SOURCE, s.id, op];
  const [cmd, ...args] = SANDBOX ? [SANDBOX, s.id, "--", ...argv] : argv;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    let text = "";
    p.stdout.on("data", (c) => (text += c));
    p.on("error", reject);
    p.on("close", () => {
      let reply;
      try {
        reply = JSON.parse(text);
      } catch {
        return reject(new Error(`${s.id} gave no answer`));
      }
      out.notes.push(...(reply.notes ?? []));
      out.errors.push(...(reply.errors ?? []));
      if (reply.error !== undefined) return reject(new Refusal(reply.error));
      resolve(reply.result);
    });
    p.stdin.end(JSON.stringify(req));
  });
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

/** Whether a source is asked for (--source). */
const wants = (/** @type {Source} */ s, /** @type {Record<string, string>} */ flags) => !flags.source || flags.source.toLowerCase() === s.source;

/** Whether a date string falls in --from/--to. */
function inRange(/** @type {unknown} */ date, /** @type {Record<string, string>} */ flags) {
  const d = String(date ?? "").slice(0, 10);
  return (!flags.from || d >= flags.from) && (!flags.to || d <= flags.to);
}

/** The commands a source declares beyond the runtime's own, as typed: `wallet add`, `import-nexo`. */
const extra = (/** @type {Source} */ s) => Object.keys(s.commands).filter((c) => !OWN.has(c));

async function help(/** @type {Source[]} */ all) {
  const out = { notes: [], errors: [] };
  const meta = [];
  for (const s of all) meta.push(await run(s, "meta", {}, out).catch(() => ({ help: [] })));
  const names = all.map((s) => s.source).join("|");
  return [
    `crypto: read-only crypto accounts (${all.map((s) => s.id).join(", ")})`,
    "",
    "  crypto accounts                                   what is connected, per owner",
    `  crypto balances [--owner ana] [--source ${names}] [--currency EUR]`,
    "  crypto transactions [--owner ana] [--source …] [--asset BTC] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--search text] [--limit 50]",
    "  crypto prices BTC ETH [--currency EUR]            spot prices (public)",
    ...meta.flatMap((m) => m.help ?? []).map((l) => `  ${l}`),
    "",
    "Read-only: nothing here can trade, send or withdraw.",
  ].join("\n");
}

async function main() {
  const { flags, words } = parse(process.argv.slice(2));
  const all = sources();
  const [cmd, ...rest] = words;
  if (!cmd || flags.help) return console.log(await help(all));
  const currency = (flags.currency ?? "EUR").toUpperCase();
  const value = pricing(currency);
  const out = { notes: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]) };
  const reported = () => ({ ...(out.notes.length ? { notes: out.notes } : {}), ...(out.errors.length ? { errors: out.errors } : {}) });

  if (cmd === "accounts") {
    /** @type {Record<string, Account[]>} */
    const connected = {};
    for (const s of all) connected[s.source] = await run(s, "accounts", {}, out);
    const none = Object.values(connected).every((a) => a.length === 0);
    const how = [];
    if (none) for (const s of all) how.push(...((await run(s, "meta", {}, out)).howToConnect ?? []));
    return print({ ...connected, ...(none ? { note: how.join(" ") } : {}), ...reported() });
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
      for (const account of await run(s, "holdings", { owner: flags.owner, currency }, out)) {
        accounts++;
        for (const h of account.items) {
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
      const range = { from: flags.from, to: flags.to, asset: flags.asset?.toUpperCase() };
      for (const account of await run(s, "history", { owner: flags.owner, currency, range }, out)) {
        for (const t of account.items) rows.push({ source: s.source, owner: account.owner, ...t });
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
    const args = name.includes(" ") ? rest.slice(1) : rest;
    return print(await run(s, "command", { name, args, flags, currency }, out));
  }
  fail(`unknown command ${cmd}\n\n${await help(all)}`);
}

main().catch((err) => {
  print({ error: err instanceof Refusal ? err.message : String(err?.message ?? err) });
  process.exit(1);
});
