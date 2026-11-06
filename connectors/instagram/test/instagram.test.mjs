// Instagram connector tests, end to end through nanou's cli runtime: a local
// server answers like the Instagram API. Checks reads with the person's token,
// renewing a token close to expiry (and saving it), the refusal of every post
// or comment change unless the gateway approved it, that only nanou media
// links can be posted, that a post waits for Instagram to process its media,
// and that a reply or comment change acts only on the comment its card names.
// Run with `node --test "connectors/instagram/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const CLI = new URL("../../../runtime/cli/cli.mjs", import.meta.url).pathname;
const UID = "17841400000000001";
const POST = "18000000000000001";
const COMMENT = "17900000000000001";
const LINK = "https://relay.nanou.ai/v1/media/abcdefghijklmnopqrstuv.jpg";
const DAY = 86_400;

/** @type {Array<{ verb: string, path: string, query: URLSearchParams, form: URLSearchParams }>} */
let calls = [];
/** Tokens the API accepts. */
let valid = new Set(["tok-ana"]);
/** Status answers a container gives, one per poll. @type {string[]} */
let statuses = [];
/** quota_usage the account has used. */
let used = 3;

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(String(req.url), "http://x");
    const form = new URLSearchParams(raw);
    const token = url.searchParams.get("access_token") ?? form.get("access_token") ?? "";
    const at = url.pathname.replace(/^\/v23\.0/, "");
    calls.push({ verb: String(req.method), path: at, query: url.searchParams, form });
    const send = (/** @type {number} */ status, /** @type {any} */ json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (at === "/refresh_access_token") {
      if (token !== "tok-ana") return send(400, { error: { code: 190, message: "bad token" } });
      valid.add("tok-ana-2");
      return send(200, { access_token: "tok-ana-2", token_type: "bearer", expires_in: 60 * DAY });
    }
    if (!valid.has(token)) return send(400, { error: { code: 190, message: "Error validating access token" } });
    const comment = { id: COMMENT, text: "Love this! Where was it taken?", username: "bo.travels", timestamp: new Date().toISOString(), like_count: 2, hidden: false };
    if (at === "/me") return send(200, { user_id: UID, username: "ana.cooks", name: "Ana", account_type: "MEDIA_CREATOR", followers_count: 420, follows_count: 99, media_count: 31 });
    if (at === `/${UID}/media` && req.method === "GET") {
      return send(200, { data: [{ id: POST, caption: "Sunday bread", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://www.instagram.com/p/abc/", timestamp: new Date().toISOString(), like_count: 10, comments_count: 1 }] });
    }
    if (at === `/${POST}/comments`) return send(200, { data: [{ ...comment, replies: { data: [] } }] });
    if (at === `/${UID}/content_publishing_limit`) return send(200, { data: [{ quota_usage: used, config: { quota_total: 100, quota_duration: 86400 } }] });
    if (at === `/${UID}/media` && req.method === "POST") return send(200, { id: `c-${calls.filter((c) => c.path === at && c.verb === "POST").length}` });
    if (/^\/c-\d+$/.test(at)) return send(200, { status_code: statuses.shift() ?? "FINISHED" });
    if (at === `/${UID}/media_publish`) return send(200, { id: "18000000000000099" });
    if (at === "/18000000000000099") return send(200, { id: "18000000000000099", caption: "New", media_type: "IMAGE", permalink: "https://www.instagram.com/p/new/", timestamp: new Date().toISOString() });
    if (at === `/${COMMENT}` && req.method === "GET") return send(200, comment);
    if (at === `/${COMMENT}/replies` && req.method === "POST") return send(200, { id: "17900000000000077" });
    if (at === `/${COMMENT}` && (req.method === "POST" || req.method === "DELETE")) return send(200, { success: true });
    send(400, { error: { code: 100, message: `Unsupported get request. no ${req.method} ${at}` } });
  });
});

let home = "";
let base = "";
const dir = () => join(home, ".config", "connectors", "instagram");
/** @param {Record<string, unknown>} [extra] */
const account = (extra = {}) => {
  const t = Math.floor(Date.now() / 1000);
  writeFileSync(
    join(dir(), "ana.cooks.json"),
    JSON.stringify({ username: "ana.cooks", user_id: UID, owner: "ana", scope: "instagram_business_basic", access_token: "tok-ana", expires_at: t + 50 * DAY, connected_at: t - 10 * DAY, ...extra }),
  );
};

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(() => server.close());
beforeEach(() => {
  calls = [];
  valid = new Set(["tok-ana"]);
  statuses = [];
  used = 3;
  home = mkdtempSync(join(tmpdir(), "nanou-instagram-"));
  mkdirSync(dir(), { recursive: true });
  account();
});

/** Run `instagram …` through the runtime. @param {string[]} args @param {Record<string, string>} [env] @returns {Promise<{ code: number, json: any }>} */
function instagram(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "instagram", ...args], {
      env: {
        PATH: process.env.PATH,
        FAMILY_HOME: home,
        FAMILY_INSTAGRAM_API: `${base}/v23.0`,
        FAMILY_INSTAGRAM_REFRESH_URL: `${base}/refresh_access_token`,
        FAMILY_INSTAGRAM_POLL_MS: "5",
        FAMILY_INSTAGRAM_WAIT_MS: "200",
        ...env,
      },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code: Number(code), json: JSON.parse(out) }));
  });
}
const write = { NANOU_WRITE: "1" };
const changes = () => calls.filter((c) => c.verb !== "GET");

