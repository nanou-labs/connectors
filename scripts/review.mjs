#!/usr/bin/env node
// The automatic review of one connector folder, wherever it lives (a pull
// request here, or the author's own repository for the Verified track). Every
// check is listed in docs/review.md; a person reviews only what passes.
//
//   node scripts/review.mjs <folder> [--level official|verified] [--json] [--no-tests]
//
// It copies the folder next to this repository's runtimes (as
// connectors/<id>/ in a temporary tree), then checks the files, the manifest
// and logo (scripts/check.mjs rules), that the code implements exactly the
// declared commands, that every host the code names is declared, the imports,
// key-shaped strings, and runs the tests offline (scripts/offline.mjs refuses
// every connection but loopback). Exit code 1 if anything failed.
//
// It imports and runs the connector's code: run it somewhere disposable (CI,
// or nanou's review container with no network).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { contractProblems, LOCALES, logoProblems, readConnector, validate } from "./check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FILES = 200;
const MAX_BYTES = 2_000_000;
/** Node modules a connector's own code may not import: the sandbox refuses their use anyway, so needing them is a bug. */
const FORBIDDEN = new Set([
  "child_process", "cluster", "dgram", "dns", "http", "http2", "https", "inspector", "module",
  "net", "repl", "tls", "vm", "worker_threads", "wasi",
]); // prettier-ignore
/** Hosts the code may name without declaring them (tests' stand-ins, documentation). */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|example\.(com|org|net)|[a-z0-9-]+\.(test|example|invalid|localhost))$/;
/** Key-shaped strings: a pull request with a live key is closed (CONTRIBUTING.md). */
const SECRETS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["Slack token", /\bxox[abeoprs]-[0-9]{6,}-[0-9A-Za-z-]{8,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Stripe key", /\b[rs]k_live_[0-9A-Za-z]{20,}/],
  ["Google key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["GitLab token", /\bglpat-[0-9A-Za-z_-]{20}\b/],
  ["Asana token", /\b[12]\/[0-9]{10,}\/[0-9]{10,}:[0-9a-f]{32}\b/],
]; // prettier-ignore
const SECRET_FILES = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12)$/;

/**
 * The files nanou installs from a folder, by path: regular files only,
 * hidden ones left out (as the installer does). Symlinks are reported.
 * @param {string} dir @returns {{ files: string[], links: string[], hidden: string[] }}
 */
export function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const links = [];
  /** @type {string[]} */
  const hidden = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (e.name.startsWith(".") && e.name !== ".gitignore") {
        hidden.push(rel);
        continue;
      }
      if (lstatSync(p).isSymbolicLink()) links.push(rel);
      else if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk(dir);
  return { files: files.sort(), links, hidden };
}

/**
 * The tree hash Verified entries pin (docs/review.md): SHA-256 of
 * "<sha256 of the file>  <path>\n" for every installed file, sorted by path
 * (what `sha256sum` prints). @param {string} dir @returns {string}
 */
