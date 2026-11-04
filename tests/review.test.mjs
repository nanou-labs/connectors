// scripts/review.mjs on copies of the Asana connector: a clean one passes
// every check (Verified level too), and each kind of problem a submission can
// have is caught by the check that owns it. Also checks the tree hash is
// what `sha256sum` would give, and the registry checker.
// Run with `node --test "tests/*.test.mjs"`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkRegistry } from "../scripts/registry.mjs";
import { review, treeHash } from "../scripts/review.mjs";

const ASANA = new URL("../connectors/asana", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "review-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A copy of the Asana connector, changed by `edit`. @param {(dir: string) => void} [edit] */
function copy(edit) {
  const dir = join(tmp, `c${n++}`, "my-connector");
  cpSync(ASANA, dir, { recursive: true });
  edit?.(dir);
  return dir;
}
/** The problems of one check. @param {any} report @param {string} name */
const problems = (report, name) => report.checks.find((/** @type {any} */ c) => c.name === name)?.problems ?? null;

test("a clean connector passes every check; as Verified, only its Official id is refused", async () => {
  const dir = copy();
  const r = await review(dir);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.id, "asana");
  assert.match(r.tree ?? "", /^[0-9a-f]{64}$/);
  const v = await review(dir, { level: "verified", tests: false });
  assert.deepEqual(
    v.checks.filter((c) => !c.ok),
    [{ name: "shape", ok: false, problems: ['id: "asana" is an Official connector\'s'] }],
  );
});

test("a host the code names but doesn't declare is caught", async () => {
  const dir = copy((d) => appendFileSync(join(d, "src", "asana.mjs"), '\nconst DROP = "https://collector.evil.example.net/x";\n'));
  const r = await review(dir, { tests: false });
  assert.deepEqual(problems(r, "hosts"), ["src/asana.mjs names collector.evil.example.net, which isn't in network"]);
});

test("sockets, processes, dependencies and eval are caught", async () => {
  const dir = copy((d) =>
    appendFileSync(join(d, "src", "asana.mjs"), '\nimport "node:net";\nimport x from "left-pad";\nexport const y = eval("1");\n'),
  );
  const p = problems(await review(dir, { tests: false }), "code");
  assert.equal(p?.length, 3, String(p));
});

test("a key-shaped string or key file is caught", async () => {
  const dir = copy((d) => writeFileSync(join(d, "test", "fixture.json"), `{"key": "AKIA${"Q".repeat(16)}"}\n`));
  assert.deepEqual(problems(await review(dir, { tests: false }), "secrets"), ["test/fixture.json: looks like a AWS key"]);
});

test("a test that reaches the network fails the tests check", async () => {
  const dir = copy((d) =>
    writeFileSync(
      join(d, "test", "online.test.mjs"),
      'import { test } from "node:test";\ntest("online", async () => { await fetch("https://api.github.com/").catch(() => {}); });\n',
    ),
  );
  const p = problems(await review(dir), "tests");
  assert.equal(p?.length, 1, String(p));
  assert.match(p[0], /tried the network \(api\.github\.com\)/);
});

test("the Verified shape refuses a program of its own and other sign-ins", async () => {
  const dir = copy((d) => {
    const m = JSON.parse(readFileSync(join(d, "connector.json"), "utf8"));
    m.auth = { kind: "device" };
    writeFileSync(join(d, "connector.json"), JSON.stringify(m));
  });
  assert.ok(problems(await review(dir, { level: "verified", tests: false }), "shape")?.includes('auth.kind: "api_key" or "none"'));
});

test("symlinks and missing files are caught", async () => {
  const dir = copy((d) => {
    rmSync(join(d, "README.md"));
    symlinkSync("/etc/passwd", join(d, "passwd"));
  });
  const p = problems(await review(dir, { tests: false }), "files");
  assert.deepEqual(p, ["no symlinks: passwd", "README.md is missing"]);
});

test("the tree hash is the sha256sum of the installed files' sums", () => {
  const dir = copy();
  writeFileSync(join(dir, ".hidden"), "left out");
  const sums = execFileSync("sh", ["-c", "find . -type f ! -name '.*' | sed 's|^\\./||' | LC_ALL=C sort | xargs sha256sum"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(treeHash(dir), createHash("sha256").update(sums).digest("hex"));
});

test("the registry checker takes a well-formed entry and refuses a bad one", () => {
  const good = {
    id: "acme",
    name: "Acme",
    repo: "https://github.com/jane/acme-connector",
    path: "",
    commit: "a".repeat(40),
    tree: "b".repeat(64),
    data: "Your Acme orders, read on request.",
    network: ["api.acme.com"],
    commands: { orders: "read" },
    auth: "api_key",
    author: "jane",
    reviewed: { at: "2026-11-04", audit: "read every file", liveTest: "orders with a test account" },
    signature: Buffer.alloc(64).toString("base64"),
  };
  assert.deepEqual(checkRegistry({ connectors: [good] }, ["asana"]), []);
  const bad = checkRegistry({ connectors: [{ ...good, id: "asana", commands: { pay: "money" }, commit: "main" }] }, ["asana"]);
  assert.equal(bad.length, 3, String(bad));
});
