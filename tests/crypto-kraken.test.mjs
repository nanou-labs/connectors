// Tests for tools/crypto with a Kraken key: signs requests the way Kraken
// documents (checked against Kraken's own test vector), reads balances and
// ledger entries, only ever calls read endpoints, and refuses a key that can
// withdraw. Run with `node --test tests/crypto-kraken.test.mjs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const CRYPTO = new URL("../tools/crypto/crypto.mjs", import.meta.url).pathname;
// A made-up secret (base64), as Kraken's docs use one.
const SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg=="; // gitleaks:allow (Kraken's published example secret)

/** Kraken's documented signature, written independently of the tool. */
function sign(path, body, secret) {
  const nonce = new URLSearchParams(body).get("nonce") ?? "";
  const digest = createHash("sha256").update(nonce + body).digest();
  return createHmac("sha512", Buffer.from(secret, "base64")).update(Buffer.concat([Buffer.from(path), digest])).digest("base64");
}

test("the reference signature matches Kraken's published test vector", () => {
  const body = "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25";
  assert.equal(sign("/0/private/AddOrder", body, SECRET), "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==");
});

/** @type {string[]} */
let called = [];
let canWithdraw = false;
/** Every ledger page points to another one (a history longer than the cap). */
let endless = false;
/** @type {string[]} */
let nonces = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (json) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url?.startsWith("/v2/exchange-rates")) return send({ data: { rates: { BTC: "0.00001", ETH: "0.0004", EUR: "1" } } });
    const path = String(req.url);
    called.push(path);
    if (req.headers["api-key"] !== "PUBLICKEY" || req.headers["api-sign"] !== sign(path, body, SECRET)) {
      return send({ error: ["EAPI:Invalid signature"] });
    }
    nonces.push(new URLSearchParams(body).get("nonce") ?? "");
    if (path === "/0/private/WithdrawMethods") return send(canWithdraw ? { error: [], result: [{ asset: "XXBT", method: "Bitcoin" }] } : { error: ["EGeneral:Permission denied"] });
    if (path === "/0/private/BalanceEx") return send({ error: [], result: { XXBT: { balance: "0.5", hold_trade: "0" }, "ETH.F": { balance: "2", hold_trade: "0" }, ZEUR: { balance: "0", hold_trade: "0" } } });
    if (path === "/0/private/Ledgers") {
      const form = new URLSearchParams(body);
      if (endless) {
        const n = Number(form.get("cursor") ?? 0);
        return send({ error: [], result: { ledger: { [`L${n}`]: { refid: `R${n}`, time: 1767225600 - n, type: "trade", subtype: "", asset: "XXBT", amount: "0.1", fee: "0" } }, cursor: { next: String(n + 1) } } });
      }
      if (!form.get("cursor")) {
        return send({ error: [], result: { ledger: { L1: { refid: "R1", time: 1767225600, type: "trade", subtype: "", asset: "XXBT", amount: "0.1", fee: "0.0001" } }, cursor: { next: "c2" } } });
      }
      return send({ error: [], result: { ledger: { L2: { refid: "R2", time: 1764547200, type: "staking", subtype: "", asset: "ETH.F", amount: "0.01", fee: "0" } } } });
    }
    send({ error: ["EGeneral:Unknown method"] });
  });
});
let base = "";
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(() => server.close());
beforeEach(() => {
  called = [];
  nonces = [];
  canWithdraw = false;
  endless = false;
});

/** A crypto dir with Ana's Kraken key. */
function dir(secret = SECRET) {
  const d = mkdtempSync(join(tmpdir(), "family-crypto-"));
  writeFileSync(join(d, "kraken-ana.json"), JSON.stringify({ key: "PUBLICKEY", secret }));
  return d;
}

/** Runs the tool; resolves with its exit code and parsed JSON output. */
function run(d, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CRYPTO, ...args], {
      env: { ...process.env, FAMILY_CRYPTO_DIR: d, FAMILY_KRAKEN_API: base, FAMILY_COINBASE_API: base },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, json: JSON.parse(out) }));
  });
}

test("balances: Kraken holdings with readable asset names and a value", async () => {
  const { code, json } = await run(dir(), "balances", "--source", "kraken");
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(
    json.holdings.map((h) => [h.asset, h.amount, h.valueEUR, h.wallet]),
    [
      ["BTC", 0.5, 50000, "Spot"],
      ["ETH", 2, 5000, "Earn"],
    ],
  );
  assert.equal(json.totalEUR, 55000);
  // The withdrawal probe first, then the read; nothing else.
  assert.deepEqual(called, ["/0/private/WithdrawMethods", "/0/private/BalanceEx"]);
  assert.ok(BigInt(nonces[1]) > BigInt(nonces[0]), "nonces increase");
});

test("transactions: every ledger page, newest first", async () => {
  const { code, json } = await run(dir(), "transactions", "--source", "kraken");
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(
    json.transactions.map((t) => [t.date.slice(0, 10), t.type, t.asset, t.amount]),
    [
      ["2026-01-01", "trade", "BTC", 0.1],
      ["2025-12-01", "staking", "ETH", 0.01],
    ],
  );
});

test("a history longer than the cap says so instead of passing the cap off as the total", async () => {
  endless = true;
  const { code, json } = await run(dir(), "transactions", "--source", "kraken");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.count, 300);
  assert.match(json.partial[0], /kraken ana: only the newest 300 entries were read/);
});

test("a key that can withdraw is refused before anything is read", async () => {
  canWithdraw = true;
  const { code, json } = await run(dir(), "balances", "--source", "kraken");
  assert.equal(code, 1);
  assert.match(json.error, /can withdraw funds/);
  assert.deepEqual(called, ["/0/private/WithdrawMethods"]);
});

test("a key Kraken refuses says how to fix it", async () => {
  const { code, json } = await run(dir("d3Jvbmc="), "balances", "--source", "kraken");
  assert.equal(code, 1);
  assert.match(json.error, /Kraken refused the key of ana .*nanou\.ai → Connectors → Kraken/);
});

test("accounts lists who connected Kraken", async () => {
  const { json } = await run(dir(), "accounts");
  assert.deepEqual(json.kraken, ["ana"]);
});
