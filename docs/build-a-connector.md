# Build a nanou connector

A connector lets nanou, the private family assistant, read one more service
for a family: an exchange, a bank export, a tool they use. **A connector is
one self-contained folder**: its manifest, its code, what nanou should know
about it, its tests and its catalog text, importing nothing from outside the
folder. Build it in your own repository with exactly this layout, and once
it's approved it moves into this one as it is, as `connectors/<id>/`.

```
<id>/
  connector.json     the manifest: commands and their effects, setup, hosts (docs/manifest.md)
  src/source.mjs     the code, implementing the runtime's contract (runtime/crypto/README.md)
  SKILL.md           what nanou should know when using it, one "## <Name>" section
  test/*.test.mjs    tests on recorded responses: no network, no real key
  i18n/<locale>.json catalog text in nanou's 25 languages
  README.md          what it reads, how a person connects it
```

The four folders in [connectors/](../connectors) are all built this way;
[Kraken](../connectors/kraken) is the reference. The code runs inside a
**runtime** that nanou owns, `crypto` for crypto sources
([runtime/crypto](../runtime/crypto)): it finds every source, adds totals up
across them, values them and runs only declared commands. Your module answers
`accounts`, `balances` and `transactions`, plus any command of its own.

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
   approval card. `money` is refused: nothing may move money, ever.
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

1. **Copy the Kraken folder** as your starting point and rename it to your
   connector's id.
2. **Pick the setup** the service allows: `api_key` (fields the person
   pastes), `key_file` (a JSON key file), `file_import` (a CSV export) or
   `none` (public data, like watched wallet addresses).
3. **Write `src/source.mjs`** against the
   [runtime's contract](../runtime/crypto/README.md): Node built-ins only,
   files only under `ctx.dir`, errors through `ctx.fail`.
4. **Write the manifest**, the `SKILL.md` section and `i18n/en.json`, then
   the other 24 languages. Informal register everywhere; a machine draft is
   fine if you say so.
5. **Test with recorded responses.** Start a local HTTP server in the test
   that answers like the service and hand your module a stand-in `ctx` (see
   [Kraken's tests](../connectors/kraken/test/kraken.test.mjs), which also
   check the request signature against Kraken's published test vector). No
   network, no real key.
6. **Check** from this repository with your folder under `connectors/`:
   `node scripts/check.mjs && node --test "tests/*.test.mjs" "connectors/*/test/*.test.mjs"`.
   The checker also makes sure your code implements exactly the commands
   your manifest declares.
7. **Open a pull request** adding your folder (signed-off commits, see
   [CONTRIBUTING.md](../CONTRIBUTING.md)), or keep it in your own repository
   for the Verified track when it opens.

## How we review

Automatic, on every pull request: the manifest schema, the tests, and the
DCO sign-off. Coming with the Verified track: a network test (only declared
hosts are reached), dependency and secret scans. Then a person on the nanou
team reads the code, checks that the `data` sentence is true, and tests it
with a sandbox account. Each update is reviewed again as a diff.
