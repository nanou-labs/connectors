// Watched wallets, for nanou's crypto runtime: public addresses (EVM chains,
// Bitcoin, Solana) anyone in the family sends in chat, read from public
// blockchains (chains.mjs). No keys are involved, nothing can be moved.
// The list lives in <dir>/wallets.json. Self-contained: Node built-ins only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addressKind, CHAINS, walletHoldings } from "./chains.mjs";

/** @typedef {{ address: string, label: string, owner: string, chains?: string[], added: string }} Wallet */

/** @returns {Wallet[]} */
function load(/** @type {any} */ ctx) {
  const path = join(ctx.dir, "wallets.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

/** Atomic, owner-only write. @param {any} ctx @param {Wallet[]} wallets */
function save(ctx, wallets) {
  mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
  const path = join(ctx.dir, "wallets.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(wallets, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** --chains, checked against the chains read for 0x… addresses. @param {any} ctx @param {string} kind @param {Record<string, string>} flags */
function chainsOf(ctx, kind, flags) {
  const chains = flags.chains ? flags.chains.split(",").map((c) => c.trim().toLowerCase()) : undefined;
  const unknown = (chains ?? []).filter((c) => !(c in CHAINS));
  if (kind === "evm" && unknown.length) ctx.fail(`unknown chain ${unknown.join(", ")}; known: ${Object.keys(CHAINS).join(", ")}`);
  return kind === "evm" && chains ? chains : undefined;
}

/** An address from the command line, or a refusal. @param {any} ctx @param {unknown} target */
function addressOf(ctx, target) {
  const address = String(target ?? "").trim();
  const kind = addressKind(address);
  if (!kind) ctx.fail("that doesn't look like a 0x…, Bitcoin or Solana address");
  return { address, kind: /** @type {string} */ (kind) };
}

const round = (/** @type {number} */ n) => Math.round(n * 1e8) / 1e8;

export default {
  help: [
    `crypto wallet add <address> --label "Ledger" --owner ana [--chains ethereum,base]`,
    `                                                  watch an address (0x… on ${Object.keys(CHAINS).join("/")}, Bitcoin, Solana)`,
    "crypto wallet check <address> [--chains ethereum,base]",
    "                                                  look at an address once, without watching it",
    "crypto wallet list | crypto wallet remove <address|label>",
  ],
  howToConnect: ["Wallets: anyone can send a public address in chat (crypto wallet check, then wallet add)."],

  /** Every watched wallet is an account of its owner. */
  accounts: (/** @type {any} */ ctx) => load(ctx).map((w) => ({ owner: w.owner, label: w.label, address: w.address, ...(w.chains ? { chains: w.chains } : {}) })),

  /** A wallet's holdings; a chain that can't be read is reported, never counted as zero. */
  async balances(/** @type {any} */ ctx, /** @type {Wallet} */ w) {
    const { holdings, errors } = await walletHoldings(w);
    for (const e of errors) ctx.warn(`${w.label} ${e}`);
    return holdings.map((h) => ({ asset: h.asset, amount: round(h.amount), wallet: w.label, chain: h.chain }));
  },

  commands: {
    "wallet list": (/** @type {any} */ ctx) => load(ctx),

    async "wallet check"(/** @type {any} */ ctx, /** @type {string[]} */ [target], /** @type {Record<string, string>} */ flags) {
      const { address, kind } = addressOf(ctx, target);
      const chains = chainsOf(ctx, kind, flags);
      const { holdings, errors } = await walletHoldings({ address, ...(chains ? { chains } : {}) });
      const valued = [];
      for (const h of holdings) valued.push({ ...h, amount: round(h.amount), [`value${ctx.currency}`]: await ctx.value(h.amount, h.asset) });
      const total = Math.round(valued.reduce((s, h) => s + (h[`value${ctx.currency}`] ?? 0), 0) * 100) / 100;
      const watched = load(ctx).find((w) => w.address.toLowerCase() === address.toLowerCase());
      return { kind, address, currency: ctx.currency, [`total${ctx.currency}`]: total, holdings: valued, watched: watched ? { label: watched.label, owner: watched.owner } : false, ...(errors.length ? { errors } : {}) };
    },

    async "wallet add"(/** @type {any} */ ctx, /** @type {string[]} */ [target], /** @type {Record<string, string>} */ flags) {
      const { address, kind } = addressOf(ctx, target);
      const wallets = load(ctx);
      if (wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) ctx.fail("already watched; see crypto wallet list");
      const owner = String(flags.owner ?? "").toLowerCase();
      if (!owner) ctx.fail("say whose it is: --owner <name>");
      if (!/^[a-z0-9-]+$/.test(owner)) ctx.fail("owner must be a lowercase name");
      const chains = chainsOf(ctx, kind, flags);
      /** @type {Wallet} */
      const w = { address, label: String(flags.label ?? `${kind} ${address.slice(0, 6)}…${address.slice(-4)}`), owner, ...(chains ? { chains } : {}), added: new Date().toISOString().slice(0, 10) };
      save(ctx, [...wallets, w]);
      const { holdings, errors } = await walletHoldings(w);
      return { ok: true, kind, wallet: w, holdings, ...(errors.length ? { errors } : {}) };
    },

    "wallet remove"(/** @type {any} */ ctx, /** @type {string[]} */ [target]) {
      const t = String(target ?? "").toLowerCase();
      const wallets = load(ctx);
      const kept = wallets.filter((w) => w.address.toLowerCase() !== t && w.label.toLowerCase() !== t);
      if (kept.length === wallets.length) ctx.fail(`no watched wallet ${target}`);
      save(ctx, kept);
      return { ok: true, removed: wallets.length - kept.length };
    },
  },
};
