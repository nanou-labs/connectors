#!/usr/bin/env node
// Checks every connector manifest (spec: docs/manifest.md) and builds
// connectors/index.json, the summary nanou's gateway and installer read:
//   connectors/<id>/connector.json      the manifest
//   connectors/<id>/i18n/<locale>.json  its catalog text, one file per locale
// `node scripts/check.mjs --check` fails when index.json is out of date (CI runs it).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "connectors");
/** The languages nanou speaks: every connector has its catalog text in each. Turkish is listed last on nanou.ai. */
export const LOCALES = ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv", "tr"];

/** What a command may do, mildest first. `money` is never allowed: nothing may move money. */
export const EFFECTS = ["public", "read", "local", "write", "send"];
const CATEGORIES = { crypto: "Money" };
const PLANS = ["solo", "family", "plus"];
const AUTH = ["none", "api_key", "key_file", "file_import"];
const ID = /^[a-z][a-z0-9-]{1,23}$/;
const BIN = /^[a-z][a-z0-9-]{0,23}$/;
const COMMAND = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// A file under the family's home: no absolute path, no "..", only the owner placeholder.
const HOME_FILE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]*(\{owner\})?[A-Za-z0-9._/-]*$/;

/**
 * Throws with every problem in one manifest (and its texts), or returns it.
 * @param {any} m @param {string} dir @param {Record<string, any>} text  locale → catalog text
 * @param {string[]} locales
 */
function validate(m, dir, text, locales) {
  /** @type {string[]} */
  const bad = [];
  const need = (/** @type {boolean} */ ok, /** @type {string} */ msg) => ok || bad.push(msg);
  need(ID.test(m.id ?? "") && m.id === dir, `id must match its folder (${dir}) and ${ID}`);
  need(typeof m.name === "string" && m.name.length > 0, "name is required");
  need(m.category in CATEGORIES, `category must be one of ${Object.keys(CATEGORIES).join(", ")}`);
  need(Number.isInteger(m.order), "order must be an integer (position in the catalog)");
  need(PLANS.includes(m.plan), `plan must be one of ${PLANS.join(", ")}`);
  need(/^#[0-9A-Fa-f]{6}$/.test(m.color ?? ""), "color must be #RRGGBB");
  need(typeof m.mark === "string" && m.mark.length > 0 && m.mark.length <= 3, "mark must be 1-3 characters");
  need(typeof m.data === "string" && m.data.length > 0, "data (what it reads and where it is kept) is required");
  need(Array.isArray(m.network) && m.network.every((h) => HOST.test(h)), "network must be a list of host names");

  const t = m.tool ?? {};
  need(BIN.test(t.bin ?? ""), "tool.bin must be a command name");
  need(BIN.test(t.source ?? ""), "tool.source is the tool's --source value for it");
  const commands = Object.entries(t.commands ?? {});
  need(commands.length > 0, "tool.commands lists every command it uses");
  for (const [c, effect] of commands) {
    need(COMMAND.test(c), `tool.commands: "${c}" must be one or two lowercase words`);
    if (effect === "money") bad.push(`tool.commands: "${c}" moves money; nothing may move money, so this connector can't be installed`);
    else need(EFFECTS.includes(effect), `tool.commands: "${c}" has effect "${effect}", expected ${EFFECTS.join("|")}`);
  }

  const a = m.auth ?? {};
  need(AUTH.includes(a.kind), `auth.kind must be one of ${AUTH.join(", ")}`);
  const i = m.install ?? {};
  const placeholders = (/** @type {string[]} */ args, /** @type {string[]} */ ok) =>
    Array.isArray(args) && args.length > 0 && args.every((x) => typeof x === "string" && [...x.matchAll(/\{([a-z]+)\}/g)].every((p) => ok.includes(p[1])));
  if (a.kind === "api_key") {
    const fields = a.fields ?? [];
    need(Array.isArray(fields) && fields.length > 0, "auth.fields lists what the person pastes");
    for (const f of fields) {
      need(/^[a-z][a-z0-9_]*$/.test(f?.id ?? ""), "auth.fields[].id must be a lowercase word");
      try {
        new RegExp(f?.pattern);
        need(typeof f?.pattern === "string" && f.pattern.startsWith("^") && f.pattern.endsWith("$"), `auth.fields ${f?.id}: pattern must be anchored (^…$)`);
      } catch {
        bad.push(`auth.fields ${f?.id}: pattern is not a regular expression`);
      }
    }
  }
  if (a.kind === "key_file") need(Array.isArray(a.jsonKeys) && a.jsonKeys.length > 0, "auth.jsonKeys lists the keys the file must have");
  if (a.kind === "key_file" || a.kind === "file_import") need(typeof a.accept === "string", "auth.accept is the file picker's accept list");
  if (a.kind === "file_import") need(Array.isArray(a.header) && a.header.length > 0, "auth.header lists words the first line must contain");
  if (a.kind === "api_key" || a.kind === "key_file") {
    need(HOME_FILE.test(i.file ?? "") && (i.file ?? "").includes("{owner}"), "install.file is a path under the home with {owner}");
    need(placeholders(i.check, ["owner"]) && i.check[0] === t.bin, "install.check runs the tool to test what was saved");
  }
  if (a.kind === "file_import") need(placeholders(i.import, ["owner", "file"]) && i.import[0] === t.bin, "install.import runs the tool on {file}");
  if (a.kind !== "none") need(typeof i.refused === "string", "install.refused is what the person reads when the check fails");

  if (m.accounts !== undefined) {
    const acc = m.accounts;
    need(acc.kind === m.category, "accounts.kind is the sharing kind, the same as category");
    need(HOME_FILE.test(acc.dir ?? "") && !acc.dir.includes("{owner}"), "accounts.dir is a folder under the home");
    need(
      Array.isArray(acc.files) && acc.files.every((f) => /^[A-Za-z0-9._-]*\{owner\}[A-Za-z0-9._-]*$/.test(f) || /^[A-Za-z0-9_-]+\/\*\.json#[a-z_]+$/.test(f)),
      'accounts.files: "name-{owner}.ext" or "folder/*.json#field"',
    );
    need(typeof acc.label === "string", "accounts.label names the source in Settings");
  }

  for (const l of locales) {
    const x = text[l];
    if (!x) {
      bad.push(`i18n/${l}.json is missing`);
      continue;
    }
    need(typeof x.blurb === "string" && Array.isArray(x.can) && x.can.length > 0, `i18n/${l}: blurb and can are required`);
    if (a.kind === "none") need(typeof x.howTo === "string", `i18n/${l}: howTo is required when there is nothing to set up`);
    else need(typeof x.upload?.label === "string" && Array.isArray(x.upload?.help), `i18n/${l}: upload.label and upload.help are required`);
    if (a.kind === "api_key") for (const f of a.fields ?? []) need(typeof x.fields?.[f.id] === "string", `i18n/${l}: fields.${f.id} is required`);
  }
  if (bad.length) throw new Error(`connectors/${dir}:\n  ${bad.join("\n  ")}`);
  return m;
}

const locales = LOCALES;

const manifests = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = join(SRC, d.name);
    const m = JSON.parse(readFileSync(join(dir, "connector.json"), "utf8"));
    /** @type {Record<string, any>} */
    const text = {};
    for (const l of locales) {
      const f = join(dir, "i18n", `${l}.json`);
      if (existsSync(f)) text[l] = JSON.parse(readFileSync(f, "utf8"));
    }
    return { m: validate(m, d.name, text, locales), text };
  })
  .sort((x, y) => x.m.order - y.m.order || x.m.id.localeCompare(y.m.id));

