# Telegram

A person's own Telegram, linked as one more device of their account (it
shows up as "nanou" in Telegram → Settings → Devices), the way Telegram
Desktop is: a user session over MTProto, not a bot. nanou reads their chats,
groups and channels from a local copy, and every message or file it sends
waits for an approval card.

This is nanou's first **linked-device** connector, and it isn't a manifest
under `connectors/` yet. Its runtime, `tgcli`, is published here in full
(`tgcli/`, Go, on [gotd/td](https://github.com/gotd/td)); nanou's gateway
runs it with rules built in, as it does WhatsApp. See
[Why not a manifest yet](#why-not-a-manifest-yet).

**Connect:** nanou.ai or the nanou app → Connectors → Telegram, then either
scan a QR code in Telegram → Settings → Devices → Link Desktop Device, or
type the phone number and the code Telegram sends inside its app (or by SMS).
An account with two-step verification then asks for its password. nanou's
host runs `tgcli --events auth --qr|--phone` in the family's enclave and
passes the code and password down its stdin, never logged or kept. tgcli
never signs anyone up: a number without a Telegram account is refused.

**Commands**, and what nanou's gateway does with each:

| Command | Effect | Gateway |
|---|---|---|
| `accounts list` | public | runs |
| `auth status` | read | runs (offline, from `me.json`) |
| `chats list`, `chats show` | read | runs, after the sharing check |
| `messages list`, `messages search`, `messages show` | read | runs, after the sharing check |
| `media download --output <dir>` | read | runs with read-only lifted for that one call, only into the workspace or `/tmp/` |
| `send text`, `send file` | send | an approval card ("✈️ Telegram message", "📎 Telegram file") naming the chat; a file is checked again on approval |
| `auth`, `auth logout`, `accounts remove`, `sync` | | run by nanou's host and the sync sidecar; asked from a chat, any of them gets a card like a send |

Reads never touch the network: they query a SQLite store with full-text
search (accents folded) that a sidecar keeps current with
`tgcli sync --follow`, one per linked account. So reading never marks a chat
read, and the session tells Telegram it's offline, so the person's own apps
keep their unread counts and notifications. Every write refuses to run while
`--read-only` or `TGCLI_READONLY=1` is on, which is how the gateway's
container starts; the gateway lifts it for one approved command at a time.

A chat is named by its id (as `chats list` prints it; groups and channels
are negative), an `@username`, a contact's `+phone`, or its exact name; a name
that matches two chats is refused rather than guessed.

**Accounts and sharing:** each person links their own account (`--account`
is their first name, `<name>-<label>` for a further one when their plan
allows). Settings → Sharing then decides what the family may have nanou do
with it, as for every connector: Only me (the default), Can read, or Read &
act. A call that names no account uses the asker's own.

**Files** (in the family's enclave, readable only by the family's user):

```
~/.config/tgcli/app.json                 nanou's Telegram app id, placed by the host
~/.local/state/tgcli/<account>/session.json   the linked session (the gateway never lets nanou read it)
~/.local/state/tgcli/<account>/me.json        who the account is
~/.local/state/tgcli/<account>/store.db       chats and messages, capped by --max-db-size (2 GB)
```

`auth logout` logs only this device out and deletes the session; the person
can also end it from Telegram → Settings → Devices at any time.

**Data:** the person's Telegram chats, groups and channels (the last 200
chats and 50 messages of each at first, then everything new), read on
request; every message or file sent waits for an approval card. Kept in the
family's enclave; Telegram sees a session of nanou's app, as with any
Telegram app. nanou uses Telegram's public API under its terms; it is not
made or endorsed by Telegram.

## Why not a manifest yet

A manifest describes what the generic machinery can run, and Telegram needs
three things it doesn't have:

- **Linking.** No auth kind covers a linked device (a QR code, or a phone
  number, a code and maybe a password, in a live session the host holds
  open). The `qr` kind in [manifest.md](../../docs/manifest.md#coming-next)
  will, for WhatsApp too.
- **A sidecar.** The copy nanou reads is kept current by a long-running
  `sync --follow` next to the gateway, not by a command run on demand.
- **The network.** MTProto talks to Telegram's data centers by address, on
  Telegram's own protocol; the sandbox's broker allows HTTPS to named hosts
  only ([sandbox.md](../../docs/sandbox.md)).

So the gateway's rules for `tgcli` stay built in for now, and they are the
ones in the table above. When the `qr` kind and a sidecar field exist, this
folder becomes `connectors/telegram/` with a manifest, its cards and its
catalog text, like the others.

## Build and test

Go 1.25 or newer; every module is pinned by `go.sum`, and it is pure Go
(SQLite included), so no cgo.

```sh
cd linked/telegram/tgcli
go vet ./... && go test ./...      # no network, no Telegram account
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=0.1.0" -o tgcli ./cmd/tgcli
```

Running it for real needs a Telegram app of your own from my.telegram.org
(`TGCLI_API_ID` and `TGCLI_API_HASH`, or `~/.config/tgcli/app.json`). nanou's
own app id stays on nanou's host and is never in this repository.
