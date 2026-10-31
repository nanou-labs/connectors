// The GitHub policy (src/policy.mjs): which `gh` calls only read, which need
// an approval card, which never run, and what the card says. nanou's gateway
// and the wrapper both use it. Run with `node --test "connectors/github/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { test } from "node:test";
import policy, { ghCard, ghKind } from "../src/policy.mjs";

const kind = (/** @type {string} */ cmd) => ghKind(cmd.split(" "));

test("reads run freely", () => {
  for (const c of [
    "pr list -R nanou/app", "--account ana pr view 12 --comments", "pr diff 12", "issue list --state open", "repo clone nanou/app",
    "run view 123 --log-failed", "search issues is:open", "status", "accounts", "auth status", "api repos/nanou/app/pulls",
    "api -X GET search/issues", "pr create --help", "git fetch origin", "git -C app pull --ff-only", "-R x pr list",
  ]) assert.equal(kind(c), "read", c);
});

test("every change needs a card", () => {
  for (const c of [
    "pr create --title Fix --base main", "pr comment 12 --body LGTM", "pr review 12 --approve", "pr merge 12 --squash",
    "pr -R nanou/app merge 12", "issue create --title Bug", "label create urgent", "release create v1.0", "workflow run deploy.yml",
    "api repos/nanou/app/issues -f title=x", "api -X POST repos/nanou/app/issues/1/comments", "api --method=DELETE repos/x/y/git/refs/heads/z",
    "api -XPATCH repos/nanou/app/issues/1", "git push origin fix", "git -c core.sshCommand=evil fetch", "git fetch --upload-pack=evil origin",
  ]) assert.equal(kind(c), "write", c);
});

test("credentials and administration never run", () => {
  for (const c of ["auth token", "--account ana auth login", "extension install x/y", "alias set co x", "secret set X", "repo delete nanou/app"]) {
    assert.equal(kind(c), "blocked", c);
  }
});

test("the card says what will happen", () => {
  const pr = ghCard("pr create -R nanou/app --title Fix --body Closes --base main".split(" "));
  assert.equal(pr.title, "🐙 GitHub: open a pull request");
  assert.equal(pr.verb, "Open");
  assert.deepEqual(pr.fields, [["Repository", "nanou/app"], ["Title", "Fix"], ["Into", "main"]]);
  assert.equal(pr.body, "Closes");
  const merge = ghCard("--account ana pr merge 12 --squash".split(" "));
  assert.deepEqual(merge.fields, [["Account", "ana"], ["Pull request", "12"], ["How", "squash"]]);
  assert.equal(ghCard("api -X POST repos/x/y/issues".split(" ")).fields.at(-1)?.[1], "POST repos/x/y/issues");
});

test("the default export is the policy contract", () => {
  assert.equal(policy.kind, ghKind);
  assert.equal(policy.card, ghCard);
});
