# nanou connectors

The connectors of [nanou](https://nanou.ai), the private family assistant:
what nanou can read for a family (an exchange, a bank export, a tool they
use), described by a manifest that says exactly what each command may do.
nanou's gateway enforces it: reads run, changes wait for the family's
approval, and nothing may move money.

| Connector | Reads | Setup |
|---|---|---|
| [Coinbase](connectors/coinbase) | balances and history | view-only API key file, or sign in with Coinbase |
| [Kraken](connectors/kraken) | balances and ledger | API key with Query Funds and Query Ledger Entries |
| [Nexo](connectors/nexo) | transactions | the person's CSV export |
| [Crypto wallets](connectors/wallets) | public balances of watched addresses | nothing (public data) |

## Build one

- [Build a nanou connector](docs/build-a-connector.md): the three levels
  (Official, Verified, Private), the rules, step by step.
- [The manifest](docs/manifest.md): every field, effect and setup kind.
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md).

```sh
node scripts/check.mjs   # validate the manifests, rebuild connectors/index.json
node --test "tests/*.test.mjs"       # recorded responses only: no network, no credentials
```

Node 22 or newer, no dependencies.

## License

[Apache License 2.0](LICENSE).
