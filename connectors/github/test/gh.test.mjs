// Tests for the GitHub connector's `gh` wrapper (src/gh.mjs): read-only by
// default, token handed to the real gh, refresh under a lock with the rotated
// refresh token written atomically. Run with `node --test "connectors/github/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const WRAPPER = new URL("../src/gh.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "family-gh-test-"));
const fake = join(dir, "gh-cli");
// The real gh, faked: prints what it got.
writeFileSync(
  fake,
  `#!/bin/sh\nprintf '{"args":"%s","token":"%s","config":"%s"}\\n' "$*" "$GH_TOKEN" "$GH_CONFIG_DIR"\n`,
);
chmodSync(fake, 0o755);

let refreshes = 0;
/** @type {(form: URLSearchParams) => [number, object]} */
let answer = () => [200, {}];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    refreshes++;
    const [status, json] = answer(new URLSearchParams(body));
    // A slow answer, so concurrent runs really overlap.
    setTimeout(() => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    }, 150);
  });
});
let url = "";
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/token`;
});
after(() => server.close());

/** A fresh token store. @param {Record<string, object>} files */
function store(files) {
  const d = mkdtempSync(join(dir, "store-"));
  for (const [login, t] of Object.entries(files)) writeFileSync(join(d, `${login}.json`), JSON.stringify(t));
  return d;
}

/** Run the wrapper. @returns {Promise<{ code: number, out: string, err: string }>} */
function gh(/** @type {string} */ store_, /** @type {string[]} */ args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [WRAPPER, ...args], {
      env: { PATH: process.env.PATH, HOME: dir, FAMILY_GITHUB_DIR: store_, FAMILY_GH_BIN: fake, FAMILY_GITHUB_OAUTH_URL: url, ...env },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const now = () => Math.floor(Date.now() / 1000);
const fresh = (login, extra = {}) => ({ login, client_id: "Iv1.test", access_token: `ghu_${login}`, expires_at: now() + 3600, refresh_token: `ghr_${login}`, refresh_expires_at: now() + 86400, ...extra });

test("a read runs with the token and a throwaway gh config", async () => {
  const s = store({ ana: fresh("ana") });
  const r = await gh(s, ["pr", "list", "-R", "nanou/app"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.args, "pr list -R nanou/app");
  assert.equal(j.token, "ghu_ana");
  assert.match(j.config, /family-gh-/);
});

test("a write is refused unless family-guard lifted read-only", async () => {
  const s = store({ ana: fresh("ana") });
  const r = await gh(s, ["pr", "merge", "12"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /read-only/);
  assert.equal(r.out, "");
  const ok = await gh(s, ["pr", "merge", "12"], { GITHUB_READONLY: "0" });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).args, "pr merge 12");
});

test("credential and admin commands never run, even approved", async () => {
  const s = store({ ana: fresh("ana") });
  for (const args of [["auth", "token"], ["extension", "install", "x/y"], ["alias", "set", "a", "b"]]) {
    const r = await gh(s, args, { GITHUB_READONLY: "0" });
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.out, "");
  }
});

test("several accounts need --account; the named one is used", async () => {
  const s = store({ ana: fresh("ana"), "ana-work": fresh("ana-work") });
  const r = await gh(s, ["issue", "list"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--account/);
  const w = await gh(s, ["--account", "ana-work", "issue", "list"]);
  assert.equal(JSON.parse(w.out).token, "ghu_ana-work");
  const list = await gh(s, ["accounts"]);
  assert.deepEqual(JSON.parse(list.out).map((a) => a.login), ["ana", "ana-work"]);
});

test("an expiring token is refreshed once, even by concurrent runs, and the rotated refresh token is kept", async () => {
  refreshes = 0;
  answer = (form) => {
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "ghr_ana");
    assert.equal(form.get("client_secret"), null);
    return [200, { access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15897600 }];
  };
  const s = store({ ana: fresh("ana", { expires_at: now() + 10 }) });
  const runs = await Promise.all([1, 2, 3].map(() => gh(s, ["pr", "list"])));
  for (const r of runs) {
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).token, "ghu_new");
  }
  assert.equal(refreshes, 1);
  const saved = JSON.parse(readFileSync(join(s, "ana.json"), "utf8"));
  assert.equal(saved.refresh_token, "ghr_new");
  assert.ok(saved.expires_at > now() + 28000);
  assert.equal(statSync(join(s, "ana.json")).mode & 0o777, 0o600);
});

test("a refused refresh says to reconnect and keeps the file", async () => {
  answer = () => [200, { error: "bad_refresh_token" }];
  const t = fresh("ana", { expires_at: now() - 5 });
  const s = store({ ana: t });
  const r = await gh(s, ["pr", "list"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Reconnect/);
  assert.deepEqual(JSON.parse(readFileSync(join(s, "ana.json"), "utf8")), t);
});
