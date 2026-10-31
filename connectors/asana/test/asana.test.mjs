// Asana connector tests, end to end through nanou's cli runtime: a local
// server answers like Asana's API. Checks reads with the person's token, the
// workspace being remembered, the refusal of every change unless the gateway
// approved it (NANOU_WRITE=1), picking whose account, and the inbox.
// Run with `node --test "connectors/asana/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const CLI = new URL("../../../runtime/cli/cli.mjs", import.meta.url).pathname;
const ME = "1100000001";
const WS = "2200000002";

/** @type {Array<{ method: string, path: string, token: string, body: any }>} */
let calls = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(String(req.url), "http://x");
    const path = url.pathname.replace(/^\/api\/1\.0/, "");
    calls.push({ method: String(req.method), path, token: String(req.headers.authorization), body: raw ? JSON.parse(raw) : null });
    const send = (/** @type {number} */ status, /** @type {any} */ json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (!/^Bearer 1\/[a-z]+:secret$/.test(String(req.headers.authorization))) return send(401, { errors: [{ message: "Not Authorized" }] });
    const task = (/** @type {string} */ gid, extra = {}) => ({
      gid,
      name: `Task ${gid}`,
      completed: false,
      memberships: [{ project: { name: "Web" }, section: { name: "Doing" } }],
      custom_fields: [{ name: "Dev Status", display_value: "Done" }, { name: "Priority", display_value: "High" }],
      permalink_url: `https://app.asana.com/0/0/${gid}`,
      ...extra,
    });
    if (path === "/users/me") return send(200, { data: { gid: ME, name: "Ana", email: "ana@example.com", workspaces: [{ gid: WS, name: "Work" }] } });
    if (path === "/tasks" && req.method === "GET") return send(200, { data: [task("3300000003")] });
    if (path === `/workspaces/${WS}/tasks/search`) return send(200, { data: [task("3300000003", { modified_at: new Date().toISOString() })] });
    if (path === "/tasks/3300000003/stories") {
      return send(200, {
        data: [
          { type: "comment", resource_subtype: "comment_added", text: "@Ana can you look?", html_text: `<body><a data-asana-gid="${ME}">@Ana</a></body>`, created_by: { gid: "9", name: "Bo" }, created_at: new Date().toISOString() },
          { type: "system", resource_subtype: "marked_complete", text: "Ana completed", created_by: { gid: ME, name: "Ana" }, created_at: new Date().toISOString() },
        ],
      });
    }
    if (path === "/tasks/3300000003" && req.method === "PUT") return send(200, { data: task("3300000003", { completed: true }) });
    send(404, { errors: [{ message: `no route ${req.method} ${path}` }] });
  });
});

let home = "";
let api = "";
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  api = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/1.0`;
});
after(() => server.close());
beforeEach(() => {
  calls = [];
  home = mkdtempSync(join(tmpdir(), "nanou-asana-"));
});

/** Save a person's token the way nanou's installer does. @param {string} owner */
function connect(owner) {
  mkdirSync(join(home, ".config", "connectors", "asana"), { recursive: true });
  writeFileSync(join(home, ".config", "connectors", "asana", `asana-${owner}.json`), JSON.stringify({ token: `1/${owner}:secret` }));
}

/** Run `asana …` through the runtime. @param {string[]} args @param {Record<string, string>} [env] */
function asana(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "asana", ...args], {
      env: { PATH: process.env.PATH, FAMILY_HOME: home, FAMILY_ASANA_API: api, ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, json: out.trim().startsWith("{") || out.trim().startsWith("[") ? JSON.parse(out) : out }));
  });
}

test("reads tasks with the person's own token and remembers the workspace", async () => {
  connect("ana");
  const r = /** @type {any} */ (await asana(["tasks"]));
  assert.equal(r.code, 0);
  assert.equal(r.json[0].gid, "3300000003");
  assert.equal(r.json[0].section, "Doing");
  assert.equal(r.json[0].status, "Dev Status: Done", "only status-like fields");
  assert.ok(calls.every((c) => c.token === "Bearer 1/ana:secret"));
  const saved = JSON.parse(readFileSync(join(home, ".config", "connectors", "asana", "asana-ana.json"), "utf8"));
  assert.equal(saved.workspace, WS);
  assert.equal(saved.token, "1/ana:secret");
});

test("every change is refused without the gateway's approval, before calling Asana", async () => {
  connect("ana");
  for (const args of [["complete", "3300000003"], ["comment", "3300000003", "--text", "hi"], ["create", "--name", "x"]]) {
    const r = /** @type {any} */ (await asana(args));
    assert.equal(r.code, 1);
    assert.match(r.json.error, /needs approval/);
  }
  const forced = /** @type {any} */ (await asana(["complete", "3300000003", "--readonly"], { NANOU_WRITE: "1" }));
  assert.equal(forced.code, 1, "--readonly wins over an approval");
  assert.equal(calls.length, 0);
});

test("an approved change runs", async () => {
  connect("ana");
  const r = /** @type {any} */ (await asana(["complete", "3300000003"], { NANOU_WRITE: "1" }));
  assert.equal(r.code, 0);
  assert.equal(r.json.done, true);
  assert.deepEqual(calls.at(-1)?.body, { data: { completed: true } });
});

test("picks whose account: the only one, else --owner", async () => {
  const none = /** @type {any} */ (await asana(["me"]));
  assert.match(none.json.error, /isn't connected/);
  connect("ana");
  connect("bo");
  const two = /** @type {any} */ (await asana(["me"]));
  assert.match(two.json.error, /several people connected Asana \(ana, bo\)/);
  const bo = /** @type {any} */ (await asana(["me", "--owner", "Bo"]));
  assert.equal(bo.code, 0);
  assert.ok(calls.every((c) => c.token === "Bearer 1/bo:secret"));
  const nobody = /** @type {any} */ (await asana(["me", "--owner", "cy"]));
  assert.match(nobody.json.error, /cy hasn't connected Asana/);
});

test("the inbox shows what others did and flags mentions", async () => {
  connect("ana");
  const r = /** @type {any} */ (await asana(["inbox", "--since", "2d"]));
  assert.equal(r.code, 0);
  assert.equal(r.json.mentions, 1);
  assert.equal(r.json.tasks[0].events.length, 1, "the person's own actions are left out");
  assert.equal(r.json.tasks[0].events[0].by, "Bo");
});

test("unknown commands and help", async () => {
  connect("ana");
  const r = /** @type {any} */ (await asana(["delete", "3300000003"]));
  assert.match(r.json.error, /unknown command "delete"/);
  const help = /** @type {any} */ (await asana(["help"]));
  assert.match(help.json, /changes need approval/);
  rmSync(home, { recursive: true, force: true });
});
