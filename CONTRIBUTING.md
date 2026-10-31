# Contributing

Thanks for building a connector. Start with
[docs/build-a-connector.md](docs/build-a-connector.md); the manifest is
specified in [docs/manifest.md](docs/manifest.md).

## Ground rules

- **Read first.** Connectors read. A command that changes something at the
  service (`write`, `send`) only runs after the family approves it, and
  anything that moves money is refused outright.
- **Official APIs or the person's own exports.** No unofficial logins, no
  scraping behind a login, no credentials that can do more than read.
- **No secrets in the repository.** Tests use recorded responses; a pull
  request with a live key is closed and the key reported to its service.
- **Every language.** nanou speaks 25 languages, so each connector ships its
  catalog text in all of them (`i18n/<locale>.json`). A machine draft is fine;
  say so in the pull request and we'll review it.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a contributor agreement: by signing off, you certify you wrote the
change or have the right to contribute it under this repository's license.

```sh
git commit -s -m "feat(kraken): read staking rewards"
```

CI refuses commits without a `Signed-off-by` line.

## Before you open a pull request

```sh
node scripts/check.mjs   # validates every manifest and rebuilds connectors/index.json
node --test "tests/*.test.mjs" "connectors/*/test/*.test.mjs"       # no network, no credentials
```

Node 22 or newer, no dependencies.

## License

Contributions are licensed under the [Apache License 2.0](LICENSE).
