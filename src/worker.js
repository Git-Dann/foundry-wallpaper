// Foundry Wallpaper: a live desktop wallpaper for Plash.
//
// Routes (every one needs ?k=<PAGE_KEY> except the OAuth callback, which checks a one-time state):
//   GET /                 the wallpaper page
//   GET /api/data         calendar, Gmail, Foundry commitments and monitors, as JSON
//   GET /connect          start the one-time Google sign-in (calendar + Gmail, read-only)
//   GET /oauth/callback   Google sends you back here; stores the refresh token in KV
//   GET /connect-slack    start the one-time Slack sign-in (search, read-only)
//   GET /oauth/slack      Slack sends you back here; stores the user token in KV
//   GET /controller       add a task to your week, or tick one off (writes to Foundry Commitments)
//   POST /api/tasks       add one   ·   POST /api/tasks/done   tick one off
//   GET /api/stamp        changes whenever something is written, so pages refresh at once
//   GET /asks             everything people have asked of you, with deadlines
//   PUT /api/asks         the drafter reports asks it found   ·   POST /api/asks/decide  done / dismiss / add to week
//   PUT /api/usage        the Mac reports Claude and Codex plan usage (percent used, reset times)
//
// Secrets (Cloudflare → Workers → foundry-wallpaper → Settings → Variables and secrets):
//   PAGE_KEY              the long random string in your wallpaper link
//   GOOGLE_CLIENT_ID      a Google OAuth "Web application" client
//   GOOGLE_CLIENT_SECRET
//   FOUNDRY_API_KEY       optional; Foundry → Settings → Developer → API keys
//   SLACK_USER_TOKEN      the xoxp- User token of a Slack app with user scopes search:read, users:read
//   (or SLACK_CLIENT_ID + SLACK_CLIENT_SECRET to sign in through /connect-slack instead)
// Vars: FOUNDRY_URL (default https://foundry.gitwork.co.uk)
// KV binding: STORE
//
// Nothing here ever writes to Google or Foundry. Each source fails on its own and says so:
// a source we couldn't read is reported as unavailable, never as "nothing there".

import PAGE_HTML from "./page.html";
import CONTROLLER_HTML from "./controller.html";
import ASKS_HTML from "./asks.html";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];
const CACHE_TTL = 60; // seconds; KV's minimum
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/oauth/callback") return await oauthCallback(url, env);
      if (url.pathname === "/oauth/slack") return await slackCallback(url, env);
      if (!keyOk(url.searchParams.get("k"), env.PAGE_KEY)) return text("Not found", 404);

      if (url.pathname === "/") return html(PAGE_HTML);
      if (url.pathname === "/api/data") return json(await loadAll(env, ctx, url.searchParams.get("fresh") === "1"));
      if (url.pathname === "/connect") return await startOauth(url, env);
      if (url.pathname === "/connect-slack") return await startSlack(url, env);
      if (url.pathname === "/controller") return html(CONTROLLER_HTML);
      if (url.pathname === "/asks") return html(ASKS_HTML);
      if (url.pathname === "/api/asks" && req.method === "PUT") return await putAsks(req, env);
      if (url.pathname === "/api/asks/decide" && req.method === "POST") return await decideAsk(req, env);
      if (url.pathname === "/api/stamp") return json({ stamp: (await env.STORE.get("stamp")) ?? "0" });
      if (url.pathname === "/api/usage" && req.method === "PUT") return await putUsage(req, env);
      if (url.pathname === "/api/tasks" && req.method === "POST") return await addTask(req, env);
      if (url.pathname === "/api/tasks/done" && req.method === "POST") return await doneTask(req, env);
      return text("Not found", 404);
    } catch (err) {
      return json({ error: "Something went wrong", detail: String(err?.message ?? err).slice(0, 200) }, 500);
    }
  },
};

// ---------- auth ----------

function keyOk(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function redirectUri(url) {
  return `${url.origin}/oauth/callback`;
}

async function startOauth(url, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return text("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as secrets first (see README).", 400);
  }
  const state = crypto.randomUUID();
  await env.STORE.put(`oauth-state:${state}`, "1", { expirationTtl: 600 });
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(url),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return Response.redirect(auth.toString(), 302);
}

