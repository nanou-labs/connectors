// GitHub policy shared by nanou's gateway (which commands get an approval
// card, and what the card says) and this connector's `gh` wrapper (src/gh.mjs,
// which refuses every write unless GITHUB_READONLY=0). One list, so the card
// and the wrapper can't disagree: a write classified as a read still fails in
// the wrapper. The manifest names it as `tool.policy`: gh's commands are too
// many to list one by one, so this module classifies them instead.
//
// The wrapper's own words: `gh --account <login> …` picks one of the person's
// connected accounts, `gh accounts` lists them, `gh git <git args>` runs git
// with the token (push needs a card; fetch, pull, clone, ls-remote don't).

/** Read-only verbs per `gh` command group; "*" = the whole group only reads. */
export const GH_READS = {
  pr: new Set(["list", "view", "status", "diff", "checks", "checkout"]),
  issue: new Set(["list", "view", "status"]),
  repo: new Set(["list", "view", "clone"]),
  run: new Set(["list", "view", "watch", "download"]),
  workflow: new Set(["list", "view"]),
  release: new Set(["list", "view", "download"]),
  label: new Set(["list"]),
  gist: new Set(["list", "view"]),
  cache: new Set(["list"]),
  ruleset: new Set(["list", "view", "check"]),
  project: new Set(["list", "view", "field-list", "item-list"]),
  org: new Set(["list"]),
  auth: new Set(["status"]),
  search: "*",
  status: "*",
  browse: "*",
  accounts: "*",
  help: "*",
  version: "*",
};

/**
 * Never run, even approved: they print or change credentials, run code from
 * the internet, or administer repositories (the GitHub App doesn't get
 * Administration anyway). `auth` other than `status` would show the token.
 */
export const GH_BLOCKED = new Set([
  "auth", "extension", "extensions", "ext", "alias", "config", "secret", "variable", "ssh-key", "gpg-key",
  "codespace", "cs", "attestation", "copilot", "agent-task", "completion",
]);
/** `repo` actions that are never run (admin or destructive beyond a card). */
const REPO_BLOCKED = new Set(["delete", "archive", "unarchive", "rename", "deploy-key", "autolink", "gitignore", "license"]);

/** Flags with no value; any other flag without `=` takes the next word (as cobra assumes for unknown ones). */
const BOOL = new Set(["-h", "--help", "--web", "-w", "--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"]);

/** git subcommands `gh git …` runs without a card (they only read from GitHub). */
export const GIT_READS = new Set(["fetch", "pull", "clone", "ls-remote", "status", "log", "diff", "show", "branch", "remote"]);

/**
 * Split the wrapper's own leading `--account <login>` off.
 * @param {string[]} args @returns {{ account: string | null, rest: string[] }}
 */
export function splitAccount(args) {
  const a = args[0];
  if (a === "--account" || a === "-a") return { account: args[1] ?? "", rest: args.slice(2) };
  if (a?.startsWith("--account=")) return { account: a.slice("--account=".length), rest: args.slice(1) };
  return { account: null, rest: args };
}

/**
 * The command group and its action, skipping flags the way cobra does.
 * @param {string[]} args after `gh` (and `--account`) @returns {{ group?: string, verb?: string, help: boolean }}
 */
export function words(args) {
  const out = [];
  let help = false;
  for (let i = 0; i < args.length && out.length < 2; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "--help" || a === "-h") help = true;
    if (!a.startsWith("-")) out.push(a);
    else if (!a.includes("=") && !BOOL.has(a)) i++;
  }
  if (args.includes("--help") || args.includes("-h")) help = true;
  return { group: out[0], verb: out[1], help };
}

/** Words that aren't flags or flag values. @param {string[]} args */
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) out.push(a);
    else if (!a.includes("=") && !BOOL.has(a) && !/^-[A-Za-z]./.test(a)) i++;
  }
  return out;
}

/** Values of a flag in `--f v`, `--f=v` and `-Xv` forms. @param {string[]} args @param {string[]} names */
function values(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a === n) out.push(args[i + 1] ?? "");
      else if (a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1));
      else if (n.length === 2 && a.startsWith(n) && !a.startsWith("--")) out.push(a.slice(2));
    }
  }
  return out;
}

/**
 * Whether a `gh api …` call only reads: GET (gh's default unless fields are
 * sent), or a GraphQL query with no mutation in it and nothing read from a file.
 * @param {string[]} args after `api`
 */
export function apiIsRead(args) {
  const fields = values(args, ["-f", "-F", "--field", "--raw-field"]);
  const input = values(args, ["--input"]);
  const method = (values(args, ["-X", "--method"]).at(-1) ?? (fields.length || input.length ? "POST" : "GET")).toUpperCase();
  const endpoint = args.find((a, i) => !a.startsWith("-") && !(i > 0 && args[i - 1].startsWith("-") && !args[i - 1].includes("=") && !BOOL.has(args[i - 1])));
  if (endpoint === "graphql") {
    if (input.length || fields.some((f) => /^[^=]*=@/.test(f))) return false;
    return !/mutation/i.test(args.join(" "));
  }
  return method === "GET";
}

