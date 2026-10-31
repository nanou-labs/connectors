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
| [Asana](connectors/asana) | tasks, projects, inbox; comments and changes after an approval card | personal access token |
| [Slack](connectors/slack) | channels, DMs, threads, search; posts and reactions after an approval card | user token from a Slack app |
| [GitHub](connectors/github) | issues, pull requests, code, CI; every write after an approval card | a code typed on github.com (device sign-in) |

## How it's laid out

Each connector is **one self-contained folder** under `connectors/`: its
manifest, code, skill section, tests and catalog text, importing nothing from
outside it. A community connector lives in its author's repository with the
same layout and moves in here as it is once approved. The code runs inside a
runtime nanou owns, which only runs what the manifests declare:
`runtime/crypto` adds crypto sources up, and `runtime/cli` runs connectors
with a command of their own (`asana`, `slack`), holding every change for the
family's approval card. GitHub runs its own program (`gh`) and brings a
policy module that classifies each call instead.

```
connectors/<id>/   one connector (connector.json, src/, SKILL.md, test/, i18n/, README.md)
runtime/crypto/    the crypto runtime and its source contract
runtime/cli/       the runner for connectors with their own command, and its contract
scripts/check.mjs  validates everything, builds connectors/index.json and skills/
docs/              the guide and the manifest spec
```

## Build one

- [Build a nanou connector](docs/build-a-connector.md): the three levels
  (Official, Verified, Private), the rules, step by step.
- [The manifest](docs/manifest.md): every field, effect and setup kind.
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md).

```sh
node scripts/check.mjs   # validate the manifests, rebuild connectors/index.json
node --test "tests/*.test.mjs" "connectors/*/test/*.test.mjs"       # recorded responses only: no network, no credentials
```

Node 22 or newer, no dependencies.

## License

[Apache License 2.0](LICENSE).
