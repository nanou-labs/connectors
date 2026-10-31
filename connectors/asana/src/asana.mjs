// Asana: a person's tasks, what changed on them, and (once approved on a
// card) comments and task changes, with their own personal access token.
// Run by nanou's cli runtime (runtime/cli/README.md) as the `asana` command:
// the runtime picks the account, reads the token and refuses the changing
// commands unless the gateway approved them.

const API = process.env.FAMILY_ASANA_API ?? "https://app.asana.com/api/1.0";
/** Task fields worth showing. */
const TASK_FIELDS =
  "name,completed,completed_at,due_on,due_at,assignee.name,projects.name,memberships.project.name,memberships.section.name," +
  "custom_fields.name,custom_fields.display_value,permalink_url,modified_at";

/**
 * @typedef {{ words: string[], flags: Record<string, string | true>, flag: (k: string) => string | undefined,
 *   secret: () => Record<string, any>, saveSecret: (v: unknown) => void, fail: (msg: string) => never }} Ctx
 */

/**
 * Call the Asana API with the account's token; waits and retries when rate limited.
 * @param {Ctx} ctx @param {string} method @param {string} path e.g. "/tasks"
 * @param {{ query?: Record<string, unknown>, data?: Record<string, unknown>, page?: boolean }} [opts]
 */