/**
 * Classify one `gh` invocation (the words after the binary).
 * @param {string[]} args
 * @returns {"read" | "write" | "blocked"}
 */
export function ghKind(args) {
  const { rest } = splitAccount(args);
  if (rest.length === 0) return "read";
  const { group, verb, help } = words(rest);
  if (!group) return help || rest.includes("--version") ? "read" : "write";
  if (group === "auth" && verb === "status") return "read";
  if (GH_BLOCKED.has(group)) return "blocked";
  if (group === "repo" && verb && REPO_BLOCKED.has(verb)) return "blocked";
  if (help) return "read";
  if (group === "api") return apiIsRead(rest.slice(rest.indexOf("api") + 1)) ? "read" : "write";
  if (group === "git") {
    // Options that run a program or change config (`-c core.sshCommand=…`, `--upload-pack=…`) always get a card.
    const g = rest.slice(rest.indexOf("git") + 1);
    const before = g.slice(0, g.indexOf(verb ?? ""));
    const risky = g.some((a) => /^(-c|--config|--config-env|--exec-path|-u|--upload-pack|--receive-pack|--exec|--push)(=|$)/.test(a));
    return verb && GIT_READS.has(verb) && !risky && before.every((a, i) => a === "-C" || before[i - 1] === "-C") ? "read" : "write";
  }
  const reads = GH_READS[group];
  if (reads === "*") return "read";
  return reads && verb && reads.has(verb) ? "read" : "write";
}

/** Card wording per action: [title, button]. */
const ACTIONS = {
  "pr create": ["🐙 GitHub: open a pull request", "Open"],
  "pr comment": ["🐙 GitHub: comment on a pull request", "Post"],
  "pr review": ["🐙 GitHub: review a pull request", "Post"],
  "pr merge": ["🐙 GitHub: merge a pull request", "Merge"],
  "pr close": ["🐙 GitHub: close a pull request", "Close"],
  "pr edit": ["🐙 GitHub: edit a pull request", "Approve"],
  "issue create": ["🐙 GitHub: open an issue", "Open"],
  "issue comment": ["🐙 GitHub: comment on an issue", "Post"],
  "issue close": ["🐙 GitHub: close an issue", "Close"],
  "issue edit": ["🐙 GitHub: edit an issue", "Approve"],
  "git push": ["🐙 GitHub: push", "Push"],
  "release create": ["🐙 GitHub: publish a release", "Publish"],
};

/**
 * What the approval card shows for a held `gh` command.
 * @param {string[]} args @returns {{ title: string, verb: string, fields: Array<[string, string]>, body: string | null }}
 */
export function ghCard(args) {
  const { account, rest } = splitAccount(args);
  const { group = "", verb = "" } = words(rest);
  const repo = values(rest, ["-R", "--repo"])[0];
  const pos = positionals(rest);
  const target = pos[2];
  const [title, button] = ACTIONS[`${group} ${verb}`] ??
    (group === "api"
      ? ["🐙 GitHub: API call", "Approve"]
      : [`🐙 GitHub: ${[group, verb].filter(Boolean).join(" ")}`, /^(delete|close|lock)$/.test(verb) ? "Delete" : "Approve"]);
  /** @type {Array<[string, string]>} */
  const fields = [];
  if (account) fields.push(["Account", account]);
  if (repo) fields.push(["Repository", repo]);
  if (group === "api") {
    const method = values(rest, ["-X", "--method"]).at(-1)?.toUpperCase() ?? "POST";
    fields.push(["Request", `${method} ${pos[1] ?? ""}`.trim()]);
  } else if (group === "git") {
    fields.push(["Command", `git ${rest.slice(rest.indexOf("git") + 1).join(" ")}`]);
  } else if (target) fields.push([group === "pr" ? "Pull request" : group === "issue" ? "Issue" : "Target", target]);
  for (const [flag, label] of [["--title", "Title"], ["-t", "Title"], ["--base", "Into"], ["-B", "Into"], ["--head", "From branch"], ["-H", "From branch"]]) {
    const v = values(rest, [flag])[0];
    if (v && !fields.some(([l]) => l === label)) fields.push([label, v]);
  }
  for (const m of ["--merge", "--squash", "--rebase"]) if (rest.includes(m)) fields.push(["How", m.slice(2)]);
  if (rest.includes("--approve")) fields.push(["Review", "approve"]);
  if (rest.includes("--request-changes")) fields.push(["Review", "request changes"]);
  const body = values(rest, ["--body", "-b"])[0] ?? null;
  return { title, verb: button, fields, body };
}

/** The policy contract nanou's checker holds a `tool.policy` module to. */
export default { kind: ghKind, card: ghCard };
