// Nexo source tests, self-contained: an export with interest, an exchange, a
// term deposit and a move to Nexo Pro gives the holdings Nexo would show, and
// the import refuses a file that isn't a Nexo export or doesn't say whose it is.
// Run with `node --test "connectors/nexo/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nexo from "../src/source.mjs";

const EXPORT = [
  "Transaction,Type,Input Currency,Input Amount,Output Currency,Output Amount,USD Equivalent,Details,Date / Time (UTC)",
  "T1,Top up Crypto,BTC,0.5,BTC,0.5,$30000,approved / BTC deposit,2026-01-02 10:00:00",
  "T2,Interest,BTC,0.001,BTC,0.001,$60,approved / earned,2026-02-01 10:00:00",
  "T3,Exchange,BTC,-0.1,USDC,6000,$6000,approved / BTC to USDC,2026-03-01 10:00:00",
  "T4,Locking Term Deposit,USDC,-1000,USDC,1000,$1000,approved / 1 month,2026-03-02 10:00:00",
  "T5,Transfer To Pro Wallet,USDC,-500,USDC,500,$500,approved / to Pro,2026-03-03 10:00:00",
  "T6,Withdrawal,BTC,-0.05,BTC,0.05,$3000,pending / withdrawal,2026-03-04 10:00:00",
].join("\n");

/** A stand-in for the runtime's context, over an empty folder. */
function ctx() {
  const notes = [];
  return {
    dir: mkdtempSync(join(tmpdir(), "family-crypto-")),
    notes,
    note: (m) => notes.push(m),
    warn: (m) => notes.push(m),
    fail: (m) => {
      throw new Error(m);
    },
  };
}

function exportFile(text = EXPORT) {
  const f = join(mkdtempSync(join(tmpdir(), "nexo-")), "export.csv");
  writeFileSync(f, text);
  return f;
}

test("import, then holdings estimated from the export", () => {
  const c = ctx();
  const r = nexo.commands["import-nexo"](c, [exportFile()], { owner: "Ana" });
  assert.equal(r.owner, "ana");
  assert.equal(r.rows, 6);
  assert.ok(existsSync(join(c.dir, "nexo-ana.csv")));
  assert.deepEqual(nexo.accounts(c).map((a) => a.owner), ["ana"]);
  const held = nexo.balances(c, { owner: "ana" }).map((h) => [h.asset, h.amount, h.estimatedFrom, h.note]);
  // 0.5 + 0.001 - 0.1 BTC; 6000 - 500 USDC (the term deposit stays, the pending withdrawal isn't counted).
  assert.deepEqual(held, [
    ["BTC", 0.401, "export of 2026-03-04", "excludes funds moved to Nexo Pro"],
    ["USDC", 5500, "export of 2026-03-04", "excludes funds moved to Nexo Pro"],
  ]);
});

test("transactions say which export they come from", () => {
  const c = ctx();
  nexo.commands["import-nexo"](c, [exportFile()], { owner: "ana" });
  const rows = nexo.transactions(c, { owner: "ana" }, { asset: "USDC" });
  assert.equal(rows.length, 3);
  assert.deepEqual(c.notes, ["ana: from the export of 2026-03-04"]);
});

test("the import refuses another file, and asks whose it is", () => {
  const c = ctx();
  assert.throws(() => nexo.commands["import-nexo"](c, [exportFile("name,amount\nx,1")], { owner: "ana" }), /doesn't look like a Nexo/);
  assert.throws(() => nexo.commands["import-nexo"](c, [exportFile()], {}), /--owner/);
});
