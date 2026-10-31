// Tests for connectors/wallets/src/chains.mjs against a stand-in fetch: chains read at
// once all keep their holdings, a failing endpoint falls back to the backup,
// and a broken answer is an error, never a zero balance.
// Run with `node --test "connectors/wallets/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CHAINS, walletHoldings } from "../src/chains.mjs";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fetch answering every chain: `answer(url, method)` returns a JSON-RPC result, or a Response to send as is. */
function stand(answer) {
  globalThis.fetch = async (url, opts) => {
    const { method } = JSON.parse(opts.body);
    const out = await answer(String(url), method);
    return out instanceof Response ? out : json({ jsonrpc: "2.0", id: 1, result: out });
  };
}

test("a chain finishing late doesn't drop the holdings of one that finished first", async () => {
  stand(async (url, method) => {
    const eth = url === CHAINS.ethereum.rpcs[0];
    // Ethereum answers at once with 1 ETH; the empty chains answer later.
    if (!eth) await wait(30);
    return method === "eth_getBalance" && eth ? "0xde0b6b3a7640000" : "0x0";
  });
  for (let i = 0; i < 5; i++) {
    const { holdings, errors } = await walletHoldings({ address: ADDRESS });
    assert.deepEqual(errors, []);
    assert.deepEqual(holdings, [{ asset: "ETH", amount: 1, chain: "ethereum" }]);
  }
});

test("a failing endpoint falls back to the chain's backup", async () => {
  const [primary, backup] = CHAINS.ethereum.rpcs;
  stand(async (url, method) => {
    if (url === primary) return new Response("<!DOCTYPE html>Just a moment...", { status: 403 });
    assert.equal(url, backup);
    return method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x0";
  });
  const { holdings, errors } = await walletHoldings({ address: ADDRESS, chains: ["ethereum"] });
  assert.deepEqual(errors, []);
  assert.deepEqual(holdings, [{ asset: "ETH", amount: 1, chain: "ethereum" }]);
});

test("a reply with no result is an error, not an empty wallet", async () => {
  stand(async () => json({ jsonrpc: "2.0", id: 1 }));
  const { holdings, errors } = await walletHoldings({ address: ADDRESS, chains: ["ethereum"] });
  assert.deepEqual(holdings, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^ethereum: eth_getBalance: no result/);
});

test("the source: add asks whose it is, then the wallet is an account and can be removed", async () => {
  const { default: wallets } = await import("../src/source.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ctx = {
    dir: mkdtempSync(join(tmpdir(), "family-crypto-")),
    currency: "EUR",
    value: async () => null,
    note() {},
    warn() {},
    fail: (m) => {
      throw new Error(m);
    },
  };
  stand(async () => "0x0");
  await assert.rejects(wallets.commands["wallet add"](ctx, [ADDRESS], {}), /--owner/);
  const added = await wallets.commands["wallet add"](ctx, [ADDRESS], { owner: "Ana", label: "Ledger", chains: "ethereum" });
  assert.equal(added.wallet.owner, "ana");
  assert.deepEqual(wallets.accounts(ctx), [{ owner: "ana", label: "Ledger", address: ADDRESS, chains: ["ethereum"] }]);
  assert.deepEqual(wallets.commands["wallet remove"](ctx, ["ledger"]), { ok: true, removed: 1 });
  assert.deepEqual(wallets.accounts(ctx), []);
});