async function oauthCallback(url, env) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || !(await env.STORE.get(`oauth-state:${state}`))) return text("This sign-in link has expired. Start again from /connect.", 400);
  await env.STORE.delete(`oauth-state:${state}`);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(url),
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) {
    return text(`Google didn't return a refresh token (${body.error ?? res.status}). Try /connect again.`, 400);
  }
  await env.STORE.put("google:refresh", body.refresh_token);
  await env.STORE.delete("data:cache");
  return html(`<!doctype html><meta charset="utf-8"><title>Connected</title>
<body style="font:16px system-ui;background:#0b1020;color:#e6e9f5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:600">Google connected</h1>
<p>Calendar and Gmail are read-only. You can close this tab; the wallpaper picks it up within a minute.</p></div></body>`);
}

async function googleToken(env) {
  const refresh = await env.STORE.get("google:refresh");
  if (!refresh) return { ok: false, reason: "not_connected" };
  const cached = await env.STORE.get("google:access", "json");
  if (cached && cached.exp > Date.now() + 60_000) return { ok: true, token: cached.token };

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: body.error === "invalid_grant" ? "reconnect" : "google_error" };
  const exp = Date.now() + (body.expires_in ?? 3600) * 1000;
  await env.STORE.put("google:access", JSON.stringify({ token: body.access_token, exp }), { expirationTtl: 3500 });
  return { ok: true, token: body.access_token };
}

// ---------- data ----------

async function loadAll(env, ctx, fresh) {
  if (!fresh) {
    const cached = await env.STORE.get("data:cache", "json");
    if (cached) return cached;
  }
  const g = await googleToken(env);
  const [calendar, mail, commitments, monitors, slack, usage, asks] = await Promise.all([
    settle(() => (g.ok ? readCalendar(g.token) : Promise.reject(new SourceError(g.reason)))),
    settle(() => (g.ok ? readGmail(g.token) : Promise.reject(new SourceError(g.reason)))),
    settle(() => readCommitments(env)),
    settle(() => readMonitors(env)),
    settle(() => readSlack(env)),
    settle(() => readUsage(env)),
    settle(() => readAsks(env)),
  ]);
  const data = { readAt: new Date().toISOString(), calendar, mail, commitments, monitors, slack, usage, asks };
  ctx.waitUntil(env.STORE.put("data:cache", JSON.stringify(data), { expirationTtl: CACHE_TTL }));
  return data;
}

class SourceError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function settle(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, reason: err instanceof SourceError ? err.reason : "error", detail: String(err?.message ?? err).slice(0, 160) };
  }
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 401 || res.status === 403) throw new SourceError("no_access");
  if (!res.ok) throw new SourceError(`http_${res.status}`);
  return res.json();
}

