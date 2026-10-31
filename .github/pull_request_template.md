## What this connector reads

<!-- One sentence: the service, what nanou reads from it, where it's kept. -->

## Checklist

- [ ] Official API or the person's own export only (no unofficial logins, no scraping behind a login)
- [ ] Every command declared in `tool.commands` with its effect; nothing moves money
- [ ] `network` lists every host the tool reaches
- [ ] Tests use recorded responses; no live credentials anywhere in the PR
- [ ] Catalog text in all 25 languages (`i18n/`)
- [ ] `node scripts/check.mjs --check` and `node --test "tests/*.test.mjs"` pass
- [ ] Commits signed off (`git commit -s`)
