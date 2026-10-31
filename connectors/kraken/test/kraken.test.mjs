// Kraken source tests, self-contained: a local server answers like Kraken,
// and a stand-in for nanou's runtime context (ctx) collects notes and turns
// ctx.fail into a thrown error. Checks the signature against Kraken's
// published test vector, the read-only endpoints, the withdrawal refusal and
// paging. Run with `node --test "connectors/kraken/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

// A made-up secret (base64), as Kraken's docs use one.
const SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg=="; // gitleaks:allow (Kraken's published example secret)

/** Kraken's documented signature, written independently of the source. */
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

/** @type {any} */
let kraken;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.FAMILY_KRAKEN_API = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  kraken = (await import("../src/source.mjs")).default;
});
after(() => server.close());
beforeEach(() => {
  called = [];
  nonces = [];
  canWithdraw = false;
  endless = false;
});

/** A stand-in for the runtime's context, over a folder holding Ana's key. */
function ctx(secret = SECRET) {
  const dir = mkdtempSync(join(tmpdir(), "family-crypto-"));
  writeFileSync(join(dir, "kraken-ana.json"), JSON.stringify({ key: "PUBLICKEY", secret }));
  const notes = [];
  return {
    dir,
    notes,
    note: (m) => notes.push(m),
    warn: (m) => notes.push(m),
    fail: (m) => {
      throw new Error(m);
    },
  };
}

test("accounts: one per connected key", () => {
  assert.deepEqual(kraken.accounts(ctx()), [{ owner: "ana" }]);
});

test("balances: readable asset names, staked holdings as Earn", async () => {
  const holdings = await kraken.balances(ctx(), { owner: "ana" });
  assert.deepEqual(holdings, [
    { asset: "BTC", amount: 0.5, wallet: "Spot" },
    { asset: "ETH", amount: 2, wallet: "Earn" },
  ]);
  // The withdrawal probe first, then the read; nothing else.
  assert.deepEqual(called, ["/0/private/WithdrawMethods", "/0/private/BalanceEx"]);
  assert.ok(BigInt(nonces[1]) > BigInt(nonces[0]), "nonces increase");
});

test("transactions: every ledger page", async () => {
  const rows = await kraken.transactions(ctx(), { owner: "ana" }, {});
  assert.deepEqual(
    rows.map((t) => [t.date.slice(0, 10), t.type, t.asset, t.amount]),
    [
      ["2026-01-01", "trade", "BTC", 0.1],
      ["2025-12-01", "staking", "ETH", 0.01],
    ],
  );
});

test("a history longer than the cap says so instead of passing the cap off as the total", async () => {
  endless = true;
  const c = ctx();
  const rows = await kraken.transactions(c, { owner: "ana" }, {});
  assert.equal(rows.length, 300);
  assert.match(c.notes[0], /ana: only the newest 300 entries were read/);
});

test("a key that can withdraw is refused before anything is read", async () => {
  canWithdraw = true;
  await assert.rejects(kraken.balances(ctx(), { owner: "ana" }), /can withdraw funds/);
  assert.deepEqual(called, ["/0/private/WithdrawMethods"]);
});

test("a key Kraken refuses says how to fix it", async () => {
  await assert.rejects(kraken.balances(ctx("d3Jvbmc="), { owner: "ana" }), /Kraken refused the key of ana .*nanou\.ai → Connectors → Kraken/);
});
