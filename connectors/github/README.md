# GitHub

A person's own GitHub through the official `gh` CLI: issues, pull requests,
diffs, CI runs, code search and clones, as them, through nanou's GitHub App.
Every comment, issue, pull request, review, merge, label, release or push
waits for an approval card; credentials, extensions, aliases, secrets and
repository administration never run.

This is the example of a connector that **runs its own program**
(`"tool": { "runs": "entry", "policy": "src/policy.mjs" }`): `gh` has far too
many commands to list one by one, so instead of `tool.commands` and `cards`
it brings a **policy module** that classifies every call (`kind(args)`: read,
write or blocked) and words its approval card (`card(args)`). nanou's gateway
and the wrapper (`src/gh.mjs`) use the same module, so they can't disagree.
Policy modules run inside nanou's gateway, so only Official connectors may
have one, and each change to it is reviewed line by line.

- `src/gh.mjs`: the `gh` command. Hands the real gh (fetched from the
  manifest's `binaries` with its checksum) the person's token, with a fresh
  empty config each run, and refuses writes unless the gateway approved one
  (`GITHUB_READONLY=0`). Refreshes the 8-hour tokens under a lock.
- `src/policy.mjs`: the read / write / blocked list and the card wording.

**Connect:** nanou.ai → Connectors → GitHub shows a code to type on
github.com/login/device (`auth.kind: "device"`, run by nanou's host with the
app's client id; no client secret anywhere).

**Files:** `~/.config/connectors/github/<login>.json`
(`{ login, owner, access_token, expires_at, refresh_token, … }`).

**Tests:** `node --test "connectors/github/test/*.test.mjs"`: the policy, and
the wrapper against a fake gh and a local token endpoint.
