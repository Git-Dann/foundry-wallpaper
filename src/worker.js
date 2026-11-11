// Foundry Wallpaper: a live desktop wallpaper for Plash.
//
// Routes (every one needs ?k=<PAGE_KEY> except the OAuth callback, which checks a one-time state):
//   GET /                 the wallpaper page
//   GET /api/data         calendar, Gmail, Foundry commitments and monitors, as JSON
//   GET /connect          start the one-time Google sign-in (calendar + Gmail, read-only)
//   GET /oauth/callback   Google sends you back here; stores the refresh token in KV
//   PUT /admin/page       replace the wallpaper design (body = page.html); `npm run publish-page`
//   GET /connect-slack    start the one-time Slack sign-in (search, read-only)
//   GET /oauth/slack      Slack sends you back here; stores the user token in KV
//   PUT /api/drafts       the local drafter (local/draft-replies.sh) reports what it drafted
//
// Secrets (Cloudflare → Workers → foundry-wallpaper → Settings → Variables and secrets):
//   PAGE_KEY              the long random string in your wallpaper link
//   GOOGLE_CLIENT_ID      a Google OAuth "Web application" client
//   GOOGLE_CLIENT_SECRET
//   FOUNDRY_API_KEY       optional; Foundry → Settings → Developer → API keys
//   SLACK_CLIENT_ID       a Slack app with user scopes search:read and users:read
//   SLACK_CLIENT_SECRET
// Vars: FOUNDRY_URL (default https://foundry.gitwork.co.uk)
// KV binding: STORE
//
// Nothing here ever writes to Google or Foundry. Each source fails on its own and says so:
// a source we couldn't read is reported as unavailable, never as "nothing there".


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

      if (url.pathname === "/admin/page" && req.method === "PUT") return await putPage(req, env);
      if (url.pathname === "/") return html((await env.STORE.get("page:html")) ?? "<p style=\"font:16px system-ui\">No design uploaded yet. Run npm run publish-page.</p>");
      if (url.pathname === "/api/data") return json(await loadAll(env, ctx, url.searchParams.get("fresh") === "1"));
      if (url.pathname === "/connect") return await startOauth(url, env);
      if (url.pathname === "/connect-slack") return await startSlack(url, env);
      if (url.pathname === "/api/drafts" && req.method === "PUT") return await putDrafts(req, env);
      return text("Not found", 404);
    } catch (err) {
      return json({ error: "Something went wrong", detail: String(err?.message ?? err).slice(0, 200) }, 500);
    }
  },
};

async function putPage(req, env) {
  const body = await req.text();
  if (!body.includes("<html") || body.length > 300_000) return text("Expected page.html under 300KB", 400);
  await env.STORE.put("page:html", body);
  return text(`Design updated (${body.length} chars)`);
}

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
  const [calendar, mail, commitments, monitors, slack, drafts] = await Promise.all([
    settle(() => (g.ok ? readCalendar(g.token) : Promise.reject(new SourceError(g.reason)))),
    settle(() => (g.ok ? readGmail(g.token) : Promise.reject(new SourceError(g.reason)))),
    settle(() => readCommitments(env)),
    settle(() => readMonitors(env)),
    settle(() => readSlack(env)),
    settle(() => readDrafts(env)),
  ]);
  const data = { readAt: new Date().toISOString(), calendar, mail, commitments, monitors, slack, drafts };
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
  // A window wide enough for "today" and "tomorrow" in any UK/EU/Asia time zone; the page
  // picks the days in local time.
  const now = Date.now();
  const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  u.search = new URLSearchParams({
    timeMin: new Date(now - 20 * 3600_000).toISOString(),
    timeMax: new Date(now + 52 * 3600_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "60",
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

async function readCommitments(env) {
  const body = await getJson(`${foundryBase(env)}/api/backstage/commitments`, foundryHeaders(env));
  const now = Date.now();
  const open = (body.commitments ?? []).filter(
    (c) => c.state === "open" && !c.someday && !(c.snoozedUntil && Date.parse(c.snoozedUntil) > now),
  );
  const items = open
    .map((c) => ({ id: c.id, title: c.title, dueAt: c.dueAt, counterpart: c.counterpart, priority: c.priority ?? 0 }))
    .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || b.priority - a.priority);
  return {
    open: open.length,
    overdue: items.filter((c) => c.dueAt && Date.parse(c.dueAt) < now).length,
    suggested: (body.commitments ?? []).filter((c) => c.state === "suggested").length,
    items: items.slice(0, 6),
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

async function readSlack(env) {
  const token = await env.STORE.get("slack:token");
  if (!token) throw new SourceError("not_connected_slack");
  const me = await env.STORE.get("slack:user");
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

// ---------- drafts (written by the local drafter on your Mac) ----------

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);

async function putDrafts(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return text("Expected JSON", 400);
  }
  const list = Array.isArray(body?.drafts) ? body.drafts.slice(0, 25) : null;
  if (!list) return text('Expected { "drafts": [...] }', 400);
  const drafts = list
    .map((d) => ({
      source: d?.source === "slack" ? "slack" : "gmail",
      to: clip(d?.to, 80),
      about: clip(d?.about, 160),
      client: clip(d?.client, 60),
      ref: clip(d?.ref, 120), // Gmail thread id or Slack channel:ts, to mark the inbox row
      urgency: ["high", "normal", "low"].includes(d?.urgency) ? d.urgency : "normal",
    }))
    .filter((d) => d.to && d.about);
  const skipped = Array.isArray(body?.skipped) ? body.skipped.length : 0;
  await env.STORE.put("drafts:latest", JSON.stringify({ generatedAt: new Date().toISOString(), drafts, skipped }));
  await env.STORE.delete("data:cache");
  return json({ stored: drafts.length });
}

async function readDrafts(env) {
  const v = await env.STORE.get("drafts:latest", "json");
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
