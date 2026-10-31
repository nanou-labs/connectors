---
name: family-crypto
description: "Read the family's crypto: Coinbase and Kraken (live), Nexo (from its CSV export) and wallet addresses (EVM chains, Bitcoin, Solana) anyone sends in chat, checked at once and watched on request: holdings, value in EUR, transactions, prices. Read-only; it cannot trade, send or withdraw."
metadata: { "openclaw": { "emoji": "🪙", "requires": { "bins": ["crypto"] } } }
---

# Crypto accounts (read-only)

`crypto` reads Coinbase and Kraken live, Nexo from its transaction export, and watched wallet addresses from the public blockchains. Output is JSON. Nothing in it can trade, send or withdraw.

- What is connected: `crypto accounts`
- Holdings and value: `crypto balances` (add `--source coinbase|kraken|nexo|wallet`, `--owner ana`, `--currency EUR`)
- Transactions: `crypto transactions --source coinbase --asset BTC --from 2026-09-01 --limit 20` (also `--search text`)
- Prices: `crypto prices BTC ETH`

Use the asker's own accounts unless they name someone else's. Say which source each figure comes from. Crypto data is private: only share it in the chat where it was asked for.

## Wallet addresses

Watching wallets is on for every family, with nothing to set up first (no exchange account needed): people just send a public address in any chat.

When someone gives you a wallet address (pasted, in a photo or a QR, "what's in 0x…?", "track my Ledger"):

1. Check it right away: `crypto wallet check <address>`. Say in one line what is in it and its value (`totalEUR`).
2. Unless it is already watched (`watched` in the output) or they already asked you to track it, ask once: "Want me to keep watching it, so it counts in your household net worth?" Don't ask again if they say no or ignore it.
3. On yes (or if they asked to track it from the start): `crypto wallet add <address> --label "<what they call it, or a short name you suggest>" --owner <their first name, lowercase>`. From then on it counts in every `crypto balances` (`--source wallet` for wallets only).

`crypto wallet list` shows the watched ones, `crypto wallet remove <address|label>` stops watching one (when they ask).

- 0x… addresses are read on Ethereum, Polygon, Base, Arbitrum, Optimism and BNB Chain (limit with `--chains ethereum,base`): the native coin plus common tokens (USDC, USDT, DAI, EURC, WETH, WBTC). Other tokens and DeFi positions aren't seen; say so if they ask about one.
- Bitcoin addresses (bc1…, 1…, 3…) and Solana addresses (all its tokens; unknown ones show as `SPL:<mint>` without a value).
- Addresses only. Never ask for a seed phrase (12 or 24 words), a private key or an exchange password, and never store one. If someone pastes one, don't run anything with it: tell them to treat that wallet as compromised and move the funds to a new wallet, and that nanou only ever needs the public address.
- If a chain shows up in `errors`, its public endpoint was down; say that figure is missing rather than zero.

## Kraken

Each person pastes their own key on nanou.ai → Connectors → Kraken; it needs only the Query Funds and Query Ledger Entries permissions. Kraken figures are live: `crypto balances --source kraken`, and `crypto transactions --source kraken` for deposits, trades, staking rewards and fees. Holdings under `wallet: "Earn"` are staked or in Kraken Earn.

If `crypto` says a Kraken key can withdraw funds, it refuses to use it: tell them to create a new key with only those two permissions and paste it on that page. Kraken can't tell whether a key may place orders, so remind them not to tick the order permissions either.

## Nexo

Nexo has no API for its app, so its figures come from the export the user sends:

- When someone sends a Nexo CSV (or asks how to update Nexo), import it: `crypto import-nexo <path of the file they sent> --owner <their name>`. To get one: Nexo app → Transactions → Export (or nexo.com → Transactions → download CSV), all dates.
- Nexo balances are an estimate from that file, as of its newest transaction (`estimatedFrom`). Always say so, with the date. They leave out funds moved to Nexo Pro (`note`), and `gaps` means some rows don't add up: mention both. If the export is over a month old, offer to update it. If the estimate looks wrong (negative, or far from what they expect), say the Nexo app is the reference.

## Rules

- If `crypto` says Coinbase isn't connected, or that the sign-in expired, each person signs in to Coinbase themselves on nanou.ai → Connectors → Coinbase (in the app: Settings → Google and the others); it is read-only. Kraken works the same way on its own page. Older setups use a view-only key file (`just crypto-setup`). Never ask for API keys, passwords or seed phrases in chat.
- Never touch `~/.config/family-crypto` (the key and imports live there; it's blocked).
- You can't move crypto, and `crypto` only runs the commands listed here (anything else is refused). For a buy, sell or transfer, tell them what to do in the app.