async function asana(ctx, method, path, opts = {}) {
  const qs = new URLSearchParams(
    Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, String(v)]),
  );
  const { token } = ctx.secret();
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(`${API}${path}${qs.size ? `?${qs}` : ""}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(opts.data ? { "content-type": "application/json" } : {}),
      },
      body: opts.data ? JSON.stringify({ data: opts.data }) : undefined,
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 3) * 1000));
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) ctx.fail(`Asana ${method} ${path}: ${body.errors?.map((/** @type {any} */ e) => e.message).join("; ") ?? res.status}`);
  return opts.page ? body : body.data;
}

/**
 * Every item of a paginated GET (follows next_page offsets, up to `max`).
 * @param {Ctx} ctx @param {string} path @param {Record<string, unknown>} query @param {number} [max]
 */
async function asanaAll(ctx, path, query, max = 1000) {
  const out = [];
  let offset;
  do {
    const page = await asana(ctx, "GET", path, { query: { ...query, limit: 100, offset }, page: true });
    out.push(...(page.data ?? []));
    offset = page.next_page?.offset;
  } while (offset && out.length < max);
  return out;
}

/** The workspace to use: the remembered one, else the first (then remembered). @param {Ctx} ctx */
async function workspace(ctx) {
  const saved = ctx.secret();
  if (saved.workspace) return saved.workspace;
  const me = await asana(ctx, "GET", "/users/me", { query: { opt_fields: "workspaces.name" } });
  const ws = me.workspaces?.[0]?.gid;
  if (!ws) ctx.fail("this Asana user has no workspace");
  ctx.saveSecret({ ...saved, workspace: ws });
  return ws;
}

/** A project gid from a gid or (part of) its name. @param {Ctx} ctx @param {string} ref */
async function projectId(ctx, ref) {
  if (/^[0-9]{6,}$/.test(ref)) return ref;
  const list = await asanaAll(ctx, "/projects", { workspace: await workspace(ctx), archived: false, opt_fields: "name" });
  const want = ref.toLowerCase();
  const hits = list.filter((p) => p.name.toLowerCase().includes(want));
  const exact = hits.find((p) => p.name.toLowerCase() === want);
  if (exact || hits.length === 1) return (exact ?? hits[0]).gid;
  ctx.fail(hits.length ? `"${ref}" matches several projects: ${hits.map((p) => p.name).join(", ")}` : `no project matches "${ref}"`);
}

/**
 * Where a task stands besides the completed checkbox: its section (board
 * column) per project and every custom field named like "status", as set.
 * Teams use these differently ("Dev Status: Done" with "Oak Status: Open"),
 * so they are reported side by side, never merged into one verdict.
 * @param {any} t
 */
export function taskStatus(t) {
  const sections = (t.memberships ?? [])
    .filter((/** @type {any} */ m) => m.section?.name && !/^untitled section$/i.test(m.section.name))
    .map((/** @type {any} */ m) => ((t.memberships?.length ?? 0) > 1 && m.project?.name ? `${m.project.name}: ${m.section.name}` : m.section.name));
  const fields = (t.custom_fields ?? [])
    .filter((/** @type {any} */ f) => /status/i.test(f.name ?? "") && f.display_value)
    .map((/** @type {any} */ f) => `${f.name}: ${f.display_value}`);
  return {
    ...(sections.length ? { section: sections.join(" · ") } : {}),
    ...(fields.length ? { status: fields.join(" · ") } : {}),
  };
}

/** @param {any} t */
export function taskSummary(t) {
  return {
    gid: t.gid,
    name: t.name,
    done: t.completed,
    due: t.due_at ?? t.due_on ?? undefined,
    assignee: t.assignee?.name,
    projects: t.projects?.map((/** @type {any} */ p) => p.name),
    ...taskStatus(t),
    link: t.permalink_url,
  };
}

/**
 * Start of a time window: "2d", "12h", "30m" ago, or a date/time.
 * @param {Ctx} ctx @param {string | undefined} since @returns {Date}
 */
function sinceDate(ctx, since = "1d") {
  const m = since.match(/^([0-9]+)([dhm])$/);
  if (m) return new Date(Date.now() - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[/** @type {"d"|"h"|"m"} */ (m[2])]);
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) ctx.fail(`--since: use 2d, 12h or a date, not "${since}"`);
  return d;
}

/** Story kinds worth surfacing, by Asana resource_subtype. */
const INBOX_KINDS = {
  comment_added: "comment",
  assigned: "assigned",
  due_date_changed: "due date",
  marked_complete: "completed",
  marked_incomplete: "reopened",
  attachment_added: "attachment",
  added_to_project: "added to project",
  collaborator_added: "added you",
  section_changed: "moved",
  enum_custom_field_changed: "status",
  mentioned: "mentioned",
  at_mention: "mentioned",
};

/**
 * Asana's Inbox is not in its public API, so rebuild it: tasks the person
 * follows that changed since `since`, with what other people did on them.
 * @param {Ctx} ctx @param {Date} since @param {number} limit max tasks returned
 */
async function inbox(ctx, since, limit) {
  const me = await asana(ctx, "GET", "/users/me", { query: { opt_fields: "gid,name" } });
  const ws = await workspace(ctx);
  // Search has no offset paging: walk back in time with modified_at.before.
  /** @type {any[]} */
  const tasks = [];
  let before;
  for (let round = 0; round < 5; round++) {
    const page = await asana(ctx, "GET", `/workspaces/${ws}/tasks/search`, {
      query: {
        "followers.any": "me",
        "modified_at.after": since.toISOString(),
        "modified_at.before": before,
        sort_by: "modified_at",
        opt_fields: TASK_FIELDS,
        limit: 100,
      },
    });
    tasks.push(...page.filter((/** @type {any} */ t) => !tasks.some((x) => x.gid === t.gid)));
    if (page.length < 100) break;
    before = page[page.length - 1].modified_at;
  }
  /** @type {any[]} */
  const out = [];
  // A few tasks at a time keeps under Asana's rate limit.
  for (let i = 0; i < tasks.length; i += 5) {
    const batch = tasks.slice(i, i + 5);
    const stories = await Promise.all(
      batch.map((t) =>
        asanaAll(ctx, `/tasks/${t.gid}/stories`, {
          opt_fields: "type,resource_subtype,text,html_text,created_by.gid,created_by.name,created_at,assignee.gid,assignee.name",
        }),
      ),
    );
    batch.forEach((t, j) => {
      const events = stories[j]
        .filter((st) => new Date(st.created_at) >= since && st.created_by?.gid !== me.gid && st.resource_subtype in INBOX_KINDS)
        .filter((st) => st.resource_subtype !== "assigned" || st.assignee?.gid === me.gid)
        // Only status-like fields: other dropdowns (Priority, Area…) are noise here.
        .filter((st) => st.resource_subtype !== "enum_custom_field_changed" || /status/i.test(st.text ?? ""))
        .map((st) => ({
          at: st.created_at,
          by: st.created_by?.name ?? "Asana",
          kind: INBOX_KINDS[/** @type {keyof typeof INBOX_KINDS} */ (st.resource_subtype)],
          ...(st.type === "comment" ? { text: st.text } : { what: st.text }),
          ...(String(st.html_text ?? "").includes(`data-asana-gid="${me.gid}"`) ? { mentionsYou: true } : {}),
        }));
      if (events.length) out.push({ ...taskSummary(t), events, latest: events[events.length - 1].at });
    });
  }
  out.sort((a, b) => b.latest.localeCompare(a.latest));
  return {
    since: since.toISOString(),
    tasksChecked: tasks.length,
    mentions: out.reduce((n, t) => n + t.events.filter((/** @type {any} */ e) => e.mentionsYou).length, 0),
    tasks: out.slice(0, limit),
    ...(out.length > limit ? { more: out.length - limit } : {}),
  };
}

/** @param {Ctx} ctx */
function gid(ctx) {
  const g = ctx.words[0];
  if (!g || !/^[0-9]{6,}$/.test(g)) ctx.fail("needs a task gid (the number in the task's link)");
  return g;
}

/** @param {Ctx} ctx @param {boolean} completed */
async function setCompleted(ctx, completed) {
  const task = await asana(ctx, "PUT", `/tasks/${gid(ctx)}`, { data: { completed }, query: { opt_fields: TASK_FIELDS } });
  return taskSummary(task);
}

export default {
  /** Flags that never take a value. */
  booleans: ["all"],
  help: [
    "Read:",
    "  asana me                                         who the token belongs to, workspaces",
    "  asana tasks [--project <gid|name>] [--assignee me|<email>] [--all]",
    "                                                   open tasks (default: mine); --all includes completed",
    "  asana task <gid>                                 one task with its notes, subtasks and comments",
    "  asana search <text> [--limit 20]                 tasks matching text in the workspace",
    "  asana projects [--search text]",
    "  asana inbox [--since 1d|12h|YYYY-MM-DD] [--limit 30]",
    "                                                   what others did on tasks you follow: comments",
    "                                                   (@mentions flagged), assignments, due dates, completions,",
    "                                                   section moves, status changes, mentions from other tasks",
    "Change (each one waits for an approval card):",
    '  asana comment <gid> --text "..."',
    '  asana create --name "..." [--project <gid|name>] [--assignee me|<email>] [--due YYYY-MM-DD] [--notes "..."]',
    '  asana update <gid> [--name ...] [--due YYYY-MM-DD] [--assignee me|<email>] [--notes "..."]',
    "  asana complete <gid>",
    "  asana reopen <gid>",
  ],
  commands: {
    /** @param {Ctx} ctx */
    async me(ctx) {
      const me = await asana(ctx, "GET", "/users/me", { query: { opt_fields: "name,email,workspaces.name" } });
      return { name: me.name, email: me.email, workspaces: me.workspaces, using: await workspace(ctx) };
    },
    /** @param {Ctx} ctx */
    async tasks(ctx) {
      const project = ctx.flag("project");
      const query = project
        ? { project: await projectId(ctx, project) }
        : { assignee: ctx.flag("assignee") ?? "me", workspace: await workspace(ctx) };
      const list = await asanaAll(ctx, "/tasks", { ...query, completed_since: ctx.flags.all ? undefined : "now", opt_fields: TASK_FIELDS }, 500);
      return list.map(taskSummary);
    },
    /** @param {Ctx} ctx */
    async task(ctx) {
      const g = gid(ctx);
      const [task, subtasks, stories] = await Promise.all([
        asana(ctx, "GET", `/tasks/${g}`, { query: { opt_fields: `${TASK_FIELDS},notes` } }),
        asana(ctx, "GET", `/tasks/${g}/subtasks`, { query: { opt_fields: "name,completed" } }),
        asana(ctx, "GET", `/tasks/${g}/stories`, { query: { opt_fields: "type,text,created_by.name,created_at" } }),
      ]);
      return {
        ...taskSummary(task),
        notes: task.notes,
        subtasks: subtasks.map((/** @type {any} */ s) => ({ gid: s.gid, name: s.name, done: s.completed })),
        comments: stories
          .filter((/** @type {any} */ s) => s.type === "comment")
          .map((/** @type {any} */ s) => ({ by: s.created_by?.name, at: s.created_at, text: s.text })),
      };
    },
    /** @param {Ctx} ctx */
    async search(ctx) {
      const text = ctx.words.join(" ") || ctx.flag("text");
      if (!text) ctx.fail("search needs text");
      const list = await asana(ctx, "GET", `/workspaces/${await workspace(ctx)}/tasks/search`, {
        query: { text, opt_fields: TASK_FIELDS, limit: Math.min(Number(ctx.flag("limit") ?? 20) || 20, 100), sort_by: "modified_at" },
      });
      return list.map(taskSummary);
    },
    /** @param {Ctx} ctx */
    async projects(ctx) {
      const list = await asanaAll(ctx, "/projects", { workspace: await workspace(ctx), archived: false, opt_fields: "name,permalink_url" });
      const q = ctx.flag("search")?.toLowerCase();
      return list.filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => ({ gid: p.gid, name: p.name, link: p.permalink_url }));
    },
    /** @param {Ctx} ctx */
    async inbox(ctx) {
      return inbox(ctx, sinceDate(ctx, ctx.flag("since")), Math.min(Number(ctx.flag("limit") ?? 30) || 30, 200));
    },
    /** @param {Ctx} ctx */
    async comment(ctx) {
      const g = gid(ctx);
      const text = ctx.flag("text");
      if (!text) ctx.fail("comment needs --text");
      const story = await asana(ctx, "POST", `/tasks/${g}/stories`, { data: { text } });
      return { commented: true, task: g, id: story.gid };
    },
    /** @param {Ctx} ctx */
    async create(ctx) {
      const name = ctx.flag("name");
      if (!name) ctx.fail("create needs --name");
      const project = ctx.flag("project");
      const data = {
        name,
        notes: ctx.flag("notes"),
        due_on: ctx.flag("due"),
        assignee: ctx.flag("assignee") ?? (project ? undefined : "me"),
        ...(project ? { projects: [await projectId(ctx, project)] } : { workspace: await workspace(ctx) }),
      };
      const task = await asana(ctx, "POST", "/tasks", { data, query: { opt_fields: TASK_FIELDS } });
      return { created: true, ...taskSummary(task) };
    },
    /** @param {Ctx} ctx */
    async update(ctx) {
      const g = gid(ctx);
      const data = Object.fromEntries(
        [
          ["name", ctx.flag("name")],
          ["notes", ctx.flag("notes")],
          ["due_on", ctx.flag("due")],
          ["assignee", ctx.flag("assignee")],
        ].filter(([, v]) => v !== undefined),
      );
      if (!Object.keys(data).length) ctx.fail("update needs at least one of --name, --notes, --due, --assignee");
      const task = await asana(ctx, "PUT", `/tasks/${g}`, { data, query: { opt_fields: TASK_FIELDS } });
      return { updated: true, ...taskSummary(task) };
    },
    /** @param {Ctx} ctx */
    complete: (ctx) => setCompleted(ctx, true),
    /** @param {Ctx} ctx */
    reopen: (ctx) => setCompleted(ctx, false),
  },
};
