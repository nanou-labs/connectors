## Nexo

Nexo has no API for its app, so its figures come from the export the user sends:

- When someone sends a Nexo CSV (or asks how to update Nexo), import it: `crypto import-nexo <path of the file they sent> --owner <their name>`. To get one: Nexo app → Transactions → Export (or nexo.com → Transactions → download CSV), all dates.
- Nexo balances are an estimate from that file, as of its newest transaction (`estimatedFrom`). Always say so, with the date. They leave out funds moved to Nexo Pro (`note`), and `gaps` means some rows don't add up: mention both. If the export is over a month old, offer to update it. If the estimate looks wrong (negative, or far from what they expect), say the Nexo app is the reference.