async function readCalendar(token) {
  // Today through the next 7 days (the dial uses today; the week card uses all of it). The page
  // picks the days in local time.
  const now = Date.now();
  const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  u.search = new URLSearchParams({
    timeMin: new Date(now - 5 * 86_400_000).toISOString(), // back to this week's Monday
    timeMax: new Date(now + 8 * 86_400_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  }).toString();
  const body = await getJson(u, { authorization: `Bearer ${token}` });
  const events = (body.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .filter((e) => !(e.attendees ?? []).some((a) => a.self && a.responseStatus === "declined"))
    .map((e) => {
      const attendees = e.attendees ?? [];
      const selfDomain = (attendees.find((a) => a.self)?.email ?? "").split("@")[1] ?? "";
      const external = attendees.some((a) => a.email && !a.resource && selfDomain && !a.email.endsWith(`@${selfDomain}`));
      return {
        id: e.id,
        title: e.summary ?? "(No title)",
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        allDay: Boolean(e.start?.date && !e.start?.dateTime),
        meet: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null,
        people: attendees.filter((a) => !a.resource).length,
        external,
        location: e.location ?? null,
      };
    });
  return { events };
}

async function readGmail(token) {
  const h = { authorization: `Bearer ${token}` };
  const [inbox, list] = await Promise.all([
    getJson("https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX", h),
    getJson(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=7&q=" + encodeURIComponent("in:inbox is:unread category:primary"),
      h,
    ),
  ]);
  const ids = (list.messages ?? []).map((m) => m.id);
  const messages = await Promise.all(
    ids.map(async (id) => {
      const m = await getJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        h,
      );
      const header = (name) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
      const from = parseFrom(header("from"));
      return {
        id,
        threadId: m.threadId,
        from: from.name,
        domain: from.domain,
        subject: header("subject") || "(No subject)",
        at: new Date(Number(m.internalDate)).toISOString(),
      };
    }),
  );
  return {
    unread: inbox.messagesUnread ?? 0,
    primaryUnread: list.resultSizeEstimate ?? messages.length,
    messages,
  };
}

function parseFrom(raw) {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const email = (m ? m[2] : raw).trim();
  const name = (m && m[1].trim()) || email.split("@")[0];
  return { name, domain: email.split("@")[1] ?? "" };
}

function foundryHeaders(env) {
  if (!env.FOUNDRY_API_KEY) throw new SourceError("not_configured");
  return { authorization: `Bearer ${env.FOUNDRY_API_KEY}`, accept: "application/json" };
}

function foundryBase(env) {
  return (env.FOUNDRY_URL || "https://foundry.gitwork.co.uk").replace(/\/$/, "");
}

// Foundry's repeat rules (src/lib/commitments.ts there): one open commitment carries the next date;
// completing it creates the following one. Here we only project forward to draw the week.
function nextOccurrence(rule, from) {
  const d = new Date(from);
  const days = (n) => new Date(d.getTime() + n * 86_400_000);
  const months = (n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
  switch (rule) {
    case "daily": return days(1);
    case "weekdays": { let x = days(1); while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x = new Date(x.getTime() + 86_400_000); return x; }
    case "weekly": return days(7);
    case "fortnightly": return days(14);
    case "monthly": return months(1);
    case "yearly": return months(12);
  }
  const m = /^every:(\d+):(day|week|month)$/.exec(rule ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "day" ? days(n) : m[2] === "week" ? days(n * 7) : months(n);
}

// Monday 00:00 UTC of the working week to show: this week, or next week at the weekend.
function workWeekStart(now) {
  const d = new Date(now); d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  const back = dow === 0 ? -1 : dow === 6 ? -2 : dow - 1; // weekend → next Monday
  return new Date(d.getTime() - back * 86_400_000);
}

// Every dated open commitment in this Mon–Fri, with repeating ones expanded onto each day.
// A one-off that's already past and not done is "late" and shows once, on today.
// `overlay` holds repeats the wallpaper remembers itself, for when Foundry can't store them yet.
function weekSchedule(commitments, now, overlay = {}) {
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  const start = workWeekStart(now).getTime() - 86_400_000; // a day of slack for time zones
  const end = workWeekStart(now).getTime() + 6 * 86_400_000;
  const out = [];
  for (const c of commitments) {
    if (c.state !== "open" || c.someday) continue;
    const anchor = c.dueAt ?? c.startAt;
    if (!anchor) continue;
    const rule = c.recurrence ?? overlay[c.id] ?? null;
    const base = { id: c.id, title: c.title, counterpart: c.counterpart ?? null, recurring: Boolean(rule), rule, overlay: !c.recurrence && Boolean(overlay[c.id]) };
    let at = new Date(anchor);
    if (!rule) {
      if (at.getTime() < today.getTime()) out.push({ ...base, at: at.toISOString(), late: true });
      else if (at.getTime() < end) out.push({ ...base, at: at.toISOString(), late: false });
      continue;
    }
    // A repeating one that's behind: say so once, then show its dates this week as normal.
    if (at.getTime() < Math.min(start, today.getTime() - 86_400_000)) out.push({ ...base, at: at.toISOString(), late: true });
    for (let i = 0; i < 800 && at.getTime() < start; i++) { const n = nextOccurrence(rule, at); if (!n) break; at = n; }
    for (let i = 0; i < 40 && at.getTime() < end; i++) {
      out.push({ ...base, at: at.toISOString(), late: false });
      const n = nextOccurrence(rule, at);
      if (!n) break;
      at = n;
    }
  }
  return { weekStart: workWeekStart(now).toISOString(), items: out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, 120) };
}

async function readCommitments(env) {
  const body = await getJson(`${foundryBase(env)}/api/backstage/commitments`, foundryHeaders(env));
  const all = body.commitments ?? [];
  const overlay = (await env.STORE.get("repeat:overlay", "json")) ?? {};
  const now = Date.now();
  const open = all.filter(
    (c) => c.state === "open" && !c.someday && !(c.snoozedUntil && Date.parse(c.snoozedUntil) > now),
  );
  const items = open
    .map((c) => ({ id: c.id, title: c.title, dueAt: c.dueAt, counterpart: c.counterpart, priority: c.priority ?? 0, recurring: Boolean(c.recurrence ?? overlay[c.id]) }))
    .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || b.priority - a.priority);
  return {
    open: open.length,
    overdue: items.filter((c) => c.dueAt && Date.parse(c.dueAt) < now).length,
    suggested: all.filter((c) => c.state === "suggested").length,
    items: items.slice(0, 6),
    week: weekSchedule(open, now, overlay),
  };
}

async function readMonitors(env) {
  const body = await getJson(`${foundryBase(env)}/api/monitors`, foundryHeaders(env));
  const services = [];
  for (const client of body.clients ?? []) {
    for (const m of client.monitors ?? []) {
      if (m.environment && m.environment !== "production") continue;
      const state = m.stale ? "stale" : m.status === "DOWN" ? "down" : m.alertKind === "flaky" ? "flaky" : m.status === "DEGRADED" ? "slow" : m.status === "UP" ? "up" : "unknown";
      services.push({ client: client.name, name: m.name, state });
    }
  }
  const count = (s) => services.filter((x) => x.state === s).length;
  return {
    total: services.length,
    up: count("up"),
    down: services.filter((x) => x.state === "down"),
    trouble: services.filter((x) => ["flaky", "slow", "stale"].includes(x.state)),
    // One dot per service, for the constellation; names only where something's wrong.
    dots: services.map((s) => s.state),
    incidents: (body.incidents ?? []).length,
  };
}

// ---------- Slack ----------

const SLACK_USER_SCOPES = ["search:read", "users:read"];

async function startSlack(url, env) {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return text("Add SLACK_CLIENT_ID and SLACK_CLIENT_SECRET as secrets first (see README).", 400);
  }
  const state = crypto.randomUUID();
  await env.STORE.put(`oauth-state:${state}`, "slack", { expirationTtl: 600 });
  const auth = new URL("https://slack.com/oauth/v2/authorize");
  auth.search = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    user_scope: SLACK_USER_SCOPES.join(","),
    redirect_uri: `${url.origin}/oauth/slack`,
    state,
  }).toString();
  return Response.redirect(auth.toString(), 302);
}

