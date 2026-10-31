# Crypto wallets

Watches public addresses anyone in the family sends in chat and reads their
balances from public blockchains: 0x… addresses on Ethereum, Polygon, Base,
Arbitrum, Optimism and BNB Chain (native coin plus common tokens), Bitcoin
through mempool.space, Solana through its public RPC. No keys, nothing to
connect, nothing can be moved. Each chain has a backup endpoint.

**In nanou:** `crypto wallet check <address>`, then `crypto wallet add <address> --label "Ledger" --owner ana`;
watched wallets count in every `crypto balances` (`--source wallet` alone).
`crypto wallet list`, `crypto wallet remove <address|label>`.

**Files:** `wallets.json` in the family's crypto folder.

**Tests:** `node --test "connectors/wallets/test/*.test.mjs"`.
