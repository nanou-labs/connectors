# Build a nanou connector

A connector lets nanou, the private family assistant, read one more service
for a family: an exchange, a bank export, a tool they use. It is three things
in one folder plus a command-line tool:

- **a manifest** (`connectors/<id>/connector.json`): what the tool's commands
  may do, how the person connects, which hosts it reaches. Spec: [manifest.md](manifest.md);
- **catalog text** in 25 languages (`connectors/<id>/i18n/`);
- **the tool** (`tools/<bin>/`): a small CLI that prints JSON, which nanou runs
  inside the family's own container;
- and usually **a skill** (`skills/<name>/SKILL.md`) telling nanou when and how
  to use it.

Kraken is the reference example: [connectors/kraken](../connectors/kraken),
its `--source kraken` in [tools/crypto](../tools/crypto/crypto.mjs) and
[its tests](../tests/crypto-kraken.test.mjs).

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

1. **Pick the setup** the service allows: `api_key` (fields the person
   pastes), `key_file` (a JSON key file), `file_import` (a CSV export) or
   `none` (public data, like watched wallet addresses).
2. **Write the tool's commands.** Add a `--source` to an existing tool (all
   crypto sources share `tools/crypto`) or a new tool. Keep it dependency-free
   on Node 22.
3. **Write the manifest** and the `i18n/en.json` text, then the other 24
   languages. Informal register everywhere; a machine draft is fine if you
   say so.
4. **Test with recorded responses.** Start a local HTTP server in the test
   that answers like the service (see `tests/crypto-kraken.test.mjs`, which
   also checks the request signature against Kraken's published test
   vector). Point the tool at it with an environment variable. No network,
   no real key.
5. **Check:** `node scripts/check.mjs && node --test "tests/*.test.mjs"`.
6. **Open a pull request** (signed-off commits, see
   [CONTRIBUTING.md](../CONTRIBUTING.md)), or keep it in your own repository
   for the Verified track when it opens.

## How we review

Automatic, on every pull request: the manifest schema, the tests, and the
DCO sign-off. Coming with the Verified track: a network test (only declared
hosts are reached), dependency and secret scans. Then a person on the nanou
team reads the code, checks that the `data` sentence is true, and tests it
with a sandbox account. Each update is reviewed again as a diff.
