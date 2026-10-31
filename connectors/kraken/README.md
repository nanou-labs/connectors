# Kraken

Reads a person's Kraken balances and ledger (deposits, trades, staking
rewards, fees), live, through Kraken's spot REST API. Read-only: it only ever
calls `BalanceEx`, `Ledgers` and `WithdrawMethods`, and refuses a key that
can withdraw.

**Connect:** on Kraken, Settings → Connections & API → create a key with only
**Query Funds** and **Query Ledger Entries**, then paste the API key and
private key on nanou.ai → Connectors → Kraken.

**In nanou:** `crypto balances --source kraken`, `crypto transactions --source kraken`.
Staked or Earn balances show as `wallet: "Earn"`. Histories are read up to
300 entries, newest first, with a note when there are more (`--from`/`--to`
reach older ones).

**Files:** `kraken-<owner>.json` (`{ key, secret }`) in the family's crypto folder.

**Tests:** `node --test "connectors/kraken/test/*.test.mjs"`, against a local
stand-in for Kraken, with the signature checked against Kraken's published
test vector.
