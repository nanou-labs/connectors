---
name: family-crypto
description: "Read the family's crypto: Coinbase and Kraken (live), Nexo (from its CSV export) and wallet addresses (EVM chains, Bitcoin, Solana) anyone sends in chat, checked at once and watched on request: holdings, value in EUR, transactions, prices. Read-only; it cannot trade, send or withdraw."
metadata: { "openclaw": { "emoji": "🪙", "requires": { "bins": ["crypto"] } } }
---

# Crypto accounts (read-only)

`crypto` reads Coinbase and Kraken live, Nexo from its transaction export, and watched wallet addresses from the public blockchains. Output is JSON. Nothing in it can trade, send or withdraw.

- What is connected: `crypto accounts`
- Holdings and value: `crypto balances` (add `--source {{sources}}`, `--owner ana`, `--currency EUR`)
- Transactions: `crypto transactions --source coinbase --asset BTC --from 2026-09-01 --limit 20` (also `--search text`)
- Prices: `crypto prices BTC ETH`

Use the asker's own accounts unless they name someone else's. Say which source each figure comes from. Crypto data is private: only share it in the chat where it was asked for.

When the output has `notes` (a history cut short, the date of an export), say them with the figures. A source in `errors` couldn't be read: say that figure is missing, not zero.

<!-- connectors: each connector's SKILL.md, in catalog order (scripts/check.mjs) -->

## Rules

- Each person connects their own accounts on nanou.ai → Connectors. Never ask for API keys, passwords or seed phrases in chat.
- Never touch `~/.config/connectors/<source>` (the keys and imports live there; it's blocked).
- You can't move crypto, and `crypto` only runs the commands listed here (anything else is refused). For a buy, sell or transfer, tell them what to do in the app.
