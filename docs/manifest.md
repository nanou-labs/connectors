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
connectors/<id>/src/*.mjs           its code (the manifest's entry)
connectors/<id>/logo.svg            its logo, drawn on `color`
connectors/<id>/SKILL.md            its section of the runtime's skill, or its whole skill (own command)
connectors/<id>/test/               its tests
connectors/<id>/i18n/<locale>.json  catalog text, one per locale (all 25 required)
connectors/index.json               generated: run node scripts/check.mjs
skills/<name>/SKILL.md              generated: each runtime's skill with its connectors' sections, and each own-command connector's skill
```

## Fields

```jsonc
{
  "id": "kraken",              // = folder name, also the URL slug /app/connectors/<id>
  "name": "Kraken",
  "category": "crypto",        // website group: crypto → Money, work → Work (and the sharing kind of `accounts`)
  "order": 20,                 // position among the manifest connectors in the catalog
  "plan": "family",            // lowest plan that includes it: solo | family | plus
  "color": "#7132F5", "mark": "Kr",   // logo tile: its background, and letters while the logo loads
  "logo": "logo.svg",          // the mark, drawn on `color` (see Logo)
  "tool": {
    "bin": "crypto",           // a shared runtime (runtime/crypto), or the connector's own command = its id (runtime/cli)
    "source": "kraken",        // its --source value for this connector
    "commands": {              // every command it uses, with its effect
      "balances": "read", "transactions": "read", "accounts": "public", "prices": "public"
    }
  },
  "entry": "src/source.mjs",   // the connector's code, inside its folder (runtime/<bin>/README.md: the contract)
  "cards": { },                // own-command connectors: one approval card per write/send command (see Cards)
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
| `write` | changes something at the service (a task, an event) | an approval card, described in `cards` |
| `send` | others will see it (a comment, a message) | an approval card, described in `cards` |
| `money` | moves money | the manifest is rejected; refused at runtime too |

A tool named by any manifest runs **only** the commands manifests declare,
strictest effect wins when two connectors share a command, and when the index
can't be read those tools are refused outright (fail closed). The tool itself
must still only read: the guard is the second wall.

### Cards

Every `write` or `send` command has a card, so the family sees exactly what
will happen before tapping ✓. From Asana:

```jsonc
"cards": {
  "comment": { "title": "📋 Asana: comment", "verb": "Post", "fields": [["Task", "$1"]], "body": ["--text"] },
  "create":  { "title": "📋 Asana: create task",
               "fields": [["Name", "--name"], ["Project", "--project"], ["Due", "--due"]], "body": ["--notes"] }
}
```

`title` (up to 60 characters) heads the card; `verb` is the button
(`Approve`, the default, `Post`, `Send` or `Save`); `fields` are label/value
lines, where the value is a word after the command (`$1`, `$2`…) or a flag's
value (`--name`), and empty ones are left out; `body` is the longer text, the
first of its values that was given. After the tap nanou runs that exact
command once with `NANOU_WRITE=1`; the runtime refuses the change otherwise.

### Logo

`logo.svg` is the connector's mark as it sits on its tile: the tile is a
rounded square filled with `color`, and the SVG fills it, so leave the margin
you want inside a **square** `viewBox` (about 20 % on each side for most
marks). Plain shapes only: `svg`, `g`, `path`, `circle`, `ellipse`, `rect`,
`polygon` with fills and geometry; no text, styles, scripts, links, images,
entities or `url()`, under 8 KB. Use the service's official mark (Simple
Icons, CC0, has most) or its own favicon, and say where it came from in your
pull request.

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
missing locale or text, two connectors sharing an id or a `--source`, an
`entry` outside the folder, code that implements a command the manifest
doesn't declare (or declares one it doesn't implement), a `tool.bin` that is
neither a shared runtime nor the connector's id, a `write`/`send` command
without a card (or a card on any other command), or a logo that isn't a
small square SVG of plain shapes.

## Coming next

- `network` is declared and reviewed but not yet enforced: that comes with
  the per-connector sandbox, which is also what private connectors need.
- A generic `oauth2` sign-in,
  a `qr` pairing kind, and `runtime: mcp` to wrap existing MCP servers.
