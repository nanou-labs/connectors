# Connector manifest

A connector is a folder under `connectors/` with a `connector.json` and its
catalog text in every language nanou speaks. `scripts/check.mjs` validates
them and builds `connectors/index.json`, which nanou's gateway (what runs
freely, what needs approval, what is refused) and its installer read. A
connector that fits one of the generic setups (API key, key file, file import,
or nothing to set up) needs no change to nanou itself, only its tool's
commands.

```
connectors/<id>/connector.json      the manifest (below)
connectors/<id>/i18n/<locale>.json  catalog text, one per locale (all 25 required)
connectors/index.json               generated: run node scripts/check.mjs
```

## Fields

```jsonc
{
  "id": "kraken",              // = folder name, also the URL slug /app/connectors/<id>
  "name": "Kraken",
  "category": "crypto",        // sharing kind and website group (crypto → Money); only crypto so far
  "order": 20,                 // position among the manifest connectors in the catalog
  "plan": "family",            // lowest plan that includes it: solo | family | plus
  "color": "#7132F5", "mark": "Kr",   // logo tile
  "tool": {
    "bin": "crypto",           // the CLI in the gateway image
    "source": "kraken",        // its --source value for this connector
    "commands": {              // every command it uses, with its effect
      "balances": "read", "transactions": "read", "accounts": "public", "prices": "public"
    }
  },
  "auth": { "kind": "api_key", "fields": [ { "id": "key", "pattern": "^…$" }, { "id": "secret", "secret": true, "pattern": "^…$" } ] },
  "install": {
    "file": ".config/family-crypto/kraken-{owner}.json",   // under the family's home
    "check": ["crypto", "balances", "--source", "kraken", "--owner", "{owner}"],
    "refused": "What the person reads when the check fails (English for now)."
  },
  "accounts": { "kind": "crypto", "dir": ".config/family-crypto", "files": ["kraken-{owner}.json"], "label": "Kraken" },
  "network": ["api.kraken.com", "api.coinbase.com"],      // every host the tool reaches for it
  "data": "What it reads and where it is kept."
}
```

### Effects

| Effect | Meaning | Guard |
|---|---|---|
| `public` | reads nothing private (prices, what's connected) | runs |
| `read` | reads someone's account | runs, after the sharing check |
| `local` | changes only nanou's own records (an import, a watched address) | runs |
| `write`, `send` | changes something at the service | refused until connector approval cards exist |
| `money` | moves money | the manifest is rejected; refused at runtime too |

A tool named by any manifest runs **only** the commands manifests declare,
strictest effect wins when two connectors share a command, and when the index
can't be read those tools are refused outright (fail closed). The tool itself
must still only read: the guard is the second wall.

### Auth kinds

| Kind | The person sees on nanou.ai | nanou's installer, in the family's container |
|---|---|---|
| `none` | a "how to" (`howTo` in i18n) | nothing |
| `api_key` | one input per field (secret ones masked), each checked against its `pattern` | checks the patterns again, saves the fields as one JSON file at `install.file`, runs `install.check`, puts the old file back if it fails |
| `key_file` | a file picker (`accept`); the file must be JSON with `jsonKeys` | the same checks, saves the file as is, runs the check |
| `file_import` | a file picker (`accept`) | checks the first line holds every `header` word, runs `install.import` with `{file}` |

Everything the person pastes or uploads is sealed in their browser to their
family's server, so nanou.ai only ever relays ciphertext. `oauth2` is not
generic yet: Coinbase's sign-in (`auth.signIn: true`) is still built into nanou.

### Accounts

`files` are matched in `dir`: `name-{owner}.ext`, or `folder/*.json#field`
where the owner is that JSON field. The guard's sharing (Settings → Sharing in the app)
shows one line per person and kind, "Crypto: Coinbase, Kraken", and a `read`
command with `--owner` or without it is checked against those people. A
connector without `accounts` (public wallets) reads nothing private, so
`--source wallet` isn't limited.

### i18n

Each locale file is the connector's catalog text on nanou.ai: `blurb`, `can`, `name`
(only for non-brand names), `upload.label` and `upload.help` (or `howTo` for
`none`), and `fields.<id>` labels for an API key. Write informally in every
language (tu, du, tú…), and never name AI providers or models.

## What the checks refuse

`scripts/check.mjs` stops on: an id that doesn't match its folder,
an unknown category, plan or auth kind, a `money` effect, an unanchored or
broken field pattern, an install path that is absolute, has `..` or lacks
`{owner}`, a check or import that doesn't run the connector's own tool, a
missing locale or text, or two connectors sharing an id or a `--source`.

## Coming next

- `network` is declared and reviewed but not yet enforced: that comes with
  the per-connector sandbox, which is also what private connectors need.
- Approval cards for `write` and `send` commands, a generic `oauth2` sign-in,
  a `qr` pairing kind, and `runtime: mcp` to wrap existing MCP servers.