async function slackCallback(url, env) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || (await env.STORE.get(`oauth-state:${state}`)) !== "slack") return text("This sign-in link has expired. Start again from /connect-slack.", 400);
  await env.STORE.delete(`oauth-state:${state}`);
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.SLACK_CLIENT_ID, client_secret: env.SLACK_CLIENT_SECRET, redirect_uri: `${url.origin}/oauth/slack` }),
  });
  const body = await res.json();
  const token = body.authed_user?.access_token;
  if (!body.ok || !token) return text(`Slack didn't return a user token (${body.error ?? res.status}). Try /connect-slack again.`, 400);
  await env.STORE.put("slack:token", token);
  await env.STORE.put("slack:user", body.authed_user.id);
  await env.STORE.delete("data:cache");
  return html(`<!doctype html><meta charset="utf-8"><title>Connected</title>
<body style="font:16px system-ui;background:#0b1020;color:#e6e9f5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:600">Slack connected</h1>
<p>Read-only search of your mentions and DMs. You can close this tab.</p></div></body>`);
}

async function slackApi(token, method, params) {
  const u = new URL(`https://slack.com/api/${method}`);
  u.search = new URLSearchParams(params).toString();
  const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new SourceError("rate_limited");
  const body = await res.json();
  if (!body.ok) {
    if (["invalid_auth", "token_revoked", "account_inactive", "not_authed"].includes(body.error)) throw new SourceError("reconnect_slack");
    if (body.error === "missing_scope") throw new SourceError("no_access");
    throw new SourceError(`slack_${body.error}`);
  }
  return body;
}

async function slackName(env, token, id) {
  if (!id) return "Someone";
  const key = `slack:name:${id}`;
  const cached = await env.STORE.get(key);
  if (cached) return cached;
  try {
    const u = (await slackApi(token, "users.info", { user: id })).user;
    const name = u?.profile?.display_name || u?.real_name || u?.name || "Someone";
    await env.STORE.put(key, name, { expirationTtl: 86_400 });
    return name;
  } catch {
    return "Someone";
  }
}

