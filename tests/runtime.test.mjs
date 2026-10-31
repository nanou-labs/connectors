// The crypto runtime end to end, with the real connectors: it adds holdings
// up across sources and values them, honours --source and --owner, merges
// histories with the sources' notes, runs a source's own commands only when
// its manifest declares them, and refuses everything else. Each source runs in
// a process of its own and reads only its own folder.
// Run with `node --test "tests/*.test.mjs"`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const CRYPTO = new URL("../runtime/crypto/crypto.mjs", import.meta.url).pathname;
const SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg=="; // gitleaks:allow (Kraken's published example secret)

const signed = (path, body) => {
  const nonce = new URLSearchParams(body).get("nonce") ?? "";
  const digest = createHash("sha256").update(nonce + body).digest();
  return createHmac("sha512", Buffer.from(SECRET, "base64")).update(Buffer.concat([Buffer.from(path), digest])).digest("base64");
};

// One server plays Coinbase's public rates and Kraken.
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (json) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url?.startsWith("/v2/exchange-rates")) return send({ data: { rates: { BTC: "0.00001", ETH: "0.0004", USDC: "1", EUR: "1" } } });
    const path = String(req.url);
    if (req.headers["api-sign"] !== signed(path, body)) return send({ error: ["EAPI:Invalid signature"] });
    if (path === "/0/private/WithdrawMethods") return send({ error: ["EGeneral:Permission denied"] });
    if (path === "/0/private/BalanceEx") return send({ error: [], result: { XXBT: { balance: "0.5" }, "ETH.F": { balance: "2" } } });
    if (path === "/0/private/Ledgers") {
      return send({ error: [], result: { ledger: { L1: { refid: "R1", time: 1767225600, type: "trade", subtype: "", asset: "XXBT", amount: "0.1", fee: "0" } } } });
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

/** A family's home: Ana's Kraken key and Ben's Nexo export, each in its source's own folder. */
function family() {
  const d = mkdtempSync(join(tmpdir(), "family-home-"));
  const own = (/** @type {string} */ id) => {
    const dir = join(d, ".config", "connectors", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  writeFileSync(join(own("kraken"), "kraken-ana.json"), JSON.stringify({ key: "PUBLICKEY", secret: SECRET }));
  writeFileSync(
    join(own("nexo"), "nexo-ben.csv"),
    "Transaction,Type,Input Currency,Input Amount,Output Currency,Output Amount,USD Equivalent,Details,Date / Time (UTC)\nT1,Top up Crypto,USDC,100,USDC,100,$100,approved / deposit,2026-02-01 10:00:00\n",
  );
  return d;
}

/** Runs the runtime; resolves with its exit code and parsed JSON output. */
function crypto(d, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CRYPTO, ...args], {
      env: { PATH: process.env.PATH, HOME: d, FAMILY_KRAKEN_API: base, FAMILY_COINBASE_API: base },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, json: JSON.parse(out) }));
  });
}

test("balances add up every source, each holding valued", async () => {
  const { code, json } = await crypto(family(), "balances");
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(
    json.holdings.map((h) => [h.source, h.owner, h.asset, h.amount, h.valueEUR]),
    [
      ["kraken", "ana", "BTC", 0.5, 50000],
      ["kraken", "ana", "ETH", 2, 5000],
      ["nexo", "ben", "USDC", 100, 100],
    ],
  );
  assert.equal(json.totalEUR, 55100);
});

test("--source and --owner narrow it down", async () => {
  const d = family();
  const nexo = await crypto(d, "balances", "--source", "nexo");
  assert.deepEqual([...new Set(nexo.json.holdings.map((h) => h.source))], ["nexo"]);
  const ana = await crypto(d, "balances", "--owner", "ana");
  assert.deepEqual([...new Set(ana.json.holdings.map((h) => h.owner))], ["ana"]);
  const nobody = await crypto(d, "balances", "--owner", "zoe");
  assert.equal(nobody.code, 1);
  assert.match(nobody.json.error, /no crypto account is connected/);
});

test("transactions merge sources newest first, with the sources' notes", async () => {
  const { json } = await crypto(family(), "transactions");
  assert.deepEqual(
    json.transactions.map((t) => [t.source, t.date.slice(0, 10)]),
    [
      ["nexo", "2026-02-01"],
      ["kraken", "2026-01-01"],
    ],
  );
  assert.deepEqual(json.notes, ["nexo: ben: from the export of 2026-02-01"]);
});

test("accounts lists every source, without secrets", async () => {
  const { json } = await crypto(family(), "accounts");
  assert.deepEqual(json.kraken, [{ owner: "ana" }]);
  assert.equal(json.nexo[0].owner, "ben");
  assert.deepEqual(json.coinbase, []);
  assert.deepEqual(json.wallet, []);
  assert.doesNotMatch(JSON.stringify(json), /PUBLICKEY|kQH5/);
});

test("a source's own commands run; anything undeclared is refused", async () => {
  const d = family();
  const list = await crypto(d, "wallet", "list");
  assert.equal(list.code, 0);
  assert.deepEqual(list.json, []);
  for (const args of [["withdraw", "BTC"], ["wallet", "send"], ["import-kraken"]]) {
    const r = await crypto(d, ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.json.error, /unknown command/);
  }
});
