#!/usr/bin/env node
// cli: nanou's runner for a connector that has a command of its own (`asana`,
// one day `github`…). nanou installs the command as a two-line launcher:
//
//   exec node runtime/cli/cli.mjs <connector id> "$@"
//
// The connector's `entry` module only implements its commands (contract:
// runtime/cli/README.md). The runner does the rest, the same way for every
// connector: it parses the arguments, finds whose account to use, reads the
// saved secret, prints JSON, and refuses a command that changes anything
// unless nanou's gateway approved that one command on a card (it then runs it
// with NANOU_WRITE=1). The gateway checks every command against the manifest
// too: this is the first wall, not the only one.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTORS = process.env.FAMILY_CONNECTORS_DIR ?? join(HERE, "..", "..", "connectors");
const HOME = process.env.FAMILY_HOME ?? homedir();
/** Effects that change something: they need the gateway's approval (NANOU_WRITE=1). */
const CHANGES = new Set(["write", "send"]);

/** A message for the person: printed as {"error"} with exit code 1. */
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
 * Positional words and `--flag value` / `--flag=value` pairs. A flag followed
 * by another flag, by nothing, or named in `bool` is `true`.
 * @param {string[]} argv @param {Set<string>} bool
 * @returns {{ words: string[], flags: Record<string, string | true> }}
 */
function parse(argv, bool) {
  /** @type {string[]} */
  const words = [];
  /** @type {Record<string, string | true>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (!bool.has(a.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { words, flags };
}

/** Write JSON atomically, owner-only. @param {string} file @param {unknown} value */
function save(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The connector's manifest and module. @param {string} id */
async function load(id) {
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(id ?? "")) fail("usage: cli.mjs <connector id> [command] [--flags]");
  const dir = join(CONNECTORS, id);
  const file = join(dir, "connector.json");
  if (!existsSync(file)) fail(`no connector "${id}"`);
  const m = JSON.parse(readFileSync(file, "utf8"));
  if (m.tool?.bin !== id) fail(`connector "${id}" doesn't have a command of its own`);
  const entry = resolve(dir, m.entry ?? "");
  if (!entry.startsWith(`${resolve(dir)}/`)) fail(`connector "${id}": entry must stay inside its folder`);
  return { m, module: (await import(pathToFileURL(entry).href)).default ?? {} };
}

/**
 * Where each person's secret is saved (install.file, e.g.
 * ".config/family-work/asana-{owner}.json"), and who has one.
 * @param {any} m
 */
function secrets(m) {
  const pattern = m.install?.file;
  const path = (/** @type {string} */ owner) => join(HOME, pattern.replace("{owner}", owner));
  const owners = () => {
    if (!pattern) return [];
    const dir = dirname(join(HOME, pattern));
    const [before, after] = basename(pattern).split("{owner}");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith(before) && f.endsWith(after) && f.length > before.length + after.length)
      .map((f) => f.slice(before.length, f.length - after.length))
      .sort();
  };
  return { path, owners };
}

/** The `{help, commands}` text for `<bin> help`. @param {any} m @param {any} mod */
function usage(m, mod) {
  const changes = Object.entries(m.tool.commands)
    .filter(([, e]) => CHANGES.has(/** @type {string} */ (e)))
    .map(([c]) => c);
  return [
    `${m.tool.bin}: ${m.name} (${changes.length ? "read; changes need approval" : "read-only"})`,
    "",
    ...(mod.help ?? Object.keys(m.tool.commands).map((c) => `  ${m.tool.bin} ${c}`)),
    "",
    "Add --owner <name> for someone else's account, --readonly to make sure nothing is changed.",
  ].join("\n");
}

async function main() {
  const [id, ...argv] = process.argv.slice(2);
  const { m, module: mod } = await load(id);
  const { words, flags } = parse(argv, new Set(["readonly", "help", ...(mod.booleans ?? [])]));
  if (flags.help || words.length === 0 || words[0] === "help") {
    process.stdout.write(`${usage(m, mod)}\n`);
    return;
  }

  // The command: two words when the manifest declares them (`wallet add`), else one.
  const two = words.slice(0, 2).join(" ");
  const command = two in m.tool.commands ? two : words[0];
  const effect = m.tool.commands[command];
  const run = mod.commands?.[command];
  if (!effect || typeof run !== "function") fail(`unknown command "${command}". Run: ${m.tool.bin} help`);
  if (CHANGES.has(effect) && (flags.readonly || process.env.NANOU_WRITE !== "1")) {
    fail(`read-only: \`${m.tool.bin} ${command}\` changes ${m.name}, so it needs approval. Run it without --readonly: nanou posts an approval card.`);
  }

  // Whose account: --owner, else the only person who connected one.
  const { path, owners } = secrets(m);
  const named = typeof flags.owner === "string" ? flags.owner.toLowerCase() : null;
  if (named !== null && !/^[a-z0-9-]{1,32}$/.test(named)) fail("--owner is a first name, lowercase");
  const owner = () => {
    if (named) return named;
    const all = owners();
    if (all.length === 1) return all[0];
    if (all.length === 0) fail(`${m.name} isn't connected. Each person connects it on nanou.ai → Connectors → ${m.name}.`);
    fail(`several people connected ${m.name} (${all.join(", ")}): say whose with --owner <name>`);
  };

  const rest = words.slice(command.split(" ").length);
  /** @param {string} name */
  const statePath = (name) => {
    if (!/^[a-z0-9-]{1,40}$/.test(name)) fail(`state name "${name}" must be a short lowercase word`);
    return join(dirname(path(owner())), `${id}-state`, `${owner()}-${name}.json`);
  };
  const ctx = {
    words: rest,
    flags,
    /** A flag's text value, or undefined (also when given without a value). @param {string} k */
    flag: (k) => (typeof flags[k] === "string" ? /** @type {string} */ (flags[k]) : undefined),
    owner,
    /** The saved secret of the account in use (install.file). @returns {Record<string, any>} */
    secret() {
      const who = owner();
      const file = path(who);
      if (!existsSync(file)) fail(`${who} hasn't connected ${m.name}. They connect it on nanou.ai → Connectors → ${m.name}.`);
      return JSON.parse(readFileSync(file, "utf8"));
    },
    /** Replace the saved secret (a refreshed token, a remembered workspace), atomically, owner-only. @param {unknown} value */
    saveSecret(value) {
      save(path(owner()), value);
    },
    /**
     * The account's own state next to its secret (a cache, a cursor):
     * <secret's folder>/<id>-state/<owner>-<name>.json.
     */
    state: {
      /** @param {string} name @param {any} fallback */
      get(name, fallback) {
        const file = statePath(name);
        try {
          return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
        } catch {
          return fallback;
        }
      },
      /** @param {string} name @param {unknown} value */
      set(name, value) {
        save(statePath(name), value);
      },
    },
    fail,
  };
  const out = await run(ctx);
  if (out !== undefined) print(out);
}

main().catch((err) => {
  print({ error: err instanceof Refusal ? err.message : `${err?.message ?? err}` });
  process.exitCode = 1;
});
