// Outlook connector tests, end to end through nanou's cli runtime: a local
// server answers like Microsoft Graph and Microsoft's token endpoint. Checks
// reads with the person's token, renewing an expired access (and saving the
// new tokens), the refusal of every send or change unless the gateway
// approved it, that a reply goes to exactly the people on its card, that an
// event change acts on the event its card names, time zones, and picking one
// of several accounts. Run with `node --test "connectors/outlook/test/*.test.mjs"`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const CLI = new URL("../../../runtime/cli/cli.mjs", import.meta.url).pathname;
const MSG = "AAMkAGI2TG93AAA=";
const EVT = "AAMkAGI2EVENT001=";

/** @type {Array<{ verb: string, path: string, query: URLSearchParams, token: string, prefer: string, body: any }>} */
let calls = [];
/** Scripted answers: path → status, for one call each. @type {Record<string, number[]>} */
let fail = {};
/** Tokens Graph accepts. */
let valid = new Set(["at-ana"]);

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(String(req.url), "http://x");
    const path = decodeURIComponent(url.pathname);
    const body = raw && req.headers["content-type"]?.startsWith("application/json") ? JSON.parse(raw) : raw ? Object.fromEntries(new URLSearchParams(raw)) : null;
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    calls.push({ verb: String(req.method), path, query: url.searchParams, token, prefer: String(req.headers.prefer ?? ""), body });
    const send = (/** @type {number} */ status, /** @type {any} */ json, /** @type {Record<string, string>} */ headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    if (path === "/token") {
      if (body.refresh_token !== "rt-ana") return send(400, { error: "invalid_grant" });
      valid.add("at-ana-2");
      return send(200, { access_token: "at-ana-2", refresh_token: "rt-ana-2", expires_in: 3600, scope: "Mail.Read" });
    }
    const scripted = fail[path]?.shift();
    if (scripted) return send(scripted, { error: { code: "TooManyRequests", message: "slow down" } }, { "retry-after": "0" });
    if (!valid.has(token)) return send(401, { error: { code: "InvalidAuthenticationToken", message: "expired" } });
    const at = path.replace(/^\/v1\.0/, "");
    const person = (/** @type {string} */ name, /** @type {string} */ address) => ({ emailAddress: { name, address } });
    const message = {
      id: MSG,
      subject: "School trip",
      from: person("Teacher", "teacher@school.org"),
      toRecipients: [person("Ana", "ana@outlook.com"), person("Bo", "bo@x.com")],
      ccRecipients: [person("Head", "head@school.org")],
      receivedDateTime: "2026-11-03T08:00:00Z",
      bodyPreview: "Permission slips by Friday",
      isRead: false,
      hasAttachments: true,
      conversationId: "conv-1",
      webLink: "https://outlook.live.com/owa/?ItemID=1",
      body: { contentType: "text", content: "Please sign the permission slip by Friday." },
    };
    if (at === "/me" && req.method === "GET") return send(200, { displayName: "Ana", mail: "ana@outlook.com" });
    if (at === "/me/mailFolders/inbox/messages") return send(200, { value: [message] });
    if (at === "/me/mailFolders") return send(200, { value: [{ id: "f-receipts", displayName: "Receipts", unreadItemCount: 2, totalItemCount: 9 }] });
    if (at === "/me/mailFolders/f-receipts/messages") return send(200, { value: [] });
    if (at === `/me/messages/${MSG}`) return send(200, message);
    if (at === `/me/messages/${MSG}/attachments`) return send(200, { value: [{ name: "slip.pdf", contentType: "application/pdf", size: 1200, isInline: false }] });
    if (at === `/me/messages/${MSG}/reply` || at === `/me/messages/${MSG}/replyAll` || at === `/me/messages/${MSG}/forward` || at === "/me/sendMail") return send(202, undefined);
    if (at === "/me/calendarView") {
      return send(200, {
        value: [{ id: EVT, subject: "Dentist", start: { dateTime: "2026-11-05T10:00:00.0000000", timeZone: "Europe/Madrid" }, end: { dateTime: "2026-11-05T11:00:00.0000000", timeZone: "Europe/Madrid" }, isOrganizer: true, organizer: person("Ana", "ana@outlook.com"), webLink: "https://outlook.live.com/calendar/1" }],
        ...(url.searchParams.get("page") ? {} : { "@odata.nextLink": `http://${req.headers.host}/v1.0/me/calendarView?page=2` }),
      });
    }
    if (at === `/me/events/${EVT}` && req.method === "GET") return send(200, { id: EVT, subject: "Dentist", isOrganizer: false, attendees: [], start: {} });
    if (at === `/me/events/${EVT}` && req.method === "DELETE") return send(204, undefined);
    if (at === `/me/events/${EVT}` && req.method === "PATCH") return send(200, { id: EVT, subject: body.subject ?? "Dentist", webLink: "https://outlook.live.com/calendar/1" });
    if (at === `/me/events/${EVT}/accept`) return send(202, undefined);
    if (at === "/me/events") return send(201, { id: "new-1", subject: body.subject, webLink: "https://outlook.live.com/calendar/new-1" });
    if (at === "/me/drive/root/children") return send(200, { value: [{ name: "Documents", folder: { childCount: 2 }, webUrl: "w" }, { name: "cv.pdf", file: {}, webUrl: "w" }] });
    if (at === "/me/drive/root:/Documents:/children") return send(200, { value: [{ name: "School", folder: { childCount: 0 }, webUrl: "w" }, { name: "Taxes", folder: { childCount: 4 }, webUrl: "w" }] });
    if (at === "/me/drive/root:/Documents/Taxes:/children") return send(200, { value: [{ name: "2025", folder: { childCount: 1 }, webUrl: "w" }] });
    if (at.startsWith("/me/drive/root:/") && at.endsWith(":/content") && req.method === "PUT") {
      const name = at.slice(0, -":/content".length).split("/").pop();
      return send(201, { name: name === "taken.pdf" ? "taken 1.pdf" : name, webUrl: `https://onedrive.live.com/${name}` });
    }
    if (at === "/me/drive/root/search(q='passport')") return send(200, { value: [{ id: "d1", name: "passport.pdf", size: 10, file: { mimeType: "application/pdf" }, webUrl: "https://onedrive.live.com/d1", parentReference: { path: "/drive/root:/Documents" } }] });
    send(404, { error: { code: "ErrorItemNotFound", message: `no ${req.method} ${at}` } });
  });
});