// Slack's own message markup into plain words: <@U1> → @name, <#C1|general> → #general, links → their label.
async function plainSlack(env, token, raw) {
  let s = String(raw ?? "");
  const ids = [...new Set([...s.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))].slice(0, 6);
  for (const id of ids) s = s.split(new RegExp(`<@${id}(?:\\|[^>]*)?>`)).join("@" + (await slackName(env, token, id)));
  s = s
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 180 ? s.slice(0, 177) + "…" : s;
}

// A User token pasted in as a secret wins; otherwise the one from /connect-slack.
async function slackIdentity(env) {
  if (env.SLACK_USER_TOKEN) {
    let me = await env.STORE.get("slack:user:env");
    if (!me) {
      me = (await slackApi(env.SLACK_USER_TOKEN, "auth.test", {})).user_id;
      await env.STORE.put("slack:user:env", me, { expirationTtl: 86_400 });
    }
    return { token: env.SLACK_USER_TOKEN, me };
  }
  const token = await env.STORE.get("slack:token");
  if (!token) throw new SourceError("not_connected_slack");
  return { token, me: await env.STORE.get("slack:user") };
}

async function readSlack(env) {
  const { token, me } = await slackIdentity(env);
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  // Slack's search, as you'd type it in the app: anything mentioning you, and DMs sent to you.
  const [mentions, dms] = await Promise.all([
    slackApi(token, "search.messages", { query: `<@${me}> after:${since}`, sort: "timestamp", sort_dir: "desc", count: "12" }),
    slackApi(token, "search.messages", { query: `to:me after:${since}`, sort: "timestamp", sort_dir: "desc", count: "12" }),
  ]);
  const seen = new Set();
  const items = [];
  for (const [kind, res] of [["mention", mentions], ["dm", dms]]) {
    for (const m of res.messages?.matches ?? []) {
      if (m.user === me) continue;
      const id = `${m.channel?.id}:${m.ts}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ m, kind, id });
    }
  }
  items.sort((a, b) => Number(b.m.ts) - Number(a.m.ts));
  const top = items.slice(0, 8);
  const out = await Promise.all(
    top.map(async ({ m, kind, id }) => ({
      id,
      kind,
      from: m.user ? await slackName(env, token, m.user) : m.username || "Someone",
      fromId: m.user ?? null,
      channel: m.channel?.is_im || m.channel?.is_mpim ? null : m.channel?.name ?? null,
      text: await plainSlack(env, token, m.text),
      at: new Date(Number(m.ts) * 1000).toISOString(),
    })),
  );
  return {
    mentions: (mentions.messages?.matches ?? []).filter((m) => m.user !== me).length,
    dms: (dms.messages?.matches ?? []).filter((m) => m.user !== me).length,
    days: 3,
    items: out,
  };
}

// ---------- tasks (the controller page) ----------
//
// Tasks live in Foundry Commitments, so they're the same list Foundry and the Mac app see.
// Production Foundry can't store a repeat yet (its deploys are stuck), so a repeat it rejects is
// remembered here in "repeat:overlay" and the wallpaper expands it itself. Ticking off an
// overlay-repeating task moves its date on instead of closing it.

const REPEATS = ["daily", "weekdays", "weekly", "fortnightly", "monthly", "yearly"];

async function changed(env) {
  await env.STORE.put("stamp", String(Date.now()));
  await env.STORE.delete("data:cache");
}

// "2026-11-13" + "10:00" in UK time → an ISO instant (handles GMT/BST).
function ukInstant(day, time) {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = (time || "09:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
  const lh = Number(f.find((p) => p.type === "hour").value), lm = Number(f.find((p) => p.type === "minute").value);
  const drift = (lh * 60 + lm) - (hh * 60 + mm); // minutes London is ahead of UTC at that moment
  return new Date(guess - drift * 60_000).toISOString();
}

async function foundry(env, method, path, body) {
  const res = await fetch(`${foundryBase(env)}${path}`, {
    method,
    headers: { ...foundryHeaders(env), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function addTask(req, env) {
  const b = await req.json().catch(() => ({}));
  const title = clip(b?.title?.trim(), 200);
  if (!title) return json({ error: "Give the task a title." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b?.day ?? "")) return json({ error: "Pick a day." }, 400);
  if (b.time && !/^\d{2}:\d{2}$/.test(b.time)) return json({ error: "Time must look like 09:30." }, 400);
  const repeat = REPEATS.includes(b?.repeat) ? b.repeat : null;
  const created = await foundry(env, "POST", "/api/backstage/commitments", {
    title,
    notes: clip(b?.notes?.trim(), 2000) || null,
    counterpart: clip(b?.who?.trim(), 80) || null,
    dueAt: ukInstant(b.day, b.time),
  });
  if (!created.ok) return json({ error: created.data?.error || `Foundry said ${created.status}` }, 502);
  const c = created.data.commitment ?? created.data;
  let repeatStored = "none";
  if (repeat) {
    const set = await foundry(env, "PATCH", `/api/backstage/commitments/${c.id}`, { recurrence: repeat });
    if (set.ok) repeatStored = "foundry";
    else {
      const overlay = (await env.STORE.get("repeat:overlay", "json")) ?? {};
      overlay[c.id] = repeat;
      await env.STORE.put("repeat:overlay", JSON.stringify(overlay));
      repeatStored = "wallpaper";
    }
  }
  await changed(env);
  return json({ ok: true, id: c.id, repeatStored });
}

async function doneTask(req, env) {
  const { id } = await req.json().catch(() => ({}));
  if (!id) return json({ error: "Which task?" }, 400);
  const overlay = (await env.STORE.get("repeat:overlay", "json")) ?? {};
  if (overlay[id]) {
    // Foundry can't repeat it yet: move it on to its next date instead of closing it.
    const list = await foundry(env, "GET", "/api/backstage/commitments");
    const c = (list.data.commitments ?? []).find((x) => x.id === id);
    if (!c) return json({ error: "That task is no longer in Foundry." }, 404);
    let at = new Date(c.dueAt ?? Date.now());
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    do { at = nextOccurrence(overlay[id], at); } while (at && at.getTime() < today.getTime());
    const upd = await foundry(env, "PATCH", `/api/backstage/commitments/${id}`, { dueAt: at.toISOString() });
    if (!upd.ok) return json({ error: upd.data?.error || `Foundry said ${upd.status}` }, 502);
    await changed(env);
    return json({ ok: true, next: at.toISOString() });
  }
  const upd = await foundry(env, "PATCH", `/api/backstage/commitments/${id}`, { state: "done" });
  if (!upd.ok) return json({ error: upd.data?.error || `Foundry said ${upd.status}` }, 502);
  await changed(env);
  return json({ ok: true, next: upd.data?.next?.dueAt ?? null });
}

// ---------- asks: what people have asked of Dan ----------
//
// Found by the drafter (and the first manual pass) in Slack, Gmail and meeting notes. Each one
// carries the asker's own words, so it can be checked. States: open → done | dismissed | added
// ("added" = put in Foundry Commitments with its deadline). A decision is never undone by a
// later scan finding the same message again.

const ASKS_KEY = "asks:list";

function cleanAsk(a) {
  const due = typeof a?.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(a.due) ? a.due.slice(0, 10) : null;
  return {
    source: ["slack", "gmail", "meeting"].includes(a?.source) ? a.source : "gmail",
    from: clip(a?.from, 80),
    what: clip(a?.what, 160),
    due,
    dueText: clip(a?.dueText, 60),
    client: clip(a?.client, 60),
    ref: clip(a?.ref, 160),
    link: typeof a?.link === "string" && /^https:\/\//.test(a.link) ? a.link.slice(0, 500) : null,
    quote: clip(a?.quote, 300),
    askedAt: typeof a?.askedAt === "string" ? a.askedAt.slice(0, 40) : null,
  };
}

async function putAsks(req, env) {
  const body = await req.json().catch(() => null);
  const incoming = Array.isArray(body?.asks) ? body.asks.slice(0, 60).map(cleanAsk).filter((a) => a.from && a.what && a.ref && a.quote) : null;
  if (!incoming) return text('Expected { "asks": [...] }', 400);
  const v = (await env.STORE.get(ASKS_KEY, "json")) ?? { items: [] };
  const now = new Date().toISOString();
  let added = 0;
  for (const a of incoming) {
    const existing = v.items.find((x) => x.ref === a.ref);
    if (existing) { if (existing.state === "open") Object.assign(existing, a, { updatedAt: now }); continue; }
    v.items.push({ id: crypto.randomUUID(), state: "open", createdAt: now, updatedAt: now, ...a });
    added++;
  }
  v.checkedAt = now;
  // Keep closed ones a fortnight (so a rescan can't resurrect them), open ones until they're 30 days old.
  const cutoff = (d) => Date.now() - Date.parse(d.updatedAt) < (d.state === "open" ? 30 : 14) * 86_400_000;
  v.items = v.items.filter(cutoff).slice(-200);
  await env.STORE.put(ASKS_KEY, JSON.stringify(v));
  await changed(env);
  return json({ stored: incoming.length, added });
}

async function decideAsk(req, env) {
  const { id, action } = await req.json().catch(() => ({}));
  if (!["done", "dismiss", "reopen", "add"].includes(action)) return json({ error: "action must be done, dismiss, reopen or add" }, 400);
  const v = (await env.STORE.get(ASKS_KEY, "json")) ?? { items: [] };
  const a = v.items.find((x) => x.id === id);
  if (!a) return json({ error: "Not found" }, 404);
  if (action === "add") {
    // Put it in the week: a Foundry commitment due on its deadline (or today), 17:00 UK.
    const day = a.due ?? new Date().toISOString().slice(0, 10);
    const created = await foundry(env, "POST", "/api/backstage/commitments", {
      title: a.what,
      notes: `${a.from} asked (${a.source}): "${a.quote}"${a.link ? `\n${a.link}` : ""}`,
      counterpart: a.client || a.from,
      dueAt: ukInstant(day, "17:00"),
    });
    if (!created.ok) return json({ error: created.data?.error || `Foundry said ${created.status}` }, 502);
    a.commitmentId = (created.data.commitment ?? created.data).id;
  }
  a.state = action === "done" ? "done" : action === "dismiss" ? "dismissed" : action === "add" ? "added" : "open";
  a.updatedAt = new Date().toISOString();
  await env.STORE.put(ASKS_KEY, JSON.stringify(v));
  await changed(env);
  return json({ ok: true, state: a.state });
}

async function readAsks(env) {
  const v = await env.STORE.get(ASKS_KEY, "json");
  if (!v) throw new SourceError("not_set_up");
  return v;
}

// ---------- Claude and Codex usage ----------
//
// The Mac reports plan usage every 5 minutes (local/report-usage.sh): Claude's from the Claude Code
// status line, Codex's from its session logs. Only percentages and reset times are stored.

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
const USAGE_KEY = "usage";

function cleanWindow(w) {
  const pct = Number(w?.pct);
  if (!w || !Number.isFinite(pct) || pct < 0 || pct > 1000) return null;
  const resetsAt = Number(w.resetsAt);
  const minutes = Number(w.minutes);
  return {
    pct: Math.round(pct * 10) / 10,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 1e9 ? Math.round(resetsAt) : null, // epoch seconds
    minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null,
  };
}

function cleanTool(t) {
  if (!t || typeof t !== "object") return null;
  const at = Number(t.at);
  const fiveHour = cleanWindow(t.fiveHour);
  const week = cleanWindow(t.week);
  if (!fiveHour && !week) return null;
  return { at: Number.isFinite(at) && at > 1e9 ? Math.round(at) : null, fiveHour, week };
}

async function putUsage(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return text("Expected JSON", 400);
  const prev = (await env.STORE.get(USAGE_KEY, "json")) ?? {};
  // A tool missing from this report keeps its last good reading (shown with its own "as of").
  const next = { claude: cleanTool(body.claude) ?? prev.claude ?? null, codex: cleanTool(body.codex) ?? prev.codex ?? null, reportedAt: new Date().toISOString() };
  await env.STORE.put(USAGE_KEY, JSON.stringify(next));
  await env.STORE.delete("data:cache");
  return json({ ok: true, claude: !!next.claude, codex: !!next.codex });
}

async function readUsage(env) {
  const v = await env.STORE.get(USAGE_KEY, "json");
  if (!v) throw new SourceError("not_set_up");
  return v;
}

// ---------- responses ----------

function html(body) {
  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, "content-type": "application/json" } });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" } });
}
