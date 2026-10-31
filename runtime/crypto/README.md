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
| `ctx.dir` | the family's crypto folder, where nanou's installer saves `install.file`; read your key and keep your files here, nowhere else |
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

## Coming

When the per-connector sandbox lands, `ctx` is also how a source gets its
key and reaches the network: the runtime will hand each source only its own
secret and only its declared hosts. Sources that already stick to `ctx.dir`
and their manifest's `network` won't need changes.
