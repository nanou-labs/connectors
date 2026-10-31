# The crypto runtime and its source contract

`crypto` is nanou's command for everything crypto. It belongs to nanou, not
to a service: each source (Coinbase, Kraken, Nexo, wallets…) is a connector
folder whose manifest says `"tool": { "bin": "crypto", "source": "<name>" }`
and whose `entry` module implements the contract below. The runtime finds
them, asks each for its accounts, adds holdings up across sources, values
them in the person's currency, merges histories, and runs a source's own
commands only when its manifest declares them.

```
crypto accounts | balances | transactions | prices    answered by the runtime, from every source
crypto <a command a manifest declares>                 run by that source (`wallet add`, `import-nexo`)
```

## The contract

`src/source.mjs` (the manifest's `entry`) default-exports:

```js
export default {
  help: ["crypto mysource import <file> --owner ana   what it does"], // lines for crypto --help (optional)
  howToConnect: ["MySource: paste a read-only key on nanou.ai → Connectors → MySource."],

  // Who connected it: one handle per login. Never a secret: the runtime prints these.
  accounts(ctx) { return [{ owner: "ana" }]; },

  // One login's holdings. The runtime adds source, owner and the value.
  async balances(ctx, account) { return [{ asset: "BTC", amount: 0.5, wallet: "Spot" }]; },

  // One login's history (only if the manifest declares `transactions`).
  async transactions(ctx, account, { from, to, asset }) { return [{ date: "2026-01-01T00:00:00Z", type: "trade", asset: "BTC", amount: 0.1 }]; },

  // Its own commands, named exactly as the manifest declares them.
  commands: { "import-mysource": (ctx, args, flags) => ({ ok: true }) },
};
```

A holding may carry `priceAs` when its code isn't the one it's priced as
(Nexo's `USDX` → `USD`); any other field is shown as is (`estimatedFrom`,
`chain`…).

### What `ctx` gives a source

| | |
|---|---|
| `ctx.dir` | the source's own folder (`~/.config/connectors/<id>/`), where nanou's installer saves `install.file`; the only files it can open |
| `ctx.fail(message)` | stop with a sentence the person can act on (shown as `{"error"}`) |
| `ctx.note(message)` | something to say with the figures (a history cut short, an export's date) |
| `ctx.warn(message)` | a part that couldn't be read: shown as missing, never as zero |
| `ctx.currency`, `await ctx.value(amount, asset)` | the person's currency and a price, for a command that shows values |

### Rules the runtime and the checker hold you to

- `scripts/check.mjs` imports your module and fails when it implements a
  command the manifest doesn't declare, or declares one it doesn't implement.
- The runtime only dispatches declared commands; nanou's gateway refuses
  undeclared ones and anything that moves money, whatever the code says.
- Self-contained: import only Node built-ins and files inside your folder.
  That is what lets a connector move from its author's repository into this
  one as it is.

## The sandbox

Each source runs in a process of its own (`source.mjs`), one after another,
and under nanou in its own jail (docs/sandbox.md): it can open only
`ctx.dir` (`~/.config/connectors/<id>/`) and reach only its manifest's
`network` hosts with `fetch()`. `ctx.value` fetches Coinbase's public rates,
so a source that uses it lists `api.coinbase.com`.
