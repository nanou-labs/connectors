#!/usr/bin/env node
// gh: the GitHub CLI with the family member's own GitHub access, read-only
// unless family-guard lifts it for one approved command.
//
// - Wraps the official `gh` (bin/gh-cli in this connector's folder, fetched and
//   checked by nanou's image from the manifest's `binaries`) and hands
//   it a GitHub App user token through GH_TOKEN, with a fresh, empty gh config
//   per run (no aliases or extensions can hide a write).
// - GITHUB_READONLY=1 (the container's default, and the default when unset):
//   only reads run (policy.mjs, the same list nanou's gateway builds the
//   approval cards from). Comments, issues, pull requests, merges, branch
//   pushes... need GITHUB_READONLY=0, which only family-guard sets, for one
//   command the owner approved in the nanou app.
// - Never runs `gh auth` (other than status), extensions, aliases, secrets or
//   repository admin commands, approved or not.
//
// Extra words of this wrapper:
//   gh --account <login> …   use one of the connected accounts (needed when there are several)
//   gh accounts              the connected accounts (JSON), with when their access ends
//   gh git <git args>        git with the token for https://github.com (push needs a card)
//
// Tokens: ~/.config/connectors/github/<login>.json, installed by the nanou
// provisioner after the person approved nanou's GitHub App on
// github.com/login/device (device flow, no client secret):
//   { login, owner, client_id, access_token, expires_at, refresh_token, refresh_expires_at }
// Access tokens last 8 hours and are refreshed here when they have under 5
// minutes left; GitHub rotates the refresh token on every refresh, so it is
// done under a lock file and written atomically (a crash leaves the old file).

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ghKind, splitAccount } from "./policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.FAMILY_GITHUB_DIR ?? join(homedir(), ".config", "connectors", "github");
const REAL = process.env.FAMILY_GH_BIN ?? join(HERE, "..", "bin", "gh-cli");
const OAUTH = process.env.FAMILY_GITHUB_OAUTH_URL ?? "https://github.com/login/oauth/access_token";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REFRESH_MARGIN_S = 300;
const RECONNECT = "Reconnect it on nanou.ai → Connectors → GitHub.";

/** @param {string} msg */
function fail(msg, code = 1) {
  process.stderr.write(`gh: ${msg}\n`);
  process.exit(code);
}

const now = () => Math.floor(Date.now() / 1000);

/** Logins with a token file. */
function accounts() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((l) => LOGIN.test(l))
    .sort();
}

/** @param {string} login */
const fileOf = (login) => join(DIR, `${login}.json`);

/** @param {string} file */
function load(file) {
  try {
    const t = JSON.parse(readFileSync(file, "utf8"));
    if (!t?.access_token) throw new Error("no token");
    return t;
  } catch {
    return fail(`the GitHub access in ${file.split("/").pop()} is unreadable. ${RECONNECT}`);
  }
}

/** Which account to use: the one named, else the only one. @param {string | null} account */
function pick(account) {
  const all = accounts();
  if (account !== null) {
    const hit = all.find((a) => a.toLowerCase() === account.toLowerCase());
    if (!hit) fail(`no GitHub account "${account}" is connected (connected: ${all.join(", ") || "none"}).`);
    return hit;
  }
  if (all.length === 1) return all[0];
  if (all.length === 0) fail("no GitHub account is connected yet. Connect one on nanou.ai → Connectors → GitHub.");
  return fail(`several GitHub accounts are connected; start with --account <login> (one of: ${all.join(", ")}).`);
}

/** Write a JSON file readable only by the family, atomically. @param {string} file @param {unknown} data */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (i > 120) fail("another GitHub refresh is stuck; try again in a minute.");
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

