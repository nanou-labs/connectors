// Coinbase source tests, self-contained: a local server answers like
// Coinbase, and a stand-in for nanou's runtime context (ctx) turns ctx.fail
// into a thrown error. A sign-in reads with its bearer token, refreshes once
// under a lock when it expires, keeps the rotated refresh token, and is
// refused when it can do more than read.
// Run with `node --test "connectors/coinbase/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

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
      assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
      return send(...refreshAnswer(), 150);
    }
    if (req.url?.startsWith("/v2/accounts")) {
      seenAuth.push(String(req.headers.authorization));
      return send(200, { data: [{ id: "a1", name: "BTC Wallet", currency: { code: "BTC" }, balance: { amount: "0.5", currency: "BTC" } }], pagination: {} });
    }
    send(404, {});
  });
});

/** @type {any} */
let coinbase;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  process.env.FAMILY_COINBASE_API = base;
  process.env.FAMILY_COINBASE_TOKEN_URL = `${base}/token`;
  coinbase = (await import("../src/source.mjs")).default;
});
after(() => server.close());

const now = () => Math.floor(Date.now() / 1000);
const SCOPE = "wallet:accounts:read,wallet:transactions:read,wallet:user:read";

/** A stand-in for the runtime's context, over a folder with Ana's sign-in. */
function ctx(token) {
  const dir = mkdtempSync(join(tmpdir(), "family-crypto-"));
  mkdirSync(join(dir, "coinbase-oauth"), { mode: 0o700 });
  writeFileSync(join(dir, "coinbase-oauth", "client.json"), JSON.stringify({ client_id: "cid", client_secret: "csec" }));
  writeFileSync(join(dir, "coinbase-oauth", "uid-1.json"), JSON.stringify({ id: "uid-1", owner: "ana", name: "Ana", scope: SCOPE, ...token }));
  return {
    dir,
    note() {},
    warn() {},
    fail: (m) => {
      throw new Error(m);
    },
  };
}

test("a fresh sign-in is an account and reads balances with its bearer token", async () => {
  seenAuth = [];
  const c = ctx({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() + 3000 });
  const [login] = coinbase.accounts(c);
  assert.deepEqual(login, { owner: "ana", kind: "oauth", id: "uid-1", name: "Ana" });
  assert.deepEqual(await coinbase.balances(c, login), [{ asset: "BTC", amount: 0.5, wallet: "BTC Wallet" }]);
  assert.deepEqual(seenAuth, ["Bearer at-1"]);
});

test("an expired token is refreshed once by concurrent reads and the rotated refresh token is kept", async () => {
  refreshes = 0;
  seenAuth = [];
  refreshAnswer = () => [200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600, scope: SCOPE }];
  const c = ctx({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() - 1 });
  const [login] = coinbase.accounts(c);
  await Promise.all([1, 2, 3].map(() => coinbase.balances(c, login)));
  assert.equal(refreshes, 1);
  assert.deepEqual([...new Set(seenAuth)], ["Bearer at-2"]);
  const f = join(c.dir, "coinbase-oauth", "uid-1.json");
  assert.equal(JSON.parse(readFileSync(f, "utf8")).refresh_token, "rt-2");
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("a refresh that grants more than reading is refused and not saved", async () => {
  refreshAnswer = () => [200, { access_token: "at-3", refresh_token: "rt-3", expires_in: 3600, scope: `${SCOPE},wallet:transactions:send` }];
  const c = ctx({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() - 1 });
  await assert.rejects(coinbase.balances(c, coinbase.accounts(c)[0]), /more than read-only/);
  assert.equal(JSON.parse(readFileSync(join(c.dir, "coinbase-oauth", "uid-1.json"), "utf8")).refresh_token, "rt-1");
});

test("a dead sign-in says to sign in again", async () => {
  refreshAnswer = () => [400, { error: "invalid_grant" }];
  const c = ctx({ access_token: "at-1", refresh_token: "rt-1", expires_at: now() - 1 });
  await assert.rejects(coinbase.balances(c, coinbase.accounts(c)[0]), /sign in to Coinbase again/);
});