const ids = manifests.map((x) => x.m.id);
if (new Set(ids).size !== ids.length) throw new Error("two connectors share an id");
const sources = manifests.map((x) => `${x.m.tool.bin}:${x.m.tool.source}`);
if (new Set(sources).size !== sources.length) throw new Error("two connectors share a tool --source");

// What each tool's commands may do, across every connector that uses it: the strictest wins.
/** @type {Record<string, { commands: Record<string, string>, sources: Record<string, string | null> }>} */
const bins = {};
for (const { m } of manifests) {
  const b = (bins[m.tool.bin] ??= { commands: {}, sources: {} });
  for (const [c, e] of Object.entries(m.tool.commands)) {
    if (!b.commands[c] || EFFECTS.indexOf(e) > EFFECTS.indexOf(b.commands[c])) b.commands[c] = e;
  }
  // A --source without accounts (public wallets) reads nothing private.
  b.sources[m.tool.source] = m.accounts ? m.accounts.kind : null;
}
for (const b of Object.values(bins)) b.commands = Object.fromEntries(Object.entries(b.commands).sort(([x], [y]) => x.localeCompare(y)));

const index = `${JSON.stringify({ generated: "by scripts/check.mjs from connectors/*/connector.json; do not edit", connectors: manifests.map((x) => x.m), bins }, null, 2)}\n`;

const file = join(SRC, "index.json");
const current = existsSync(file) ? readFileSync(file, "utf8") : "";
if (process.argv.includes("--check")) {
  if (current !== index) {
    console.error("connectors/index.json is out of date: run node scripts/check.mjs");
    process.exit(1);
  }
  console.log(`${manifests.length} connectors ok`);
} else {
  if (current !== index) writeFileSync(file, index);
  console.log(`${manifests.length} connectors ok, connectors/index.json written`);
}
