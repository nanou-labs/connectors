# Asana

Reads a person's Asana tasks and projects, and rebuilds their inbox (what
colleagues did on tasks they follow), with their own personal access token.
Comments and task changes run only after an approval card in the nanou app:
the manifest's `cards` say what each card shows.

This is the example of a connector with **a command of its own** (`asana`),
run by `runtime/cli`: `src/asana.mjs` only implements its commands, and the
runtime parses arguments, picks the account (`--owner`), reads the token and
refuses `comment`, `create`, `update`, `complete` and `reopen` unless nanou's
gateway approved that one command.

**Connect:** in Asana, Settings → Apps → Developer apps → create a personal
access token, then paste it on nanou.ai → Connectors → Asana.

**In nanou:** `asana tasks`, `asana inbox --since 1d`, `asana comment <gid> --text "…"` (a card).

**Files:** `asana-<owner>.json` (`{ token, workspace? }`) in `~/.config/connectors/asana`.

**Tests:** `node --test "connectors/asana/test/*.test.mjs"`, against a local
stand-in for Asana's API.
