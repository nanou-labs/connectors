# Build a nanou connector

A connector lets nanou, the private family assistant, read one more service
for a family: an exchange, a bank export, a tool they use. **A connector is
one self-contained folder**: its manifest, its code, what nanou should know
about it, its tests and its catalog text, importing nothing from outside the
folder. Build it in your own repository with exactly this layout, and once
it's approved it moves into this one as it is, as `connectors/<id>/`.

```
<id>/
  connector.json     the manifest: commands and their effects, setup, hosts, cards (docs/manifest.md)
  src/*.mjs          the code, implementing its runtime's contract
  logo.svg           its mark, drawn on the manifest's color
  SKILL.md           what nanou should know when using it
  test/*.test.mjs    tests on recorded responses: no network, no real key
  i18n/<locale>.json catalog text in nanou's 25 languages
  README.md          what it reads, how a person connects it
```

Every folder in [connectors/](../connectors) is built this way. The code
runs inside a **runtime** that nanou owns, and there are two shapes:

| Shape | Use it for | Runtime | Reference |
|---|---|---|---|
| **A source** of something nanou adds up | an exchange, a wallet, an export | [runtime/crypto](../runtime/crypto): your module answers `accounts`, `balances`, `transactions`; the runtime totals and values them. `SKILL.md` is one `## <Name>` section | [Kraken](../connectors/kraken) |
| **A command of its own** | a service people use directly (tasks, issues, messages) | [runtime/cli](../runtime/cli): your module implements its commands; the runtime parses, picks the account, reads the token and holds every change for an approval card. `SKILL.md` is a whole skill | [Asana](../connectors/asana) |

## Three levels

| Level | Code lives | Who can use it |
|---|---|---|
| **Official** | in this repository, maintained by the nanou team | every family |
| **Verified** | in your own repository; we review one exact commit, pin it and sign it | every family |
| **Private** | anywhere; the family's owner adds it from a GitHub link | that family only, read-only by default, with a warning |

Official connectors are what you see in this repository today. Verified
submissions and Private installs open once the per-connector sandbox is
built (each connector in its own process, with only its own key and only its
declared hosts). We'd rather you build against the spec now and submit when
it opens than have code we haven't reviewed running next to a family's data.

## The rules

1. **Read.** `public` and `read` commands run freely, `local` ones change
   only nanou's own records. `write` and `send` will need the family's
   approval card, which the manifest's `cards` describe. `money` is refused:
   nothing may move money, ever.
2. **Declare everything.** Every command in `tool.commands`, every host in
   `network`. nanou's gateway refuses commands a manifest doesn't declare.
3. **Official APIs or the person's own exports.** Ask for the narrowest key
   the service offers (Kraken: *Query Funds* and *Query Ledger Entries*), and
   refuse one that can do more if you can tell (Kraken probes withdrawals).
4. **Keys stay where nanou puts them.** Read the key from the file the
   manifest's `install.file` names; never log it, never print it, never send
   it anywhere but the service.
5. **Answer in JSON, fail in JSON.** `{"error": "…"}` with a sentence the
   person can act on ("Kraken refused the key: create a new one with…").

## Step by step

1. **Copy the reference folder** for your shape (Kraken or Asana) and rename
   it to your connector's id.
2. **Pick the setup** the service allows: `api_key` (fields the person
   pastes), `key_file` (a JSON key file), `file_import` (a CSV export) or
   `none` (public data, like watched wallet addresses).
3. **Write the code** against your runtime's contract
   ([crypto](../runtime/crypto/README.md) or [cli](../runtime/cli/README.md)):
   Node built-ins only, secrets only through `ctx`, errors through `ctx.fail`.
4. **Write the manifest** (with a card for every change), `logo.svg`, the
   `SKILL.md` and `i18n/en.json`, then
   the other 24 languages. Informal register everywhere; a machine draft is
   fine if you say so.
5. **Test with recorded responses.** Start a local HTTP server in the test
   that answers like the service. A source gets a stand-in `ctx` (see
   [Kraken's tests](../connectors/kraken/test/kraken.test.mjs), which also
   check the request signature against Kraken's published test vector); a
   command runs through `runtime/cli` with a temporary home (see
   [Asana's tests](../connectors/asana/test/asana.test.mjs), which also check
   that changes are refused without approval). No network, no real key.
6. **Check** from this repository with your folder under `connectors/`:
   `node scripts/check.mjs && node --test "tests/*.test.mjs" "connectors/*/test/*.test.mjs"`.
   The checker also makes sure your code implements exactly the commands
   your manifest declares, that every change has a card, and that the logo
   is safe to show.
7. **Open a pull request** adding your folder (signed-off commits, see
   [CONTRIBUTING.md](../CONTRIBUTING.md)), or keep it in your own repository
   for the Verified track when it opens.

## How we review

Automatic, on every pull request: the manifest schema, the tests, and the
DCO sign-off. Coming with the Verified track: a network test (only declared
hosts are reached), dependency and secret scans. Then a person on the nanou
team reads the code, checks that the `data` sentence is true, and tests it
with a sandbox account. Each update is reviewed again as a diff.
