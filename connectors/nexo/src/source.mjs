// Nexo, for nanou's crypto runtime. Nexo has no API for its main app, so
// this reads the transaction CSV the person exports from the app
// (Transactions → Export), saved as <dir>/nexo-<owner>.csv by nanou's
// installer or by `crypto import-nexo <file> --owner <name>`. Balances are an
// estimate from that file. Self-contained: Node built-ins only.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Minimal RFC 4180 CSV parser. @param {string} text @returns {string[][]} */
export function csv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** The column whose name matches. @param {string[]} header @param {RegExp} re */
const col = (header, re) => header.map((h) => h.trim()).find((h) => re.test(h));

/** Rows of an owner's export as objects keyed by header. @param {string} file */
function rowsOf(file) {
  const [header, ...rows] = csv(readFileSync(file, "utf8").replace(/^﻿/, ""));
  const dateCol = col(header, /date/i);
  const dates = dateCol ? rows.map((r) => r[header.findIndex((h) => h.trim() === dateCol)] ?? "").filter(Boolean).sort() : [];
  return {
    // The newest transaction in the file, else when it was imported.
    exported: dates.at(-1) ?? statSync(file).mtime.toISOString(),
    header,
    rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()]))),
  };
}

/** Transactions as normalised rows. @param {string} file */
export function transactionsOf(file) {
  const { header, rows, exported } = rowsOf(file);
  const c = {
    date: col(header, /date/i),
    type: col(header, /^type$/i),
    inCur: col(header, /input currency/i),
    inAmt: col(header, /input amount/i),
    outCur: col(header, /output currency/i),
    outAmt: col(header, /output amount/i),
    usd: col(header, /usd|equivalent/i),
    details: col(header, /details/i),
  };
  return {
    exported,
    txs: rows.map((r) => ({
      date: c.date ? r[c.date] : undefined,
      type: c.type ? r[c.type] : undefined,
      in: c.inCur ? `${r[c.inAmt] ?? ""} ${r[c.inCur]}`.trim() : undefined,
      out: c.outCur ? `${r[c.outAmt] ?? ""} ${r[c.outCur]}`.trim() : undefined,
      usd: c.usd ? r[c.usd] : undefined,
      details: c.details ? r[c.details] : undefined,
      raw: c.type ? undefined : r,
    })),
  };
}

/** Row types that convert one asset into another inside Nexo. */
const EXCHANGES = new Set(["exchange", "exchange to withdraw", "exchange deposited on"]);
/** Row types that only move funds between Nexo's own savings and term wallets. */
const INTERNAL = /^(locking|unlocking) term deposit$/i;

/**
 * Holdings estimated from the export. The Output Amount is always positive
 * and the direction is in the sign of the Input Amount:
 * - exchanges spend |input| of the input asset and credit the output asset
 *   (an output of 0, as in "Exchange Deposited On", credits |input| 1:1);
 * - term deposit locking/unlocking stays inside Nexo and is skipped;
 * - everything else (interest, top-ups, withdrawals, transfers to and from
 *   the Nexo Pro wallet) changes the input asset by the signed input amount.
 * Funds moved to Nexo Pro leave this estimate (Pro is a separate account).
 * @param {string} file
 */
