#!/usr/bin/env node
// Checks every connector manifest (spec: docs/manifest.md) and that each
// connector's code implements exactly what it declares, then builds what
// nanou reads: connectors/index.json (its gateway and installer) and each
// runtime's skill (skills/<name>/SKILL.md, from runtime/<bin>/SKILL.md plus
// every connector's own SKILL.md).
//   connectors/<id>/connector.json      the manifest
//   connectors/<id>/i18n/<locale>.json  its catalog text, one file per locale
// `node scripts/check.mjs --check` fails when a generated file is out of date (CI runs it).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "connectors");
/** The languages nanou speaks: every connector has its catalog text in each. Turkish is listed last on nanou.ai. */
export const LOCALES = ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv", "tr"];

/** What a command may do, mildest first. `money` is never allowed: nothing may move money. */
export const EFFECTS = ["public", "read", "local", "write", "send"];
const CATEGORIES = { crypto: "Money", work: "Work" };
const PLANS = ["solo", "family", "plus"];
const AUTH = ["none", "api_key", "key_file", "file_import", "device"];
/** Sharing kinds several connectors share (one line per person: "Crypto: Coinbase, Kraken"); any other kind is the connector's id. */
const SHARED_KINDS = { crypto: "crypto" };
const ID = /^[a-z][a-z0-9-]{1,23}$/;
const BIN = /^[a-z][a-z0-9-]{0,23}$/;
const COMMAND = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// A file under the family's home: no absolute path, no "..", only the owner placeholder.
const HOME_FILE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]*(\{owner\})?[A-Za-z0-9._/-]*$/;
/** Commands the shared runtimes answer themselves; any other tool.bin is the connector's own command (runtime/cli). */
const RUNTIME_OWN = { crypto: ["accounts", "balances", "transactions", "prices"] };
/** Effects that change something: each needs an approval card, described in the manifest's `cards`. */
const CHANGES = new Set(["write", "send"]);
const CARD_VERBS = ["Approve", "Post", "Send", "Save"];
/** What a card shows: the first, second… word after the command ($1), or a flag's value (--text). */
const CARD_REF = /^(\$[1-9]|--[a-z][a-z0-9-]*)$/;
/** A logo is plain shapes: these elements and attributes only, no text, links, styles or scripts. */
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "polygon"]);
const SVG_ATTRS = new Set([
  "xmlns", "viewBox", "d", "fill", "fill-rule", "clip-rule", "opacity", "fill-opacity", "transform",
  "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height", "points",
]);

/**
 * Problems with a logo: a small SVG of plain shapes, safe to show anywhere.
 * @param {string} svg @returns {string[]}
 */