let home = "";
let base = "";
const dir = () => join(home, ".config", "connectors", "outlook");
/** @param {string} address @param {Record<string, unknown>} [extra] */
const account = (address, extra = {}) =>
  writeFileSync(
    join(dir(), `${address}.json`),
    JSON.stringify({ address, owner: "ana", client_id: "client-123", scope: "offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.ReadWrite", access_token: "at-ana", expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "rt-ana", ...extra }),
  );

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(() => server.close());
beforeEach(() => {
  calls = [];
  fail = {};
  valid = new Set(["at-ana"]);
  home = mkdtempSync(join(tmpdir(), "nanou-outlook-"));
  mkdirSync(dir(), { recursive: true });
  account("ana@outlook.com");
});

/** Run `outlook …` through the runtime. @param {string[]} args @param {Record<string, string>} [env] @returns {Promise<{ code: number, json: any }>} */
function outlook(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "outlook", ...args], {
      env: { PATH: process.env.PATH, FAMILY_HOME: home, FAMILY_OUTLOOK_API: `${base}/v1.0`, FAMILY_OUTLOOK_TOKEN_URL: `${base}/token`, ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code: Number(code), json: JSON.parse(out) }));
  });
}
const write = { NANOU_WRITE: "1" };
const graphCalls = () => calls.filter((c) => c.path !== "/token");