test("me names the account, and the token goes as a parameter, never in a header", async () => {
  const { code, json } = await instagram(["me"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.username, "ana.cooks");
  assert.equal(json.kind, "creator");
  assert.equal(json.followers, 420);
  assert.equal(calls[0].query.get("access_token"), "tok-ana");
});

test("media and comments read the recent posts, unanswered comments first", async () => {
  const media = await instagram(["media"]);
  assert.equal(media.code, 0, JSON.stringify(media.json));
  assert.deepEqual(media.json[0].kind, "image");
  assert.equal(media.json[0].link, "https://www.instagram.com/p/abc/");
  const recent = await instagram(["comments"]);
  assert.equal(recent.code, 0, JSON.stringify(recent.json));
  assert.equal(recent.json[0].from, "bo.travels");
  assert.equal(recent.json[0].answered, false);
  assert.equal(recent.json[0].post.id, POST);
});

test("a token with under a week left is renewed and saved, then used", async () => {
  account({ expires_at: Math.floor(Date.now() / 1000) + 3 * DAY });
  const { code } = await instagram(["me"]);
  assert.equal(code, 0);
  const saved = JSON.parse(readFileSync(join(dir(), "ana.cooks.json"), "utf8"));
  assert.equal(saved.access_token, "tok-ana-2");
  assert.ok(saved.expires_at > Date.now() / 1000 + 50 * DAY);
  assert.equal(calls.at(-1)?.query.get("access_token"), "tok-ana-2");
});

test("an expired token asks the person to reconnect", async () => {
  account({ expires_at: Math.floor(Date.now() / 1000) - 10 });
  const { code, json } = await instagram(["me"]);
  assert.equal(code, 1);
  assert.match(json.error, /expired.*Reconnect/);
  assert.equal(calls.length, 0);
});

test("posting without the gateway's approval is refused before any call", async () => {
  const { code, json } = await instagram(["post", "photo", "--url", LINK, "--caption", "Hi"]);
  assert.equal(code, 1);
  assert.match(json.error, /approv|card/i);
  assert.equal(calls.length, 0);
});

test("a photo posts from a nanou media link, after Instagram finished processing it", async () => {
  statuses = ["IN_PROGRESS", "FINISHED"];
  const { code, json } = await instagram(["post", "photo", "--url", LINK, "--caption", "Sunday bread #baking"], write);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.posted, true);
  assert.equal(json.link, "https://www.instagram.com/p/new/");
  const created = changes().find((c) => c.path === `/${UID}/media`);
  assert.equal(created?.form.get("image_url"), LINK);
  assert.equal(created?.form.get("caption"), "Sunday bread #baking");
  assert.equal(changes().find((c) => c.path === `/${UID}/media_publish`)?.form.get("creation_id"), "c-1");
});

