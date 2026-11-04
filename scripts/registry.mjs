#!/usr/bin/env node
// Checks registry/verified.json, the Verified connectors: each entry pins one
// commit of its author's repository, the hash of the files nanou installs from
// it, what it may do, and nanou's signature over all of that (docs/review.md).
// The signature is checked where it counts, by nanou itself with a key that
// isn't in this repository; this checks that every entry is well formed.
//
//   node scripts/registry.mjs --check
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EFFECTS } from "./check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const FIELDS = ["id", "name", "repo", "path", "commit", "tree", "data", "network", "commands", "auth", "author", "reviewed", "signature"];

/**
 * Every problem with the registry (empty: it's well formed).
 * @param {any} registry @param {string[]} official  ids of the Official connectors
 * @returns {string[]}
 */
export function checkRegistry(registry, official) {
  const bad = [];
  if (!Array.isArray(registry?.connectors)) return ['registry/verified.json: { "connectors": [...] }'];
  const seen = new Set();
  for (const [i, e] of registry.connectors.entries()) {
    const at = `connectors[${i}]${typeof e?.id === "string" ? ` (${e.id})` : ""}`;
    const need = (/** @type {boolean} */ ok, /** @type {string} */ msg) => ok || bad.push(`${at}: ${msg}`);
    need(e && typeof e === "object" && Object.keys(e).sort().join() === [...FIELDS].sort().join(), `exactly these fields: ${FIELDS.join(", ")}`);
    need(/^[a-z][a-z0-9-]{1,23}$/.test(e?.id ?? "") && !official.includes(e.id) && !seen.has(e.id), "id: unique, and not an Official connector's");
    seen.add(e?.id);
    need(typeof e?.name === "string" && e.name.length > 0 && e.name.length <= 40, "name: 1-40 characters");
    need(/^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(e?.repo ?? ""), "repo: https://github.com/<owner>/<repo>");
    need(typeof e?.path === "string" && /^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/.test(e.path) && !e.path.split("/").includes(".."), "path: the connector's folder in the repo, or empty");
    need(/^[0-9a-f]{40}$/.test(e?.commit ?? ""), "commit: a full commit SHA");
    need(/^[0-9a-f]{64}$/.test(e?.tree ?? ""), "tree: the SHA-256 tree hash of the installed files");
    need(typeof e?.data === "string" && e.data.length > 0 && e.data.length <= 300, "data: what it reads and keeps");
    need(Array.isArray(e?.network) && e.network.length > 0 && e.network.every((/** @type {string} */ h) => HOST.test(h) && !/^[0-9.]+$/.test(h)), "network: its host names");
    const commands = Object.entries(e?.commands ?? {});
    need(commands.length > 0 && commands.every(([c, x]) => /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/.test(c) && EFFECTS.includes(x)), `commands: each with an effect (${EFFECTS.join("|")}); nothing may move money`);
    need(["api_key", "none"].includes(e?.auth), 'auth: "api_key" or "none"');
    need(typeof e?.author === "string" && /^[A-Za-z0-9-]{1,39}$/.test(e.author), "author: their GitHub login");
    const r = e?.reviewed ?? {};
    need(/^\d{4}-\d{2}-\d{2}$/.test(r.at ?? "") && typeof r.audit === "string" && r.audit.length > 0 && typeof r.liveTest === "string" && r.liveTest.length > 0, "reviewed: { at, audit, liveTest }, the two human steps");
    need(typeof e?.signature === "string" && Buffer.from(e.signature, "base64").length === 64, "signature: nanou's Ed25519 signature, base64");
  }
  return bad;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const official = readdirSync(join(ROOT, "connectors"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const registry = JSON.parse(readFileSync(join(ROOT, "registry", "verified.json"), "utf8"));
  const bad = checkRegistry(registry, official);
  if (bad.length) {
    console.error(bad.join("\n"));
    process.exit(1);
  }
  console.log(`registry ok: ${registry.connectors.length} Verified connectors`);
}