/** A user token with more than 5 minutes left, refreshed if needed. @param {string} login */
async function token(login) {
  const file = fileOf(login);
  const fresh = (/** @type {any} */ t) => !t.expires_at || t.expires_at - now() > REFRESH_MARGIN_S;
  const first = load(file);
  if (fresh(first)) return first.access_token;
  return locked(file, async () => {
    const t = load(file); // another run may have refreshed it meanwhile
    if (fresh(t)) return t.access_token;
    if (!t.refresh_token || (t.refresh_expires_at && t.refresh_expires_at <= now())) {
      return fail(`the GitHub access of ${login} has expired. ${RECONNECT}`);
    }
    let res;
    try {
      res = await fetch(OAUTH, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: t.client_id, grant_type: "refresh_token", refresh_token: t.refresh_token }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return fail(`GitHub didn't answer the token refresh (${/** @type {Error} */ (err).message}); try again.`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      const reason = String(j.error ?? `HTTP ${res.status}`).slice(0, 60);
      return fail(
        reason === "bad_refresh_token" || reason === "unauthorized"
          ? `GitHub no longer accepts the access of ${login}. ${RECONNECT}`
          : `GitHub refused the token refresh (${reason}); try again.`,
      );
    }
    const t2 = now();
    writeAtomic(file, {
      ...t,
      access_token: j.access_token,
      expires_at: j.expires_in ? t2 + Number(j.expires_in) : null,
      refresh_token: j.refresh_token ?? t.refresh_token,
      refresh_expires_at: j.refresh_token_expires_in ? t2 + Number(j.refresh_token_expires_in) : t.refresh_expires_at ?? null,
      refreshed_at: t2,
    });
    return j.access_token;
  });
}

/** Run a program with the token, a throwaway gh config and git hooks off; exit with its code. */
function run(/** @type {string} */ bin, /** @type {string[]} */ args, /** @type {string | null} */ tok) {
  const config = mkdtempSync(join(tmpdir(), "family-gh-"));
  const env = { ...process.env };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete env[k];
  Object.assign(env, {
    ...(tok ? { GH_TOKEN: tok } : {}),
    GH_CONFIG_DIR: config,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    // No repository hook runs while the token is in the environment.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  });
  const child = spawn(bin, args, { stdio: "inherit", env });
  const done = (/** @type {number} */ code) => {
    rmSync(config, { recursive: true, force: true });
    process.exit(code);
  };
  child.on("error", (err) => {
    process.stderr.write(`gh: couldn't start ${bin.split("/").pop()} (${err.message})\n`);
    done(127);
  });
  child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
}

/** git that answers GitHub's credential request with the token (and nothing else). */
const CREDENTIAL =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

async function main() {
  const argv = process.argv.slice(2);
  const { account, rest } = splitAccount(argv);
  if (account !== null && !LOGIN.test(account)) fail("--account takes a GitHub login.");
  const kind = ghKind(argv);
  if (kind === "blocked") {
    fail("that command isn't allowed here (it would show or change credentials, install extensions or administer a repository).", 2);
  }
  if (kind === "write" && process.env.GITHUB_READONLY !== "0") {
    fail(
      "read-only: this would change something on GitHub. Run the same command again as is: family-guard asks the owner with an approval card and runs it once they approve.",
      3,
    );
  }
  if (rest[0] === "accounts") {
    const out = accounts().map((login) => {
      const t = load(fileOf(login));
      return {
        login,
        owner: t.owner ?? null,
        accessUntil: t.refresh_expires_at ? new Date(t.refresh_expires_at * 1000).toISOString().slice(0, 10) : null,
      };
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  // Help and version need no account.
  if (rest.length === 0 || rest[0] === "help" || rest[0] === "version" || rest.includes("--help") || rest.includes("-h") || rest[0] === "--version") {
    return run(REAL, rest, null);
  }
  const tok = await token(pick(account));
  if (rest[0] === "git") {
    const helper = ["-c", "credential.https://github.com.helper=", "-c", `credential.https://github.com.helper=${CREDENTIAL}`];
    return run("git", [...helper, ...rest.slice(1)], tok);
  }
  return run(REAL, rest, tok);
}

main().catch((err) => fail(err?.message ?? String(err)));
