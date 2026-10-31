#!/usr/bin/env node
// One crypto source, in a process of its own: what `crypto` (crypto.mjs)
// runs for each source, so a source only ever sees its own folder and, under
// nanou's sandbox, only its own manifest's hosts.
//
//   node source.mjs <connector id> <op>     with the op's input as JSON on stdin
//
// ops: meta (help lines, how to connect), accounts, holdings (every account's
// balances, honouring an owner), history (every account's transactions),
// command (one the manifest declares). Prints one JSON object:
// { result, notes, errors } or { error } (exit code 1).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTORS = process.env.FAMILY_CONNECTORS_DIR ?? join(HERE, "..", "..", "connectors");
const RATES_API = process.env.FAMILY_COINBASE_API ?? "https://api.coinbase.com";

/** A message for the person: printed as {"error"} with exit code 1. */
class Refusal extends Error {}

/** @param {string} msg @returns {never} */
function fail(msg) {
  throw new Refusal(msg);
}

/** @param {unknown} value */
function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** The source's manifest and module. @param {string} id */
async function load(id) {
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(id ?? "")) fail("usage: source.mjs <connector id> <op>");
  const file = join(CONNECTORS, id, "connector.json");
  if (!existsSync(file)) fail(`no connector "${id}"`);
  const m = JSON.parse(readFileSync(file, "utf8"));
  if (m.tool?.bin !== "crypto") fail(`${id} isn't a crypto source`);
  const entry = resolve(CONNECTORS, id, m.entry ?? "");
  if (!entry.startsWith(`${resolve(CONNECTORS, id)}/`)) fail(`${id}: entry must stay inside its folder`);
  return { m, module: (await import(pathToFileURL(entry).href)).default ?? {} };
}

/** Units of each asset per one `currency` (Coinbase's public rates), for a command that shows values. */
function pricing(/** @type {string} */ currency) {
  /** @type {Promise<Record<string, string>> | null} */
  let table = null;
  const load = () =>
    (table ??= fetch(`${RATES_API}/v2/exchange-rates?currency=${encodeURIComponent(currency)}`, { signal: AbortSignal.timeout(30_000) })
      .then((r) => r.json())
      .then((j) => j.data?.rates ?? {})
      .catch(() => ({})));
  return async (/** @type {number} */ amount, /** @type {string} */ asset) => {
    const rate = Number((await load())[asset]);
    return rate > 0 ? Math.round((amount / rate) * 100) / 100 : null;
  };
}

/** All of stdin, as JSON ({} when empty). */
async function input() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

async function main() {
  const [id, op] = process.argv.slice(2);
  const { m, module: mod } = await load(id);
  const req = await input();
  const out = { notes: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]) };
  const currency = String(req.currency ?? "EUR").toUpperCase();
  const ctx = {
    /** The source's own folder: install.file lands here; nothing else can be read or written. */
    dir: join(homedir(), ".config", "connectors", id),
    currency,
    fail,
    value: pricing(currency),
    note: (/** @type {string} */ msg) => out.notes.push(`${id}: ${msg}`),
    warn: (/** @type {string} */ msg) => out.errors.push(`${id}: ${msg}`),
  };
  const owner = typeof req.owner === "string" ? req.owner.toLowerCase() : null;
  const accounts = async () => {
    const all = /** @type {Array<{ owner: string }>} */ (await mod.accounts(ctx));
    return owner ? all.filter((a) => a.owner === owner) : all;
  };

  /** @type {unknown} */
  let result;
  if (op === "meta") result = { help: mod.help ?? [], howToConnect: mod.howToConnect ?? [] };
  else if (op === "accounts") result = await mod.accounts(ctx);
  else if (op === "holdings") {
    result = [];
    for (const a of await accounts()) /** @type {any[]} */ (result).push({ owner: a.owner, items: await mod.balances(ctx, a) });
  } else if (op === "history") {
    result = [];
    if (typeof mod.transactions === "function") {
      for (const a of await accounts()) /** @type {any[]} */ (result).push({ owner: a.owner, items: await mod.transactions(ctx, a, req.range ?? {}) });
    }
  } else if (op === "command") {
    const name = String(req.name ?? "");
    const run = mod.commands?.[name];
    if (!(name in (m.tool.commands ?? {})) || typeof run !== "function") fail(`${id} doesn't declare \`${name}\``);
    result = await run(ctx, req.args ?? [], req.flags ?? {});
  } else fail(`unknown op ${op}`);
  print({ result, ...out });
}

main().catch((err) => {
  print({ error: err instanceof Refusal ? err.message : String(err?.message ?? err) });
  process.exit(1);
});
