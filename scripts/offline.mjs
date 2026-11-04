// Loaded with --import by scripts/review.mjs (through NODE_OPTIONS, so the
// processes a test starts get it too): every connection but loopback is
// refused, and each refused host is written to NANOU_OFFLINE_LOG. Tests run
// on recorded responses only; this makes sure of it even where the machine
// has a network (CI).
import { appendFileSync } from "node:fs";
import net from "node:net";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);
const log = process.env.NANOU_OFFLINE_LOG;
const connect = net.Socket.prototype.connect;

/** The options of a Socket#connect call, whichever form it was called in. @param {any[]} args */
function options(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") return first;
  return { port: first, host: typeof args[1] === "string" ? args[1] : undefined, path: typeof first === "string" && Number.isNaN(Number(first)) ? first : undefined };
}

net.Socket.prototype.connect = function (/** @type {any[]} */ ...args) {
  const o = options(args);
  const host = String(o.host ?? "localhost").replace(/^\[|\]$/g, "");
  if (o.path || LOOPBACK.has(host) || host.startsWith("127.")) return connect.apply(this, /** @type {any} */ (args));
  if (log) appendFileSync(log, `${host}\n`);
  process.nextTick(() => this.destroy(Object.assign(new Error(`offline review: ${host} refused (tests use recorded responses)`), { code: "ECONNREFUSED" })));
  return this;
};
