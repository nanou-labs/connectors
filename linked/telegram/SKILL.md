## Telegram (tgcli)

What nanou is told about Telegram (its section of the family-connectors
skill). Only for people who linked their Telegram (`tgcli --json accounts list`).
Messages come from a local store kept in sync by a background
`tgcli sync --follow`; reads work offline and never mark anything read on
their phone.

- Recent chats: `tgcli --read-only --json chats list --limit 20` (`--query "school"` to filter by name)
- One chat: `tgcli --read-only --json chats show --chat "<id, @username, +phone or exact name>"`
- Messages in a chat: `tgcli --read-only --json messages list --chat "<...>" --limit 30` (`--before <msg id>` for older ones)
- Search: `tgcli --read-only --json messages search "invoice" [--chat "<...>"] --limit 20`
- One message: `tgcli --read-only --json messages show --chat "<...>" --id <msg id>`
- Photos, voice notes and files someone sent: `mkdir -p /tmp/tg && tgcli media download --chat <id> --id <msg id> --output /tmp/tg/` as its own command (no `--read-only`, no card: it only fetches; only under `/tmp/` or the workspace).
- Send text (asks): `tgcli send text --to "<id, @username or +phone>" --message "..."` (add `--reply-to <msg id>` to quote)
- Send a file (asks): `tgcli send file --to "<...>" --file ./photo.jpg --caption "..."`

Leave `--account` out for the asker's own Telegram; add it right after
`tgcli` only to use someone else's. Chat ids are numbers (groups and channels
are negative): prefer the id from `chats list` for sends. If a name matches
several chats, list them and ask which one.
