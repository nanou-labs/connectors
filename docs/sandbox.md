# The sandbox: what a connector can and can't do

Every connector command runs in its own jail inside the family's enclave.
The manifest isn't only a description: it is exactly what the connector is
allowed, and nanou enforces every line of it.

| A connector can | A connector can't |
|---|---|
| read and write its own folder, `~/.config/connectors/<id>/` (its keys, its state) | open anything else: the family's files, other connectors' keys, the assistant's settings, other processes |
| reach the hosts in its manifest's `network`, over HTTPS (port 443) | reach any other host, any address by number, or anything private (the enclave's host, other services) |
| run the commands its manifest declares, with the effect it declares | run a command it doesn't declare, change anything without the family's ✓ on its card, or move money (never declarable) |
| use `fetch()` as usual | open sockets itself (`net`, `dgram`, raw sockets), resolve names, or use other network modules |
| | see the enclave's environment: it starts with a clean one |
| | trace, signal or read other processes, use namespaces, io_uring or kernel keyrings |

Some hosts are refused for every connector, whatever its manifest says:
places made for dropping or relaying data (request catchers, pastebins,
tunnels, chat-bot APIs). Every connection a connector opens, or is refused,
is logged for the family: which connector, which host, when; never what it
sent.

## How it works

- **The jail** (Linux Landlock and seccomp, no privileges needed): the
  connector's process can only open the paths above and can't create a
  socket. It can't lift this, and anything it starts inherits it.
- **The broker**, outside the jail: the only way out. When the connector's
  `fetch()` needs a connection, it asks the broker, which checks the host
  against the manifest and the blocklist, connects, and hands the connected
  socket over. TLS runs inside the connector, end to end with the service:
  the broker never sees the traffic.
- **One process per connector.** The crypto runtime runs each source
  (Coinbase, Kraken…) in a process of its own, so a source never sees
  another's keys.
- **A connector that runs its own program** (GitHub's `gh`, Official only)
  talks through a proxy port the broker opens for it, the only port its jail
  may connect to, with the same host checks.

## What this means for your code

- Keep your files in `ctx.dir` (crypto) or let the runtime read your secret
  (`ctx.secret()`, `ctx.state`). The checker requires `install.file` and
  `accounts.dir` to be in `.config/connectors/<id>/`.
- Use `fetch()` with `https://` URLs on your `network` hosts. Plain `http://`
  doesn't work, and neither does Node's `net`, `tls` or `http` used directly.
- A file someone hands you (an export to import) arrives in your own folder;
  read it there.
- Tests don't run in the jail: point your base URL at a local stand-in with an
  environment variable, as the existing connectors do.
