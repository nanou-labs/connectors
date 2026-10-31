# Nexo

Nexo has no API for its app, so this reads the transaction export the person
downloads: Nexo app → Transactions → Export (or nexo.com → Transactions →
download CSV), all dates. Holdings are estimated from it, as of its newest
transaction, and leave out funds moved to Nexo Pro.

**Connect:** upload the CSV on nanou.ai → Connectors → Nexo, or send it to
nanou in chat (`crypto import-nexo <file> --owner ana`).

**In nanou:** `crypto balances --source nexo` (with `estimatedFrom`, and
`gaps` when the export doesn't add up), `crypto transactions --source nexo`.

**Files:** `nexo-<owner>.csv` in the family's crypto folder.

**Tests:** `node --test "connectors/nexo/test/*.test.mjs"`.