test("only nanou media links can be posted", async () => {
  const { code, json } = await instagram(["post", "photo", "--url", "https://example.com/cat.jpg"], write);
  assert.equal(code, 1);
  assert.match(json.error, /media link/);
  assert.equal(changes().length, 0);
});

test("a reel that fails processing posts nothing", async () => {
  statuses = ["ERROR"];
  const { code, json } = await instagram(["post", "reel", "--url", LINK.replace(".jpg", ".mp4"), "--feed", "no"], write);
  assert.equal(code, 1);
  assert.match(json.error, /couldn't use that media/);
  assert.equal(changes().find((c) => c.path === `/${UID}/media`)?.form.get("share_to_feed"), "false");
  assert.equal(changes().some((c) => c.path === `/${UID}/media_publish`), false);
});

test("a carousel makes one item per link, videos as videos", async () => {
  const { code, json } = await instagram(["post", "carousel", "--urls", `${LINK},${LINK.replace(".jpg", ".mp4")}`, "--caption", "Trip"], write);
  assert.equal(code, 0, JSON.stringify(json));
  const made = changes().filter((c) => c.path === `/${UID}/media`);
  assert.equal(made.length, 3);
  assert.equal(made[0].form.get("is_carousel_item"), "true");
  assert.equal(made[1].form.get("media_type"), "VIDEO");
  assert.equal(made[2].form.get("media_type"), "CAROUSEL");
  assert.equal(made[2].form.get("children"), "c-1,c-2");
});

test("the 24-hour posting limit stops a post before anything is made", async () => {
  used = 100;
  const { code, json } = await instagram(["post", "photo", "--url", LINK], write);
  assert.equal(code, 1);
  assert.match(json.error, /limit/);
  assert.equal(changes().length, 0);
});

test("a reply goes only to the comment its card names", async () => {
  const wrong = await instagram(["reply", COMMENT, "--to", "@someone.else", "--quote", "Love this", "--text", "Thanks!"], write);
  assert.equal(wrong.code, 1);
  assert.match(wrong.json.error, /by @bo\.travels/);
  const words = await instagram(["reply", COMMENT, "--to", "@bo.travels", "--quote", "Hate this", "--text", "Thanks!"], write);
  assert.equal(words.code, 1);
  assert.match(words.json.error, /not what --quote gives/);
  assert.equal(changes().length, 0);
  const ok = await instagram(["reply", COMMENT, "--to", "@Bo.Travels", "--quote", "love this!  where", "--text", "Thanks! At the lake."], write);
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  assert.equal(changes().find((c) => c.path === `/${COMMENT}/replies`)?.form.get("message"), "Thanks! At the lake.");
});

test("hide and delete act on the named comment once approved", async () => {
  const hide = await instagram(["comment", "hide", COMMENT, "--from", "bo.travels", "--quote", "Love this"], write);
  assert.equal(hide.code, 0, JSON.stringify(hide.json));
  assert.equal(changes().at(-1)?.form.get("hide"), "true");
  const del = await instagram(["comment", "delete", COMMENT, "--from", "bo.travels", "--quote", "Love"], write);
  assert.equal(del.code, 0, JSON.stringify(del.json));
  assert.equal(changes().at(-1)?.verb, "DELETE");
  const unapproved = await instagram(["comment", "delete", COMMENT, "--from", "bo.travels", "--quote", "Love"]);
  assert.equal(unapproved.code, 1);
});