test("mail lists the inbox, newest first, as the person would describe it", async () => {
  const { code, json } = await outlook(["mail", "--unread", "--since", "2026-11-01", "--from", "teacher@school.org", "--limit", "5"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json[0], {
    id: MSG,
    at: "2026-11-03T08:00:00Z",
    from: "Teacher <teacher@school.org>",
    to: ["Ana <ana@outlook.com>", "Bo <bo@x.com>"],
    cc: ["Head <head@school.org>"],
    subject: "School trip",
    preview: "Permission slips by Friday",
    unread: true,
    attachments: true,
    thread: "conv-1",
    link: "https://outlook.live.com/owa/?ItemID=1",
  });
  const q = calls[0].query;
  assert.equal(calls[0].token, "at-ana");
  assert.equal(q.get("$filter"), "receivedDateTime ge 2026-11-01T00:00:00Z and isRead eq false and from/emailAddress/address eq 'teacher@school.org'");
  assert.equal(q.get("$orderby"), "receivedDateTime desc");
  assert.equal(q.get("$top"), "5");
});

test("a search goes to every folder, its filters folded into the search words", async () => {
  await outlook(["mail", "--search", 'trip "slip"', "--from", "teacher@school.org"]);
  assert.equal(calls[0].path, "/v1.0/me/messages");
  assert.equal(calls[0].query.get("$search"), '"trip slip from:teacher@school.org"');
  assert.equal(calls[0].query.get("$filter"), null);
  await outlook(["mail", "--folder", "Receipts"]);
  assert.deepEqual(calls.slice(-2).map((c) => c.path), ["/v1.0/me/mailFolders", "/v1.0/me/mailFolders/f-receipts/messages"]);
});

test("message reads the whole text and the attachments' names", async () => {
  const { json } = await outlook(["message", MSG]);
  assert.equal(json.body, "Please sign the permission slip by Friday.");
  assert.deepEqual(json.attachments, [{ name: "slip.pdf", type: "application/pdf", size: 1200 }]);
  assert.equal(calls[0].prefer, 'outlook.body-content-type="text"');
});

test("an expired access is renewed with the refresh token and saved", async () => {
  account("ana@outlook.com", { expires_at: Math.floor(Date.now() / 1000) + 10 });
  const { code } = await outlook(["me"]);
  assert.equal(code, 0);
  const t = calls.find((c) => c.path === "/token");
  assert.deepEqual(t?.body, { client_id: "client-123", grant_type: "refresh_token", refresh_token: "rt-ana", scope: "offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.ReadWrite" });
  assert.equal(graphCalls()[0].token, "at-ana-2");
  const saved = JSON.parse(readFileSync(join(dir(), "ana@outlook.com.json"), "utf8"));
  assert.equal(saved.access_token, "at-ana-2");
  assert.equal(saved.refresh_token, "rt-ana-2");
  assert.equal(saved.owner, "ana");
  assert.ok(saved.expires_at > Date.now() / 1000 + 3000);
});

test("Graph refusing the token renews it once; a revoked grant asks to reconnect", async () => {
  valid = new Set(); // at-ana is no longer accepted; the renewed one is
  const ok = await outlook(["me"]);
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  assert.deepEqual(graphCalls().map((c) => c.token), ["at-ana", "at-ana-2"]);
  account("ana@outlook.com", { expires_at: 1, refresh_token: "rt-revoked" });
  const gone = await outlook(["me"]);
  assert.equal(gone.code, 1);
  assert.match(gone.json.error, /expired or was revoked\. Reconnect it on nanou\.ai → Connectors → Outlook/);
});

test("throttling waits and tries again", async () => {
  fail = { "/v1.0/me": [429, 503] };
  const { code, json } = await outlook(["me"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.address, "ana@outlook.com");
});

test("sending is refused unless the gateway approved it, then sends exactly that", async () => {
  const args = ["send", "--to", "bo@x.com, Cy <cy@y.com>", "--subject", "Dinner", "--body", "Friday at 8?"];
  const held = await outlook(args);
  assert.equal(held.code, 1);
  assert.match(held.json.error, /needs approval/);
  assert.equal(calls.length, 0);
  assert.match((await outlook([...args, "--readonly"], write)).json.error, /read-only/);
  const { code, json } = await outlook(args, write);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(calls[0].body, {
    message: {
      subject: "Dinner",
      body: { contentType: "Text", content: "Friday at 8?" },
      toRecipients: [{ emailAddress: { address: "bo@x.com" } }, { emailAddress: { address: "cy@y.com" } }],
      ccRecipients: [],
      bccRecipients: [],
    },
    saveToSentItems: true,
  });
  assert.match((await outlook(["send", "--to", "not-an-address", "--subject", "x", "--body", "y"], write)).json.error, /isn't an email address/);
});

test("a reply goes to exactly the people on its card, or nothing is sent", async () => {
  const wrong = await outlook(["reply", MSG, "--to", "bo@x.com", "--body", "Signed!"], write);
  assert.equal(wrong.code, 1);
  assert.match(wrong.json.error, /would go to teacher@school\.org \(or, to everyone: teacher@school\.org, bo@x\.com, head@school\.org\)/);
  const badSubject = await outlook(["reply", MSG, "--to", "teacher@school.org", "--subject", "Lunch", "--body", "x"], write);
  assert.match(badSubject.json.error, /is "School trip", not "Lunch": nothing was sent/);
  assert.ok(!calls.some((c) => c.verb === "POST"));

  const one = await outlook(["reply", MSG, "--to", "teacher@school.org", "--subject", "RE: School trip", "--body", "Signed!"], write);
  assert.equal(one.code, 0, JSON.stringify(one.json));
  assert.equal(one.json.replied, "sender");
  const all = await outlook(["reply", MSG, "--to", "head@school.org,teacher@school.org,bo@x.com", "--body", "Signed!"], write);
  assert.equal(all.json.replied, "all");
  const posts = calls.filter((c) => c.verb === "POST");
  assert.deepEqual(posts.map((c) => c.path), [`/v1.0/me/messages/${MSG}/reply`, `/v1.0/me/messages/${MSG}/replyAll`]);
  assert.deepEqual(posts[0].body, { comment: "Signed!" });
});

test("forward sends the message on to the card's people", async () => {
  const { code } = await outlook(["forward", MSG, "--to", "bo@x.com", "--subject", "School trip", "--body", "FYI"], write);
  assert.equal(code, 0);
  assert.deepEqual(calls.at(-1)?.body, { toRecipients: [{ emailAddress: { address: "bo@x.com" } }], comment: "FYI" });
});

test("events are read in the family's time zone, every page", async () => {
  const { code, json } = await outlook(["events", "--from", "2026-11-05", "--days", "2", "--tz", "Europe/Madrid"]);
  assert.equal(code, 0, JSON.stringify(json));
  const first = calls[0];
  assert.equal(first.query.get("startDateTime"), "2026-11-04T23:00:00Z");
  assert.equal(first.query.get("endDateTime"), "2026-11-06T23:00:00Z");
  assert.equal(first.prefer, 'outlook.timezone="Europe/Madrid"');
  assert.equal(calls.length, 2, "follows @odata.nextLink");
  assert.deepEqual(json[0], { id: EVT, subject: "Dentist", start: "2026-11-05T10:00", end: "2026-11-05T11:00", timeZone: "Europe/Madrid", organizer: "Ana <ana@outlook.com>", mine: true, preview: "", link: "https://outlook.live.com/calendar/1" });
  assert.match((await outlook(["events", "--tz", "Mars/Olympus"])).json.error, /isn't a time zone/);
});

test("event add saves a timed event in --tz, or an all-day one from dates", async () => {
  assert.match((await outlook(["event", "add", "--subject", "Dentist", "--start", "2026-11-05T10:00", "--end", "2026-11-05T11:00"], write)).json.error, /--tz/);
  const timed = await outlook(["event", "add", "--subject", "Dentist", "--start", "2026-11-05T10:00", "--end", "2026-11-05T11:00", "--tz", "Europe/Madrid", "--attendees", "bo@x.com", "--location", "Clinic"], write);
  assert.equal(timed.code, 0, JSON.stringify(timed.json));
  assert.deepEqual(calls.at(-1)?.body, {
    subject: "Dentist",
    start: { dateTime: "2026-11-05T10:00:00", timeZone: "Europe/Madrid" },
    end: { dateTime: "2026-11-05T11:00:00", timeZone: "Europe/Madrid" },
    isAllDay: false,
    location: { displayName: "Clinic" },
    attendees: [{ emailAddress: { address: "bo@x.com" }, type: "required" }],
  });
  assert.deepEqual(timed.json.invited, ["bo@x.com"]);
  await outlook(["event", "add", "--subject", "Holiday", "--start", "2026-12-24"], write);
  assert.deepEqual(calls.at(-1)?.body, { subject: "Holiday", start: { dateTime: "2026-12-24T00:00:00", timeZone: "UTC" }, end: { dateTime: "2026-12-25T00:00:00", timeZone: "UTC" }, isAllDay: true });
  await outlook(["event", "add", "--subject", "Call", "--start", "2026-11-05T10:00+01:00", "--end", "2026-11-05T10:30+01:00"], write);
  assert.deepEqual(calls.at(-1)?.body.start, { dateTime: "2026-11-05T09:00:00", timeZone: "UTC" });
  assert.match((await outlook(["event", "add", "--subject", "x", "--start", "2026-11-05"])).json.error, /needs approval/);
});

test("an event change acts only on the event its card names", async () => {
  const wrong = await outlook(["event", "delete", EVT, "--event", "Parents' evening"], write);
  assert.equal(wrong.code, 1);
  assert.match(wrong.json.error, /is "Dentist", not "Parents' evening": nothing was changed/);
  assert.match((await outlook(["event", "delete", EVT], write)).json.error, /--event/);
  assert.ok(!calls.some((c) => c.verb === "DELETE"));
  assert.equal((await outlook(["event", "delete", EVT, "--event", "dentist"], write)).code, 0);
  assert.ok(calls.some((c) => c.verb === "DELETE"));
  const moved = await outlook(["event", "update", EVT, "--event", "Dentist", "--start", "2026-11-06T09:00", "--end", "2026-11-06T10:00", "--tz", "Europe/Madrid"], write);
  assert.equal(moved.code, 0, JSON.stringify(moved.json));
  assert.deepEqual(calls.at(-1)?.body, { start: { dateTime: "2026-11-06T09:00:00", timeZone: "Europe/Madrid" }, isAllDay: false, end: { dateTime: "2026-11-06T10:00:00", timeZone: "Europe/Madrid" } });
  const yes = await outlook(["event", "respond", EVT, "--event", "Dentist", "--answer", "accept", "--comment", "See you"], write);
  assert.equal(yes.code, 0, JSON.stringify(yes.json));
  assert.deepEqual(calls.at(-1)?.body, { sendResponse: true, comment: "See you" });
  assert.match((await outlook(["event", "respond", EVT, "--event", "Dentist", "--answer", "perhaps"], write)).json.error, /accept, maybe or decline/);
});

test("reading an event is free, and `event <id>` isn't taken for a change", async () => {
  const { code } = await outlook(["event", EVT, "--tz", "Europe/Madrid"]);
  assert.equal(code, 0);
});

test("OneDrive files are listed with their links", async () => {
  const { json } = await outlook(["files", "--search", "passport"]);
  assert.deepEqual(json, [{ id: "d1", name: "passport.pdf", type: "application/pdf", size: 10, in: "/Documents", link: "https://onedrive.live.com/d1" }]);
});

test("several accounts: --owner picks the person, --account one of theirs", async () => {
  account("ana@work.example", { access_token: "at-ana" });
  writeFileSync(join(dir(), "bo@outlook.com.json"), JSON.stringify({ address: "bo@outlook.com", owner: "bo", access_token: "at-bo", refresh_token: "rt-bo", client_id: "c" }));
  const who = await outlook(["me"]);
  assert.match(who.json.error, /several people connected Outlook \(ana, bo\)/);
  const many = await outlook(["me", "--owner", "ana"]);
  assert.match(many.json.error, /ana connected several Outlook accounts \(ana@outlook\.com, ana@work\.example\): say which with --account/);
  const one = await outlook(["me", "--owner", "ana", "--account", "ana@work.example"]);
  assert.equal(one.code, 0, JSON.stringify(one.json));
  assert.match((await outlook(["me", "--owner", "cy"])).json.error, /cy hasn't connected Outlook/);
  assert.match((await outlook(["me", "--owner", "ana", "--account", "zed@x.com"])).json.error, /no Outlook account "zed@x\.com"/);
});

test("drive shows the OneDrive's folders as a tree, files left out", async () => {
  const { code, json } = await outlook(["drive", "--depth", "3"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json, {
    path: "/",
    folders: [
      { path: "/Documents", items: 2, folders: [{ path: "/Documents/School", items: 0 }, { path: "/Documents/Taxes", items: 4, folders: [{ path: "/Documents/Taxes/2025", items: 1 }] }] },
    ],
  });
  assert.equal((await outlook(["drive", "--path", "/Documents/../x"])).code, 1);
});

test("upload sends one of nanou's results into the folder on its card, only once approved", async () => {
  const out = join(home, ".nanou", "workspace", "out");
  mkdirSync(join(out, "school"), { recursive: true });
  writeFileSync(join(out, "school", "Trip plan.pdf"), "%PDF-1.4 trip");
  writeFileSync(join(out, "taken.pdf"), "%PDF-1.4");
  writeFileSync(join(home, ".nanou", "workspace", "MEMORY.md"), "private");
  const args = ["upload", "--file", "school/Trip plan.pdf", "--folder", "/Documents/School/"];
  // Not approved: nothing is sent.
  const held = await outlook(args);
  assert.equal(held.code, 1);
  assert.equal(graphCalls().length, 0);
  const { code, json } = await outlook(args, write);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json, { saved: true, name: "Trip plan.pdf", folder: "/Documents/School", link: "https://onedrive.live.com/Trip plan.pdf" });
  const put = graphCalls().at(-1);
  assert.equal(put?.verb, "PUT");
  assert.equal(put?.path, "/v1.0/me/drive/root:/Documents/School/Trip plan.pdf:/content");
  assert.equal(put?.query.get("@microsoft.graph.conflictBehavior"), "rename");
  assert.equal(String(put?.body && Object.keys(put.body)[0]).startsWith("%PDF"), true);
  // A name already there: OneDrive keeps both, and nanou says so.
  const again = await outlook(["upload", "--file", "taken.pdf", "--folder", "/"], write);
  assert.equal(again.json.name, "taken 1.pdf");
  assert.match(again.json.renamed, /already there/);
  // Only nanou's results: not other workspace files, paths or missing ones.
  for (const file of ["../MEMORY.md", "/etc/passwd", "nope.pdf", "school"]) {
    const r = await outlook(["upload", "--file", file, "--folder", "/Documents"], write);
    assert.equal(r.code, 1, file);
  }
  assert.equal((await outlook(["upload", "--file", "taken.pdf", "--folder", "/a/../b"], write)).code, 1);
  // Connected before saving existed (Files.Read): asked to reconnect once, nothing sent.
  account("ana@outlook.com", { scope: "offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.Read" });
  const before = graphCalls().length;
  const old = await outlook(["upload", "--file", "taken.pdf", "--folder", "/"], write);
  assert.equal(old.code, 1);
  assert.match(JSON.stringify(old.json), /reconnect it once/);
  assert.equal(graphCalls().length, before);
});
