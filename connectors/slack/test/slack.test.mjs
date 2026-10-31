// Slack connector tests, end to end through nanou's cli runtime: a local
// server answers like Slack's Web API. Checks reads with the person's token,
// names instead of ids (and the people cache in the account's state), the
// refusal of posting unless the gateway approved it, and what `whoami` says
// the token can do. Run with `node --test "connectors/slack/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const CLI = new URL("../../../runtime/cli/cli.mjs", import.meta.url).pathname;

/** @type {Array<{ method: string, verb: string, token: string, body: any }>} */
let calls = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(String(req.url), "http://x");
    const method = url.pathname.replace(/^\/api\//, "");
    calls.push({ method, verb: String(req.method), token: String(req.headers.authorization), body: raw ? JSON.parse(raw) : null });
    const send = (/** @type {any} */ json, /** @type {Record<string, string>} */ headers = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== "Bearer xoxp-ana-0000000000000000000") return send({ ok: false, error: "invalid_auth" });
    if (method === "auth.test") return send({ ok: true, team: "Work", user: "ana", url: "https://work.slack.com/" }, { "x-oauth-scopes": "channels:read,channels:history,users:read,chat:write" });
    if (method === "users.list") return send({ ok: true, members: [{ id: "U1", name: "ana", profile: { real_name: "Ana" } }, { id: "U2", name: "bo", profile: { real_name: "Bo" } }] });
    if (method === "users.conversations") return send({ ok: true, channels: [{ id: "C0DEV0001", name: "dev" }, { id: "D0BO00001", is_im: true, user: "U2" }] });
    if (method === "conversations.history") return send({ ok: true, messages: [{ ts: "1767225601.000", user: "U2", text: "hi <@U1>" }, { ts: "1767225600.000", user: "U1", text: "morning" }] });
    if (method === "chat.postMessage") return send({ ok: true, channel: req.method === "POST" ? JSON.parse(raw).channel : "", ts: "1767225700.000" });
    if (method === "chat.getPermalink") return send({ ok: true, permalink: "https://work.slack.com/archives/C0DEV0001/p1767225700" });
    send({ ok: false, error: `unknown_method ${method}` });
  });
});

let home = "";
let api = "";
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  api = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api`;
});
after(() => server.close());
beforeEach(() => {
  calls = [];
  home = mkdtempSync(join(tmpdir(), "nanou-slack-"));
  mkdirSync(join(home, ".config", "connectors", "slack"), { recursive: true });
  writeFileSync(join(home, ".config", "connectors", "slack", "slack-ana.json"), JSON.stringify({ token: "xoxp-ana-0000000000000000000" }));
});

/** Run `slack …` through the runtime. @param {string[]} args @param {Record<string, string>} [env] */
function slack(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "slack", ...args], { env: { PATH: process.env.PATH, FAMILY_HOME: home, FAMILY_SLACK_API: api, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, json: JSON.parse(out) }));
  });
}

test("reads a channel with names instead of ids, and caches the people", async () => {
  const r = /** @type {any} */ (await slack(["history", "--channel", "#dev"]));
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.map((/** @type {any} */ m) => [m.from, m.text]), [["Ana", "morning"], ["Bo", "hi @Ana"]]);
  assert.ok(existsSync(join(home, ".config", "connectors", "slack", "state", "ana-users.json")));
  calls = [];
  await slack(["channels"]);
  assert.ok(!calls.some((c) => c.method === "users.list"), "the people come from the cache");
});

test("posting is refused without the gateway's approval, before calling Slack", async () => {
  for (const args of [["send", "--channel", "#dev", "--text", "hi"], ["react", "--channel", "#dev", "--ts", "1.2", "--emoji", "eyes"]]) {
    const r = /** @type {any} */ (await slack(args));
    assert.equal(r.code, 1);
    assert.match(r.json.error, /needs approval/);
  }
  assert.equal(calls.length, 0);
});

test("an approved message is posted, with its link", async () => {
  const r = /** @type {any} */ (await slack(["send", "--channel", "#dev", "--text", "Deploy done"], { NANOU_WRITE: "1" }));
  assert.equal(r.code, 0);
  assert.equal(r.json.link, "https://work.slack.com/archives/C0DEV0001/p1767225700");
  const post = calls.find((c) => c.method === "chat.postMessage");
  assert.equal(post?.verb, "POST");
  assert.deepEqual(post?.body, { channel: "C0DEV0001", text: "Deploy done" });
});

test("whoami says what the token can and can't do", async () => {
  const r = /** @type {any} */ (await slack(["whoami"]));
  assert.ok(r.json.works.includes("post messages"));
  assert.ok(r.json.missing.includes("search"));
});