export function logoProblems(svg) {
  const bad = [];
  if (svg.length > 8192) bad.push("logo: keep it under 8 KB");
  if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="-?[0-9.]+ -?[0-9.]+ [0-9.]+ [0-9.]+"/.test(svg)) {
    bad.push('logo: start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="x y w h"> (a square viewBox)');
  }
  const [, , w, h] = /viewBox="([^"]+)"/.exec(svg)?.[1].split(" ").map(Number) ?? [];
  if (w !== h) bad.push("logo: the viewBox must be square");
  if (/[&]|<!|<\?|url\(|javascript:/i.test(svg)) bad.push("logo: no entities, comments, processing instructions or url()");
  const rest = svg.replace(/<\/?([A-Za-z]+)((?:\s+[A-Za-z:-]+="[^"<>]*")*)\s*\/?>/g, (_, tag, attrs) => {
    if (!SVG_TAGS.has(tag)) bad.push(`logo: <${tag}> isn't allowed (only ${[...SVG_TAGS].join(", ")})`);
    for (const [, name] of attrs.matchAll(/([A-Za-z:-]+)="/g)) if (!SVG_ATTRS.has(name)) bad.push(`logo: attribute ${name} isn't allowed`);
    return "";
  });
  if (rest.trim() !== "") bad.push("logo: only elements, no text between them");
  return bad;
}

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
  need(
    typeof m.entry === "string" && /^src\/[A-Za-z0-9._/-]+\.mjs$/.test(m.entry) && !m.entry.includes("..") && existsSync(join(SRC, dir, m.entry)),
    "entry is the connector's module inside its folder (src/source.mjs)",
  );

  need(m.logo === "logo.svg" && existsSync(join(SRC, dir, "logo.svg")), "logo is logo.svg, in the connector's folder");
  if (m.logo === "logo.svg" && existsSync(join(SRC, dir, "logo.svg"))) bad.push(...logoProblems(readFileSync(join(SRC, dir, "logo.svg"), "utf8")));

  const t = m.tool ?? {};
  need(BIN.test(t.bin ?? ""), "tool.bin must be a command name");
  const own = t.runs === "entry";
  need(t.runs === undefined || own, 'tool.runs is "entry" (the connector\'s entry is the whole command) or left out');
  if (own) {
    // Its own program, too wide to list command by command (gh): a policy module classifies every call.
    need(!(t.bin in RUNTIME_OWN), "tool.bin of a connector that runs its entry can't be a shared runtime's");
    need(
      typeof t.policy === "string" && /^src\/[A-Za-z0-9._/-]+\.mjs$/.test(t.policy) && !t.policy.includes("..") && existsSync(join(SRC, dir, t.policy)),
      "tool.policy is the module that classifies its commands (src/policy.mjs)",
    );
    need(t.commands === undefined && m.cards === undefined, "a connector with a policy has no tool.commands or cards: its policy says both");
  } else {
    need(t.policy === undefined, "tool.policy only goes with tool.runs: \"entry\"");
    need(t.bin in RUNTIME_OWN || t.bin === m.id, `tool.bin is a shared runtime (${Object.keys(RUNTIME_OWN).join(", ")}) or the connector's own command, named like its id`);
  }
  need(BIN.test(t.source ?? ""), "tool.source is the tool's --source value for it");
  const commands = Object.entries(t.commands ?? {});
  need(own || commands.length > 0, "tool.commands lists every command it uses");
  for (const b of m.binaries ?? []) {
    need(
      /^[a-z0-9-]{1,32}$/.test(b?.name ?? "") && /^https:\/\/[^\s]+$/.test(b?.url ?? "") && /^[0-9a-f]{64}$/.test(b?.sha256 ?? "") &&
        typeof b?.path === "string" && !b.path.startsWith("/") && !b.path.includes(".."),
      "binaries[]: { name, url (https), sha256 of the download, path inside the archive }; nanou fetches it into bin/<name> and checks the sum",
    );
  }
  for (const [c, effect] of commands) {
    need(COMMAND.test(c), `tool.commands: "${c}" must be one or two lowercase words`);
    if (effect === "money") bad.push(`tool.commands: "${c}" moves money; nothing may move money, so this connector can't be installed`);
    else need(EFFECTS.includes(effect), `tool.commands: "${c}" has effect "${effect}", expected ${EFFECTS.join("|")}`);
  }
  // Every change gets an approval card, and the manifest says what the card shows.
  const cards = m.cards ?? {};
  for (const [c, effect] of commands) if (CHANGES.has(effect)) need(c in cards, `cards.${c}: "${c}" changes something, so describe its approval card`);
  for (const [c, card] of Object.entries(cards)) {
    need(CHANGES.has(t.commands?.[c]), `cards.${c}: only commands that write or send have a card`);
    need(typeof card?.title === "string" && card.title.length > 0 && card.title.length <= 60, `cards.${c}.title: 1-60 characters`);
    need(card?.verb === undefined || CARD_VERBS.includes(card.verb), `cards.${c}.verb: one of ${CARD_VERBS.join(", ")}`);
    need(
      (card?.fields ?? []).every((/** @type {any} */ f) => Array.isArray(f) && f.length === 2 && typeof f[0] === "string" && CARD_REF.test(f[1])),
      `cards.${c}.fields: [label, "$1" or "--flag"] pairs`,
    );
    need((card?.body ?? []).every((/** @type {any} */ r) => CARD_REF.test(r)), `cards.${c}.body: "$1" or "--flag" values, the first one given is shown`);
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
  if (a.kind !== "none" && a.kind !== "device") need(typeof i.refused === "string", "install.refused is what the person reads when the check fails");
  if (a.kind === "device") {
    // OAuth device sign-in (RFC 8628), run by nanou's host: the person types a code on the service's own site.
    for (const k of ["codeUrl", "tokenUrl", "verifyUrl", "userUrl"]) {
      const host = /^https:\/\/([^/\s]+)\//.exec(a[k] ?? "")?.[1];
      need(host !== undefined && (m.network ?? []).includes(host), `auth.${k}: an https URL on one of the network hosts`);
    }
  }

  if (m.accounts !== undefined) {
    const acc = m.accounts;
    need(acc.kind === m.id || SHARED_KINDS[m.category] === acc.kind, `accounts.kind is the connector's id (${m.id}), or "crypto" for a crypto source`);
    need(HOME_FILE.test(acc.dir ?? "") && !acc.dir.includes("{owner}"), "accounts.dir is a folder under the home");
    const byField = (/** @type {string} */ f) => /^([A-Za-z0-9_-]+\/)?\*\.json#[a-z_]+$/.test(f);
    need(
      Array.isArray(acc.files) && acc.files.every((f) => /^[A-Za-z0-9._-]*\{owner\}[A-Za-z0-9._-]*$/.test(f) || byField(f)),
      'accounts.files: "name-{owner}.ext", or "*.json#field" / "folder/*.json#field" where the JSON field is the owner',
    );
    need(acc.account === undefined || (/^[a-z_]+$/.test(acc.account) && acc.files.every(byField)), "accounts.account: the JSON field naming each account (one sharing line per account), with *.json#owner files");
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
    else if (a.kind !== "device") need(typeof x.upload?.label === "string" && Array.isArray(x.upload?.help), `i18n/${l}: upload.label and upload.help are required`);
    if (m.accounts?.kind === m.id) {
      need(["yours", "next", "first"].every((k) => typeof x.sharing?.[k] === "string"), `i18n/${l}: sharing.yours, sharing.next and sharing.first word its sharing setting`);
    }
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

// The code does what the manifest declares, no more: the runtime's contract (runtime/<bin>/README.md).
for (const { m } of manifests) {
  if (m.tool.runs === "entry") {
    // The entry is a whole program (importing it would run it): check the policy instead.
    const policy = (await import(pathToFileURL(join(SRC, m.id, m.tool.policy)).href)).default ?? {};
    if (typeof policy.kind !== "function" || typeof policy.card !== "function") {
      throw new Error(`connectors/${m.id}: ${m.tool.policy} must default-export { kind(args), card(args) }`);
    }
    continue;
  }
  const own = RUNTIME_OWN[m.tool.bin];
  const mod = (await import(pathToFileURL(join(SRC, m.id, m.entry)).href)).default ?? {};
  const declared = Object.keys(m.tool.commands);
  const bad = [];
  if (!own) {
    // Its own command (runtime/cli): exactly the declared commands, nothing hidden.
    const implemented = Object.keys(mod.commands ?? {});
    for (const c of declared) if (typeof mod.commands?.[c] !== "function") bad.push(`declares "${c}" but ${m.entry} doesn't implement it`);
    for (const c of implemented) if (!declared.includes(c)) bad.push(`${m.entry} implements "${c}", which the manifest doesn't declare`);
    if (bad.length) throw new Error(`connectors/${m.id}:\n  ${bad.join("\n  ")}`);
    continue;
  }
  for (const f of ["accounts", "balances"]) if (typeof mod[f] !== "function") bad.push(`${m.entry} must export ${f}()`);
  if (declared.includes("transactions") !== (typeof mod.transactions === "function")) bad.push("transactions() is implemented exactly when the manifest declares transactions");
  const extra = declared.filter((c) => !own.includes(c));
  const implemented = Object.keys(mod.commands ?? {});
  for (const c of extra) if (typeof mod.commands?.[c] !== "function") bad.push(`declares "${c}" but ${m.entry} doesn't implement it`);
  for (const c of implemented) if (!extra.includes(c)) bad.push(`${m.entry} implements "${c}", which the manifest doesn't declare`);
  if (bad.length) throw new Error(`connectors/${m.id}:\n  ${bad.join("\n  ")}`);
}

const ids = manifests.map((x) => x.m.id);
if (new Set(ids).size !== ids.length) throw new Error("two connectors share an id");
const sources = manifests.map((x) => `${x.m.tool.bin}:${x.m.tool.source}`);
if (new Set(sources).size !== sources.length) throw new Error("two connectors share a tool --source");
const ownBins = manifests.filter((x) => !(x.m.tool.bin in RUNTIME_OWN)).map((x) => x.m.tool.bin);
if (new Set(ownBins).size !== ownBins.length) throw new Error("two connectors claim the same command");

// What each tool's commands may do, across every connector that uses it: the strictest wins.
/** @type {Record<string, { commands: Record<string, string>, sources: Record<string, string | null>, policy?: string }>} */
const bins = {};
for (const { m } of manifests) {
  const b = (bins[m.tool.bin] ??= { commands: {}, sources: {} });
  // Its policy module classifies every command (nanou's gateway builds it in at a pin bump).
  if (m.tool.policy) b.policy = `${m.id}/${m.tool.policy}`;
  for (const [c, e] of Object.entries(m.tool.commands ?? {})) {
    if (!b.commands[c] || EFFECTS.indexOf(e) > EFFECTS.indexOf(b.commands[c])) b.commands[c] = e;
  }
  // A --source without accounts (public wallets) reads nothing private.
  b.sources[m.tool.source] = m.accounts ? m.accounts.kind : null;
}
for (const b of Object.values(bins)) b.commands = Object.fromEntries(Object.entries(b.commands).sort(([x], [y]) => x.localeCompare(y)));

const index = `${JSON.stringify({ generated: "by scripts/check.mjs from connectors/*/connector.json; do not edit", connectors: manifests.map((x) => x.m), bins }, null, 2)}\n`;

// Each runtime's skill: its own part, with every connector's SKILL.md (in catalog order) where it says so.
/** @type {Record<string, string>} generated file → content */
const outputs = { [join(SRC, "index.json")]: index };
const RUNTIMES = join(ROOT, "runtime");
for (const bin of existsSync(RUNTIMES) ? readdirSync(RUNTIMES) : []) {
  const template = join(RUNTIMES, bin, "SKILL.md");
  if (!existsSync(template)) continue;
  const text = readFileSync(template, "utf8");
  const name = /^name: (.+)$/m.exec(text)?.[1]?.trim();
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error(`runtime/${bin}/SKILL.md needs a name in its front matter`);
  const mine = manifests.filter((x) => x.m.tool.bin === bin);
  const sections = mine
    .map((x) => join(SRC, x.m.id, "SKILL.md"))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8").trim())
    .join("\n\n");
  const skill = text
    .replace("{{sources}}", mine.map((x) => x.m.tool.source).join("|"))
    .replace(/^<!-- connectors:.*-->$/m, sections)
    // After the front matter, which must stay first.
    .replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n<!-- Generated by scripts/check.mjs from runtime/${bin}/SKILL.md and connectors/*/SKILL.md; do not edit. -->\n`);
  outputs[join(ROOT, "skills", name, "SKILL.md")] = skill;
}

// A connector with its own command brings its whole skill (front matter included).
for (const { m } of manifests.filter((x) => !(x.m.tool.bin in RUNTIME_OWN))) {
  const file = join(SRC, m.id, "SKILL.md");
  if (!existsSync(file)) throw new Error(`connectors/${m.id}: SKILL.md is required (how nanou uses its command)`);
  const text = readFileSync(file, "utf8");
  const name = /^---\nname: ([a-z0-9-]+)\n/.exec(text)?.[1];
  if (!name) throw new Error(`connectors/${m.id}/SKILL.md must start with front matter naming the skill (name: family-${m.id})`);
  outputs[join(ROOT, "skills", name, "SKILL.md")] = text.replace(
    /^(---\n[\s\S]*?\n---\n)/,
    `$1\n<!-- Generated by scripts/check.mjs from connectors/${m.id}/SKILL.md; do not edit. -->\n`,
  );
}

const stale = Object.entries(outputs).filter(([f, content]) => (existsSync(f) ? readFileSync(f, "utf8") : "") !== content);
if (process.argv.includes("--check")) {
  if (stale.length) {
    console.error(`out of date: ${stale.map(([f]) => f.slice(ROOT.length + 1)).join(", ")}; run node scripts/check.mjs`);
    process.exit(1);
  }
  console.log(`${manifests.length} connectors ok`);
} else {
  for (const [f, content] of stale) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  console.log(`${manifests.length} connectors ok${stale.length ? `, wrote ${stale.map(([f]) => f.slice(ROOT.length + 1)).join(", ")}` : ""}`);
}
