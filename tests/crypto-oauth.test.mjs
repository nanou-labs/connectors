// Tests for tools/crypto with a "Sign in with Coinbase" token: reads with the
// bearer token, refreshes once under a lock when it expires, keeps the rotated
// refresh token, and refuses a token that can do more than read.
// Run with `node --test tests/crypto-oauth.test.mjs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const CRYPTO = new URL("../tools/crypto/crypto.mjs", import.meta.url).pathname;
let refreshes = 0;
/** @type {() => [number, object]} */
let refreshAnswer = () => [200, {}];
/** @type {string[]} */
let seenAuth = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, json, delay = 0) =>
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      }, delay);
    if (req.url === "/token") {
      refreshes++;
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), "refresh_token");
      return send(...refreshAnswer(), 150);
    }
    if (req.url?.startsWith("/v2/exchange-rates")) return send(200, { data: { rates: { BTC: "0.00001", EUR: "1" } } });
    if (req.url?.startsWith("/v2/accounts")) {
      seenAuth.push(String(req.headers.authorization));
      return send(200, { data: [{ id: "a1", name: "BTC Wallet", currency: { code: "BTC" }, balance: { amount: "0.5", currency: "BTC" } }], pagination: {} });
    }
    send(404, {});
  });
});
let base = "";
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(() => server.close());

const now = () => Math.floor(Date.now() / 1000);
const SCOPE = "wallet:accounts:read,wallet:transactions:read,wallet:user:read";

/** A crypto dir with one sign-in. */
function dir(token) {
  const d = mkdtempSync(join(tmpdir(), "family-crypto-"));
  mkdirSync(join(d, "coinbase-oauth"), { mode: 0o700 });
  writeFileSync(join(d, "coinbase-oauth", "client.json"), JSON.stringify({ client_id: "cid", client_secret: "csec" }));
  writeFileSync(join(d, "coinbase-oauth", "uid-1.json"), JSON.stringify({ id: "uid-1", owner: "ana", name: "Ana", scope: SCOPE, ...token }));
  return d;
}

function crypto(d, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CRYPTO, ...args], {
      env: { PATH: process.env.PATH, HOME: d, FAMILY_CRYPTO_DIR: d, FAMILY_COINBASE_API: base, FAMILY_COINBASE_TOKEN_URL: `${base}/token` },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("exit", (code) => resolve({ code, json: JSON.parse(out || "{}") }));
  });
}

test("a fresh sign-in reads balances with its bearer token", async () => {
  seenAuth = [];
  const d = dir({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() + 3000 });
  const r = await crypto(d, ["balances", "--source", "coinbase"]);
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(r.json.holdings[0].owner, "ana");
  assert.equal(r.json.holdings[0].amount, 0.5);
  assert.deepEqual(seenAuth, ["Bearer at-1"]);
  const acc = await crypto(d, ["accounts"]);
  assert.deepEqual(acc.json.coinbase, ["ana"]);
});

test("an expired token is refreshed once by concurrent runs and the rotated refresh token is kept", async () => {
  refreshes = 0;
  seenAuth = [];
  refreshAnswer = () => [200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600, scope: SCOPE }];
  const d = dir({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() - 1 });
  const runs = await Promise.all([1, 2, 3].map(() => crypto(d, ["balances", "--source", "coinbase", "--owner", "ana"])));
  for (const r of runs) assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(refreshes, 1);
  assert.deepEqual([...new Set(seenAuth)], ["Bearer at-2"]);
  const f = join(d, "coinbase-oauth", "uid-1.json");
  const saved = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(saved.refresh_token, "rt-2");
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("a refresh that grants more than reading is refused and not saved", async () => {
  refreshAnswer = () => [200, { access_token: "at-3", refresh_token: "rt-3", expires_in: 3600, scope: `${SCOPE},wallet:transactions:send` }];
  const d = dir({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() - 1 });
  const r = await crypto(d, ["balances", "--source", "coinbase"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /more than read-only/);
  assert.equal(JSON.parse(readFileSync(join(d, "coinbase-oauth", "uid-1.json"), "utf8")).refresh_token, "rt-1");
});

test("a dead sign-in says to sign in again", async () => {
  refreshAnswer = () => [400, { error: "invalid_grant" }];
  const d = dir({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() - 1 });
  const r = await crypto(d, ["balances", "--source", "coinbase"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /sign in to Coinbase again/);
});
