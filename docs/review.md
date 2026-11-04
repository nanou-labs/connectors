# How a connector is reviewed

Every connector that reaches families goes through the same steps, whether
it's a pull request here (to become **Official**) or a link to your own
repository (to become **Verified**). A **Private** connector skips all of
it: a family's owner installs it for their own family only, read-only by
default, with a warning.

## Submitting

- **Official:** open a pull request adding `connectors/<id>/`, then paste
  the pull request's link on [nanou.ai/connectors](https://nanou.ai/connectors).
  Once accepted, the nanou team maintains it here.
- **Verified:** keep the connector in your own **public** GitHub
  repository, under an **OSI-approved open-source license** (we recommend
  Apache-2.0, this repository's license), with the layout in
  [build-a-connector.md](build-a-connector.md), and paste its link,
  `https://github.com/you/repo` or `…/tree/<branch>/<folder>`, on
  [nanou.ai/connectors](https://nanou.ai/connectors). It stays yours: nanou
  pins the exact commit we reviewed and signs it. nanou fetches it without
  signing in to GitHub, so a private repository fails at once.

Submitting is for nanou members: sign in on nanou.ai with an account that
belongs to a family. Updates go to that account's email. The form takes the
link and a sentence on what the connector is for, and you get a link to
follow your submission's state.

### Open source

A Verified connector's repository has a license file (`LICENSE`, `LICENCE`
or `COPYING`, any extension) in the connector's folder or at the
repository's root, with one of these licenses: **Apache-2.0**
(recommended), MIT, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, or a GNU GPL,
LGPL or AGPL (2.x or 3.0). The `license` check recognises the license's own
text, unmodified, or an `SPDX-License-Identifier:` line (any OSI-approved
identifier; with `OR`, one open choice is enough). Source-available terms
(Commons Clause, BSL, SSPL and the like) are refused.

An Official connector is licensed like the rest of this repository,
Apache-2.0, through the sign-off on every commit ([DCO](../CONTRIBUTING.md));
it needs no license file of its own, and a different one in its folder is
refused.

## The states

Each submission reviews **one commit**: the one the link pointed to when
you submitted. A later push changes nothing; submit again for a new commit.

| State | What happens | Who |
|---|---|---|
| `received` | the submission is in; checks start on their own | automatic |
| `checking` | the automatic checks below run on that commit | automatic |
| `checks_failed` | at least one check failed: you see which and why. Fix it and submit again | you |
| `audit` | a person on the nanou team reads every file at that commit and checks that the `data` sentence is true | nanou reviewer |
| `live_test` | the reviewer runs it with a test account inside nanou's sandbox: each read, each change's card | nanou reviewer |
| `accepted` | Verified: nanou signs the entry and adds it to `registry/verified.json`. Official: the pull request is merged | nanou |
| `listed` | the commit families run (nanou's pin of this repository) has it: every family can install it | automatic |
| `declined` | stopped at a human step, always with a reason you can act on | nanou reviewer |

A reviewer moves a submission from `audit` to `live_test`, and from
`live_test` to `accepted`, only with a note saying what they checked; the
note is kept in the signed entry (`reviewed.audit`, `reviewed.liveTest`).

**Updates** are new submissions of the same id. They go through the same
states, the reviewer reads the diff from the listed commit, and the checks
say what the update widens (new hosts, new commands, stronger effects).
Until the update is listed, families keep running the reviewed commit.

## The automatic checks

`node scripts/review.mjs <folder> [--level verified] [--repo <root>]` runs
them (`--repo` is where to look for the repository's license; by default the
folder's nearest ancestor with `.git`); CI runs it
on every pull request that touches `connectors/`, and nanou runs it on a
Verified submission in a container with no network at all.

| Check | What it makes sure of |
|---|---|
| `files` | at most 200 files and 2 MB, no symlinks, no dependencies; `connector.json`, `logo.svg`, `README.md`, `SKILL.md`, `i18n/en.json` and tests are there |
| `manifest` | every rule of `scripts/check.mjs` ([manifest.md](manifest.md)): effects, nothing that moves money, a card for every `write` and `send`, its own folder only, all 25 languages |
| `logo` | a small square SVG of plain shapes, safe to show anywhere |
| `shape` (Verified) | a command of its own run by `runtime/cli`, set up with a key (`api_key`) or nothing (`none`), an id no Official connector has |
| `contract` | the code implements exactly the commands the manifest declares |
| `hosts` | every host the code names is in `network` |
| `code` | Node built-ins only, nothing outside its folder, no sockets, processes or code built at runtime: `fetch()` is the way out |
| `secrets` | no key-shaped strings or key files |
| `license` | Verified: an OSI-approved open-source license file in the folder or at the repository's root ([Open source](#open-source)); Official: nothing but Apache-2.0 |
| `tests` | the tests pass, offline: any connection but loopback is refused and reported |

nanou then runs the **sandbox probe** on a Verified submission: each `read`
and `public` command, inside the same jail families use
([sandbox.md](sandbox.md)), with no network. Every host the connector tries
is logged, and one that isn't declared fails the probe.

## A Verified entry

`registry/verified.json` lists the Verified connectors:

```json
{
  "id": "acme",
  "name": "Acme",
  "repo": "https://github.com/jane/acme-connector",
  "path": "",
  "commit": "<the reviewed commit, 40 hex>",
  "tree": "<SHA-256 tree hash of its files>",
  "data": "Your Acme orders, read on request.",
  "network": ["api.acme.com"],
  "commands": { "orders": "read", "note": "write" },
  "auth": "api_key",
  "author": "jane",
  "reviewed": { "at": "2026-11-04", "audit": "…", "liveTest": "…" },
  "signature": "<Ed25519, base64>"
}
```

- **tree:** SHA-256 of what `sha256sum` prints for the files nanou installs
  (every regular file under `path`, hidden ones left out, sorted by path):
  `"<sha256>  <path>\n"` per file. `scripts/review.mjs` prints it.
- **signature:** Ed25519 over `nanou-verified-v1\n` followed by the entry
  without `signature`, as JSON with keys sorted at every level and no
  spaces. The key that checks it is built into nanou, not kept here, so a
  change to this file alone can't list anything.

When a family installs a Verified connector, nanou checks the signature,
fetches exactly that commit, and refuses it unless its files hash to
`tree`. It then runs like any connector: in its own jail, only its declared
hosts, and every change waits for the family's approval card.

`node scripts/registry.mjs --check` (CI) makes sure every entry is well
formed.
