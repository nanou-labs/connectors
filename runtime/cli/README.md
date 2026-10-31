# The cli runtime: connectors with a command of their own

Some connectors are a service of their own (Asana, one day GitHub or
Slack) rather than one more source of something nanou adds up. They get
**their own command**, named like the connector (`tool.bin` = its `id`),
and nanou installs it as a two-line launcher:

```sh
#!/bin/sh
exec node /usr/local/lib/nanou-connectors/runtime/cli/cli.mjs asana "$@"
```

`runtime/cli/cli.mjs` does everything that must be the same for every
connector, so the connector's code only implements its commands:

- parses `--flag value`, `--flag=value` and positional words;
- runs **only** the commands the manifest declares (two words first, `wallet add`, then one);
- picks whose account: `--owner <name>`, else the only person who connected it, else asks;
- reads and saves that person's secret at the manifest's `install.file`;
- refuses every `write` or `send` command unless nanou's gateway approved that one command on a card (it runs it with `NANOU_WRITE=1`), and always with `--readonly`;
- prints the result as JSON, or `{"error": "…"}` with exit code 1;
- answers `help` from your `help` lines.

[Asana](../../connectors/asana) is the reference.

## The contract

`entry` (e.g. `src/asana.mjs`) default-exports:

```js
export default {
  help: ["  asana tasks [--project <gid|name>]   open tasks", "…"],  // optional, shown by `asana help`
  booleans: ["all"],              // optional: flags that never take a value
  commands: {
    // every command the manifest declares, and no other (scripts/check.mjs checks both ways)
    async tasks(ctx) { return [...]; },      // what you return is printed as JSON
    async complete(ctx) { ... },             // a "write": the runtime already checked the approval
  },
};
```

### What `ctx` gives a command

| | |
|---|---|
| `ctx.words` | positional words after the command (`asana task 123` → `["123"]`) |
| `ctx.flags`, `ctx.flag(k)` | all flags; one flag's text value (undefined when absent or given without a value) |
| `ctx.secret()` | the account's saved JSON (`{ token }` for an `api_key` with a `token` field) |
| `ctx.saveSecret(v)` | replace it atomically, owner-only (a refreshed token, a remembered workspace) |
| `ctx.state.get(name, fallback)`, `ctx.state.set(name, value)` | the account's own state (a cache, a cursor), kept next to its secret |
| `ctx.owner()` | whose account is in use |
| `ctx.fail(msg)` | stop with a sentence the person can act on |

### Rules

- **Describe every change's card.** Each `write` or `send` command has an
  entry in the manifest's `cards` (docs/manifest.md): the title, the verb on
  the button, which flags or words the card shows, and the body. That is what
  the family sees before they tap ✓, so make it say exactly what will happen.
- Never check approval yourself and never read `NANOU_WRITE`: the runtime does.
- Reach only your manifest's `network` hosts, read only through `ctx.secret()`.
- Make the base URL overridable by an environment variable
  (`FAMILY_ASANA_API`), so tests run against a local stand-in.
