## Kraken

Each person pastes their own key on nanou.ai → Connectors → Kraken; it needs only the Query Funds and Query Ledger Entries permissions. Kraken figures are live: `crypto balances --source kraken`, and `crypto transactions --source kraken` for deposits, trades, staking rewards and fees. Holdings under `wallet: "Earn"` are staked or in Kraken Earn.

If `crypto` says a Kraken key can withdraw funds, it refuses to use it: tell them to create a new key with only those two permissions and paste it on that page. Kraken can't tell whether a key may place orders, so remind them not to tick the order permissions either.