export function estimate(file) {
  const { txs, exported } = transactionsOf(file);
  /** @type {Record<string, number>} */
  const held = {};
  const add = (/** @type {string} */ asset, /** @type {number} */ n) => (held[asset] = (held[asset] ?? 0) + n);
  const num = (/** @type {string | undefined} */ s) => Number(String(s ?? "").replace(/[^0-9.eE+\-]/g, "")) || 0;
  let toPro = 0;
  for (const t of txs) {
    const [inAmt, inCur] = (t.in ?? "").split(" ");
    const [outAmt, outCur] = (t.out ?? "").split(" ");
    const type = String(t.type ?? "").trim().toLowerCase();
    if (!/^approved/i.test(t.details ?? "approved") || INTERNAL.test(type) || !inCur) continue;
    if (EXCHANGES.has(type)) {
      add(inCur, -Math.abs(num(inAmt)));
      if (outCur) add(outCur, num(outAmt) > 0 ? num(outAmt) : Math.abs(num(inAmt)));
    } else {
      add(inCur, num(inAmt));
      if (type === "transfer to pro wallet") toPro++;
    }
  }
  // A clearly negative net means the export misses rows for that asset.
  const gaps = Object.entries(held)
    .filter(([, amount]) => amount < -0.01)
    .map(([asset, amount]) => `${Math.round(amount * 100) / 100} ${asset}`);
  return Object.entries(held)
    .filter(([, amount]) => amount > 1e-6)
    .map(([asset, amount]) => ({
      asset,
      amount: Math.round(amount * 1e8) / 1e8,
      // Nexo's "…X" codes (USDX, EURX) are priced as the asset they track.
      priceAs: asset.replace(/X$/, ""),
      estimatedFrom: `export of ${exported.slice(0, 10)}`,
      ...(toPro ? { note: "excludes funds moved to Nexo Pro" } : {}),
      ...(gaps.length ? { gaps: `the export doesn't add up for ${gaps.join(", ")}; figures may be incomplete` } : {}),
    }));
}

const fileOf = (/** @type {any} */ ctx, /** @type {string} */ owner) => join(ctx.dir, `nexo-${owner}.csv`);

export default {
  help: ["crypto import-nexo <file.csv> --owner ana        store a Nexo transaction export"],
  howToConnect: ["Nexo: send the app's transaction CSV export, then crypto import-nexo."],

  /** Who imported an export, and when. */
  accounts(/** @type {any} */ ctx) {
    if (!existsSync(ctx.dir)) return [];
    return readdirSync(ctx.dir)
      .filter((f) => /^nexo-[a-z0-9-]+\.csv$/.test(f))
      .map((f) => {
        const owner = f.slice("nexo-".length, -".csv".length);
        return { owner, imported: statSync(join(ctx.dir, f)).mtime.toISOString().slice(0, 10) };
      });
  },

  balances: (/** @type {any} */ ctx, /** @type {{ owner: string }} */ { owner }) => estimate(fileOf(ctx, owner)),

  transactions(/** @type {any} */ ctx, /** @type {{ owner: string }} */ { owner }, /** @type {{ asset?: string }} */ q) {
    const { txs, exported } = transactionsOf(fileOf(ctx, owner));
    ctx.note(`${owner}: from the export of ${exported.slice(0, 10)}`);
    return txs.filter((t) => !q.asset || `${t.in} ${t.out}`.toUpperCase().includes(q.asset));
  },

  commands: {
    /** crypto import-nexo <file.csv> --owner <name> */
    "import-nexo"(/** @type {any} */ ctx, /** @type {string[]} */ [file], /** @type {Record<string, string>} */ flags) {
      if (!file || !existsSync(file)) ctx.fail("give the path of the Nexo CSV export");
      const [header] = csv(readFileSync(file, "utf8").replace(/^﻿/, ""));
      if (!header || !header.some((h) => /type/i.test(h)) || !header.some((h) => /currency/i.test(h))) {
        ctx.fail("that doesn't look like a Nexo transaction export (expected columns like Type, Input Currency, Output Currency)");
      }
      const owner = String(flags.owner ?? "").toLowerCase();
      if (!owner) ctx.fail("say whose it is: --owner <name>");
      if (!/^[a-z0-9-]+$/.test(owner)) ctx.fail("owner must be a lowercase name");
      mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
      copyFileSync(file, fileOf(ctx, owner));
      const { txs } = transactionsOf(fileOf(ctx, owner));
      return { ok: true, owner, rows: txs.length, newest: txs.map((t) => t.date).sort().at(-1), columns: header };
    },
  },
};
