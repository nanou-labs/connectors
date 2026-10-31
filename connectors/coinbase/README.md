# Coinbase

Reads a person's Coinbase balances and transactions, live, through the
Coinbase App API. Read-only: a sign-in holding any scope beyond reading is
refused, and a key file must be a "View"-only key.

**Connect:** "Sign in with Coinbase" on nanou.ai → Connectors → Coinbase, or
upload a View-only CDP secret API key file (ECDSA) on the same page.

**In nanou:** `crypto balances --source coinbase`, `crypto transactions --source coinbase --asset BTC`.

**Files** in the family's crypto folder: `coinbase-<owner>.json` (a key file)
or `coinbase-oauth/<user id>.json` (a sign-in) with `coinbase-oauth/client.json`.
Access tokens last an hour; the refresh token rotates on every refresh, so
refreshes happen under a lock file and are written atomically.

**Tests:** `node --test "connectors/coinbase/test/*.test.mjs"`.
