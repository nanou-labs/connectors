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