export function treeHash(dir) {
  const lines = listFiles(dir)
    .files.map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}\n`)
    .join("");
  return createHash("sha256").update(lines).digest("hex");
}

/** Every https/http/wss URL's host in a source text. @param {string} src @returns {string[]} */
export function namedHosts(src) {
  const hosts = new Set();
  for (const m of src.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)(?=[/:?#"'`\s]|$)/g)) hosts.add(m[1].toLowerCase());
  // host: "api.example.com" / hostname: '…' in request options
  for (const m of src.matchAll(/\b(?:host|hostname)\s*:\s*["'`]([A-Za-z0-9.-]+\.[A-Za-z]{2,})["'`]/g)) hosts.add(m[1].toLowerCase());
  return [...hosts];
}

/**
 * What a module imports: static, re-exported and literal dynamic imports, and
 * whether it builds code at runtime. @param {string} src
 */
export function imports(src) {
  const specs = new Set();
  for (const m of src.matchAll(/\b(?:import|export)\s[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*["'`]([^"'`]+)["'`]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) specs.add(m[1]);
  const dynamic = /\bimport\s*\(\s*(?!["'`][^"'`$]*["'`]\s*\))/.test(src) || /\brequire\s*\(\s*(?!["'`])/.test(src);
  const builds = /\beval\s*\(|\bnew\s+Function\s*\(|\bprocess\.binding\s*\(|\bprocess\.dlopen\s*\(/.test(src);
  return { specs: [...specs], dynamic, builds };
}

/**
 * Review one connector folder. @param {string} folder
 * @param {{ level?: "official" | "verified", tests?: boolean }} [opts]
 * @returns {Promise<{ id: string | null, level: string, tree: string | null, ok: boolean, checks: { name: string, ok: boolean, problems: string[] }[] }>}
 */
export async function review(folder, opts = {}) {
  const level = opts.level ?? "official";
  /** @type {{ name: string, ok: boolean, problems: string[] }[]} */
  const checks = [];
  const add = (/** @type {string} */ name, /** @type {string[]} */ problems) => checks.push({ name, ok: problems.length === 0, problems });
  const done = (/** @type {string | null} */ id, /** @type {string | null} */ tree) => ({ id, level, tree, ok: checks.every((c) => c.ok), checks });
  const src = resolve(folder);

  // 1. files: what the installer would take.
  if (!existsSync(join(src, "connector.json"))) {
    add("files", ["there's no connector.json in that folder"]);
    return done(null, null);
  }
  const { files, links, hidden } = listFiles(src);
  const bytes = files.reduce((n, f) => n + lstatSync(join(src, f)).size, 0);
  const fileProblems = [];
  if (links.length) fileProblems.push(`no symlinks: ${links.join(", ")}`);
  if (files.length > MAX_FILES) fileProblems.push(`at most ${MAX_FILES} files (${files.length})`);
  if (bytes > MAX_BYTES) fileProblems.push(`at most ${MAX_BYTES / 1_000_000} MB (${(bytes / 1_000_000).toFixed(1)} MB)`);
  for (const need of ["connector.json", "logo.svg", "README.md", "SKILL.md", "i18n/en.json"]) {
    if (!files.includes(need)) fileProblems.push(`${need} is missing`);
  }
  if (!files.some((f) => /^test\/[^/]+\.test\.mjs$/.test(f))) fileProblems.push("test/*.test.mjs is missing: tests on recorded responses are required");
  if (files.some((f) => f === "package.json" || f.startsWith("node_modules/"))) fileProblems.push("no package.json or node_modules: Node built-ins only, no dependencies");
  for (const f of hidden.filter((h) => SECRET_FILES.test(h))) fileProblems.push(`${f}: a secret-looking file (left out by the installer, but don't publish it)`);
  add("files", fileProblems);

  /** @type {any} */
  let m;
  /** @type {Record<string, any>} */
  let text;
  try {
    ({ m, text } = readConnector(dirname(src), relative(dirname(src), src)));
  } catch (err) {
    add("manifest", [`connector.json or an i18n file isn't valid JSON: ${/** @type {Error} */ (err).message}`]);
    return done(null, treeHash(src));
  }
  const id = typeof m?.id === "string" && /^[a-z][a-z0-9-]{1,23}$/.test(m.id) ? m.id : null;
  if (!id) {
    add("manifest", ["id: 2-24 lowercase letters, digits or dashes"]);
    return done(null, treeHash(src));
  }

  // The folder as connectors/<id>/ beside this repository's runtimes, so its tests find runtime/cli.
  const work = mkdtempSync(join(tmpdir(), "nanou-review-"));
  try {
    cpSync(join(ROOT, "runtime"), join(work, "runtime"), { recursive: true });
    for (const f of files) cpSync(join(src, f), join(work, "connectors", id, f));
    const base = join(work, "connectors");

    // 2. manifest and logo: the same rules as every connector here.
    let manifest = [];
    try {
      validate(m, id, text, LOCALES, base);
    } catch (err) {
      manifest = /** @type {Error} */ (err).message.split("\n").slice(1).map((l) => l.trim());
    }
    add("manifest", manifest.filter((p) => !p.startsWith("logo")));
    add("logo", existsSync(join(src, "logo.svg")) ? logoProblems(readFileSync(join(src, "logo.svg"), "utf8")) : ["logo.svg is missing"]);

    // 3. the Verified shape: a command of its own, run by runtime/cli, set up by a key or nothing.
    if (level === "verified") {
      const shape = [];
      const official = existsSync(join(ROOT, "connectors"))
        ? readdirSync(join(ROOT, "connectors"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];
      if (official.includes(id) && resolve(ROOT, "connectors", id) !== src) shape.push(`id: "${id}" is an Official connector's`);
      if (m.tool?.bin !== id) shape.push("tool.bin: a Verified connector's command is its id (runtime/cli)");
      if (m.tool?.runs !== undefined || m.tool?.policy !== undefined || m.binaries !== undefined) shape.push("no program of its own (tool.runs, tool.policy, binaries): Official connectors only");
      if (!["api_key", "none"].includes(m.auth?.kind)) shape.push('auth.kind: "api_key" or "none"');
      add("shape", shape);
    }

    // 4. the code implements exactly the declared commands (imports the module: no network here).
    let contract;
    try {
      contract = manifest.length ? ["skipped: fix the manifest first"] : await contractProblems(m, base);
    } catch (err) {
      contract = [`the module doesn't load: ${/** @type {Error} */ (err).message}`];
    }
    add("contract", contract);

    // 5. code: hosts it names, imports, nothing built at runtime.
    const network = new Set(Array.isArray(m.network) ? m.network : []);
    const hostProblems = [];
    const codeProblems = [];
    for (const f of files.filter((x) => /^src\/.+\.(mjs|js|cjs)$/.test(x))) {
      const code = readFileSync(join(src, f), "utf8");
      for (const h of namedHosts(code)) if (!network.has(h) && !LOCAL.test(h)) hostProblems.push(`${f} names ${h}, which isn't in network`);
      const { specs, dynamic, builds } = imports(code);
      for (const s of specs) {
        const bare = s.replace(/^node:/, "").split("/")[0];
        if (s.startsWith(".")) {
          const target = resolve(dirname(join(src, f)), s);
          if (target !== src && !target.startsWith(src + sep)) codeProblems.push(`${f} imports ${s}, outside its folder`);
        } else if (!s.startsWith("node:") && !/^[a-z_]+$/.test(s)) codeProblems.push(`${f} imports ${s}: Node built-ins only, no dependencies`);
        // A connector that runs its own program (gh, Official only) starts it.
        else if (FORBIDDEN.has(bare) && !(bare === "child_process" && m.tool?.runs === "entry")) codeProblems.push(`${f} imports ${s}: use fetch() (the sandbox allows no sockets, processes or code loading)`);
      }
      if (dynamic) codeProblems.push(`${f} imports or requires a computed name`);
      if (builds) codeProblems.push(`${f} builds code at runtime (eval, new Function, process.binding)`);
    }
    add("hosts", hostProblems);
    add("code", codeProblems);

    // 6. key-shaped strings, in every file.
    const secretProblems = [];
    for (const f of files) {
      if (SECRET_FILES.test(f)) secretProblems.push(`${f}: a secret-looking file`);
      const body = readFileSync(join(src, f), "utf8");
      for (const line of body.split("\n")) {
        if (line.includes("gitleaks:allow")) continue;
        for (const [what, re] of SECRETS) if (re.test(line)) secretProblems.push(`${f}: looks like a ${what}`);
      }
    }
    add("secrets", [...new Set(secretProblems)]);

    // 7. the tests, offline: any connection but loopback is refused and reported.
    if (opts.tests !== false) {
      const testFiles = files.filter((f) => /^test\/[^/]+\.test\.mjs$/.test(f)).map((f) => join("connectors", id, f));
      if (testFiles.length === 0) add("tests", ["no tests to run"]);
      else {
        const log = join(work, "offline.log");
        const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
          cwd: work,
          encoding: "utf8",
          timeout: 180_000,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: work,
            NODE_OPTIONS: `--import=${join(ROOT, "scripts", "offline.mjs")}`,
            NANOU_OFFLINE_LOG: log,
          },
        });
        const tests = [];
        const passed = Number(/^# pass (\d+)/m.exec(run.stdout ?? "")?.[1] ?? 0);
        if (run.status !== 0) {
          const failing = [...(run.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1]);
          tests.push(run.error ? `the tests didn't finish: ${run.error.message}` : `tests failed${failing.length ? `: ${failing.slice(0, 5).join("; ")}` : ""}`);
        } else if (passed === 0) tests.push("no test ran");
        if (existsSync(log)) {
          const refused = [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))];
          if (refused.length) tests.push(`tests tried the network (${refused.join(", ")}): use recorded responses on a local stand-in`);
        }
        add("tests", tests);
      }
    }
    return done(id, treeHash(src));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--level");
  const level = args.includes("--level") ? args[args.indexOf("--level") + 1] : "official";
  if (!folder || !["official", "verified"].includes(level)) {
    console.error("usage: node scripts/review.mjs <connector folder> [--level official|verified] [--json] [--no-tests]");
    process.exit(2);
  }
  const report = await review(folder, { level: /** @type {"official" | "verified"} */ (level), tests: !args.includes("--no-tests") });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    for (const c of report.checks) console.log(c.ok ? `ok ${c.name}` : `FAIL ${c.name}:\n  ${c.problems.join("\n  ")}`);
    console.log(report.ok ? `${report.id}: every check passed (tree ${report.tree})` : `${report.id ?? folder}: fix the above`);
  }
  process.exit(report.ok ? 0 : 1);
}
