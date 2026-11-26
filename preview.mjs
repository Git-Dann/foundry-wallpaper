// Local preview of src/page.html that reloads itself when you save.
//
//   npm run preview                    made-up data            → http://localhost:8788
//   npm run preview:live               your real data (reads the live wallpaper's /api/data,
//                                      using the link in ~/.foundry-drafter/env or $WALLPAPER)
//
// Nothing here is deployed; it only serves your local copy of the design.
import { createServer } from "node:http";
import { readFileSync, watch, existsSync } from "node:fs";
import { homedir } from "node:os";
const at = (h, m, day = 0) => { const d = new Date(); d.setDate(d.getDate() + day); d.setHours(h, m, 0, 0); return d.toISOString(); };
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
const sample = () => ({
  readAt: new Date().toISOString(),
  calendar: { ok: true, events: [
    { title: "Standup", start: at(9, 30), end: at(9, 45), allDay: false, people: 6, external: false, meet: "x" },
    { title: "Fellas Loaded · release review", start: at(11, 0), end: at(12, 0), allDay: false, people: 4, external: true, meet: "x" },
    { title: "Lunch", start: at(12, 30), end: at(13, 15), allDay: false, people: 1, external: false },
    { title: "Big Wedge weekly", start: at(14, 30), end: at(15, 15), allDay: false, people: 5, external: true, meet: "x" },
    { title: "Proposal: Valu discovery", start: at(16, 0), end: at(17, 0), allDay: false, people: 3, external: true, meet: "x" },
    { title: "Gym", start: at(18, 30), end: at(19, 30), allDay: false, people: 1, external: false },
    { title: "Harry 1:1", start: at(10, 0, 1), end: at(10, 30, 1), allDay: false, people: 2, external: false },
    { title: "PollenIQ firmware handover", start: at(13, 0, 1), end: at(14, 30, 1), allDay: false, people: 4, external: true },
  ] },
  mail: { ok: true, unread: 23, primaryUnread: 6, messages: [
    { threadId: "t1", from: "Luke McFarland", domain: "bigwedge.golf", subject: "Re: iOS 3.4 approval and the new course feed", at: ago(4) },
    { from: "Sarah Chen", domain: "valu.io", subject: "Discovery call notes + next steps", at: ago(38) },
    { from: "Google Cloud", domain: "google.com", subject: "Your invoice for October", at: ago(95) },
    { from: "Waqar", domain: "gitwork.co.uk", subject: "Fellas Android build ready for review", at: ago(180) },
    { from: "Coachman", domain: "coachman.co.uk", subject: "Caravan configurator: phase 2 scope", at: ago(400) },
  ] },
  commitments: { ok: true, open: 7, overdue: 1, suggested: 2, week: { items: [
    { id: "w0", title: "Send Valu the revised proposal", at: ago(60 * 20), late: true, recurring: false },
    { id: "w1", title: "Timesheets", at: at(17, 0), recurring: true, rule: "weekdays" },
    { id: "w2", title: "Timesheets", at: at(17, 0, 1), recurring: true, rule: "weekdays" },
    { id: "w3", title: "Send GAIA weekly update", at: at(10, 0, 2), recurring: true, rule: "weekly", counterpart: "GAIA" },
    { id: "w4", title: "Send Campfire weekly update", at: at(10, 30, 2), recurring: true, rule: "weekly", counterpart: "Campfire" },
    { id: "w5", title: "Timesheets", at: at(17, 0, 2), recurring: true, rule: "weekdays" },
    { id: "w6", title: "Review Coachman phase 2", at: at(12, 0, 5), recurring: false },
    { id: "w7", title: "Timesheets", at: at(17, 0, 5), recurring: true, rule: "weekdays" },
    { id: "w8", title: "Invoices", at: at(9, 0, 6), recurring: true, rule: "monthly" },
  ] }, items: [
    { title: "Send Valu the revised proposal", dueAt: ago(60 * 20), counterpart: "Valu" },
    { title: "Reply to Luke on the course feed outage", dueAt: at(17, 0), counterpart: "Big Wedge" },
    { title: "Review Coachman phase 2 estimate", dueAt: at(12, 0, 2), counterpart: "Coachman" },
  ] },
  slack: { ok: true, mentions: 3, dms: 2, days: 3, items: [
    { id: "C1:1", kind: "mention", from: "Harry Brown", fromId: "U1", channel: "fellas-loaded", text: "@Dan can you sign off the 3.4 release notes before 2?", at: ago(12) },
    { id: "D1:2", kind: "dm", from: "Syed", fromId: "U2", channel: null, text: "Coachman want to move Thursday's call to Friday, ok?", at: ago(55) },
    { id: "C2:3", kind: "mention", from: "Waqar", fromId: "U3", channel: "wedge-dev", text: "@Dan course feed is back, catching up 41 requests", at: ago(130) },
  ] },
  usage: { ok: true, reportedAt: ago(2),
    claude: { at: Math.floor(Date.now() / 1000) - 120, fiveHour: { pct: 34.2, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 + 900 }, week: { pct: 12, resetsAt: Math.floor(Date.now() / 1000) + 4 * 86400 } },
    codex: { at: Math.floor(Date.now() / 1000) - 3600, fiveHour: { pct: 81, minutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 40 * 60 }, week: { pct: 21, minutes: 10080, resetsAt: Math.floor(Date.now() / 1000) + 6 * 86400 } } },
  asks: { ok: true, checkedAt: ago(30), items: [
    { id: "a1", state: "open", source: "slack", from: "Luke McFarland", what: "Review the profile page animation and send thoughts", due: at(0,0).slice(0,10), dueText: "this afternoon", client: "Wedge", ref: "C1:1", link: "https://example.slack.com/x", quote: "can you take a look at the animation as well and let me know your thoughts", askedAt: ago(200) },
    { id: "a2", state: "open", source: "gmail", from: "David Hanson", what: "Add the _twilio TXT DNS record for KitFlare", due: null, dueText: null, client: "KitFlare", ref: "t9", link: null, quote: "I need your help in updating TXT DNS records for the host _twilio", askedAt: ago(60) },
    { id: "a3", state: "open", source: "slack", from: "Tahir", what: "Decide how to handle a duplicate Stripe subscription", due: at(0,0,-3).slice(0,10), dueText: null, client: "Fellas Loaded", ref: "C2:2", link: null, quote: "Should I cancel the Stripe subscription and keep the in-app subscription active", askedAt: ago(4000) },
    { id: "a4", state: "open", source: "meeting", from: "Weekly sync", what: "Send Coachman the phase 2 estimate", due: at(0,0,3).slice(0,10), dueText: "by Thursday", client: "Coachman", ref: "m:1", link: null, quote: "Dan to send the phase 2 estimate by Thursday", askedAt: ago(3000) },
  ] },
  deploys: { ok: true, at: ago(0), repo: "Git-Dann/docs-by-gitwork", state: "deploying", queued: 0, avgSec: 750,
    running: { n: 943, status: "in_progress", sha: "b5fd41b", title: "Gitwork OS polish: motion, real celebrations, 13 secrets (#943)", started: ago(5), updated: ago(0) },
    live: { n: 942, sha: "4bda294", title: "Dispatch never opens empty (#942)", started: ago(35), updated: ago(23) }, failed: null },
  monitors: { ok: true, total: 30, up: 28, down: [], trouble: [{ client: "Fellas Loaded", name: "Analytics", state: "flaky" }, { client: "Wedge", name: "Course API", state: "slow" }],
    dots: [...Array(28).fill("up"), "flaky", "slow"], incidents: [{ client: "Fellas Loaded", acknowledged: false }], link: "https://foundry.gitwork.co.uk/app/monitors",
    ours: [{ name: "Foundry — app", state: "up", ms: 125, code: 200 }, { name: "Foundry — marketing", state: "up", ms: 211, code: 200 }, { name: "gitwork.co.uk", state: "up", ms: 345, code: 200 }],
    groups: [
      { client: "Fellas Loaded", total: 3, up: 2, worst: "flaky", ms: 340, problems: [{ name: "Analytics", state: "flaky", ms: 900, code: 200 }] },
      { client: "Wedge", total: 4, up: 3, worst: "slow", ms: 2400, problems: [{ name: "Course API", state: "slow", ms: 2400, code: 200 }] },
      { client: "After Desk", total: 9, up: 9, worst: "up", ms: 410, problems: [] },
      { client: "Coachman", total: 2, up: 2, worst: "up", ms: 220, problems: [] },
      { client: "Big Wedge Golf", total: 2, up: 2, worst: "up", ms: 180, problems: [] },
      { client: "PollenIQ", total: 2, up: 2, worst: "up", ms: 95, problems: [] },
      { client: "KitFlare", total: 2, up: 2, worst: "up", ms: 260, problems: [] },
      { client: "YourGroop", total: 2, up: 2, worst: "up", ms: 300, problems: [] },
      { client: "Valu", total: 1, up: 1, worst: "up", ms: 150, problems: [] },
    ] },
});
const mode = process.env.MODE || "full";

// --live: where to read real data from.
function liveLink() {
  if (process.env.WALLPAPER) return process.env.WALLPAPER.trim();
  const env = `${homedir()}/.foundry-drafter/env`;
  if (!existsSync(env)) return null;
  const m = readFileSync(env, "utf8").match(/https:\/\/[^\s"]+\?k=[^\s"]+/);
  return m ? m[0] : null;
}
const LIVE = process.argv.includes("--live") ? liveLink() : null;
if (process.argv.includes("--live") && !LIVE) {
  console.error("No wallpaper link found. Put it in ~/.foundry-drafter/env, or run: WALLPAPER='https://…/?k=…' npm run preview:live");
  process.exit(1);
}

// Live reload: the page holds an event stream open and reloads when page.html changes.
const listeners = new Set();
for (const f of ["./src/page.html", "./src/controller.html", "./src/asks.html"]) watch(new URL(f, import.meta.url), () => { for (const res of listeners) res.write("data: reload\n\n"); });
const RELOADER = `<script>new EventSource("/__reload").onmessage=function(){location.reload()};</script>`;

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__reload") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("\n");
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  if (u.pathname === "/api/data") {
    res.setHeader("content-type", "application/json");
    if (LIVE) {
      const base = LIVE.split("?")[0].replace(/\/$/, ""), key = LIVE.split("?k=")[1];
      try {
        const r = await fetch(`${base}/api/data?k=${encodeURIComponent(key)}`);
        return res.end(await r.text());
      } catch (e) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ error: String(e) }));
      }
    }
    let d = sample();
    if (mode === "unconnected") d = { ...d, calendar: { ok: false, reason: "not_connected" }, mail: { ok: false, reason: "not_connected" }, commitments: { ok: false, reason: "not_configured" }, monitors: { ok: false, reason: "not_configured" }, slack: { ok: false, reason: "not_connected_slack" }, usage: { ok: false, reason: "not_set_up" } };
    return res.end(JSON.stringify(d));
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (u.pathname === "/api/stamp") { res.setHeader("content-type", "application/json"); return res.end('{"stamp":"1"}'); }
  if (u.pathname.startsWith("/api/tasks")) { res.setHeader("content-type", "application/json"); return res.end('{"ok":true,"repeatStored":"wallpaper"}'); }
  if (u.pathname.startsWith("/api/asks")) { res.setHeader("content-type", "application/json"); return res.end('{"ok":true,"state":"done"}'); }
  const file = u.pathname === "/controller" ? "./src/controller.html" : u.pathname === "/asks" ? "./src/asks.html" : "./src/page.html";
  res.end(readFileSync(new URL(file, import.meta.url), "utf8").replace("</body>", RELOADER + "</body>"));
}).listen(Number(process.env.PORT || 8788), () =>
  console.log(`Preview on http://localhost:${process.env.PORT || 8788} with ${LIVE ? "your real data" : "made-up data"}. It reloads when you save src/page.html. Ctrl+C to stop.`));
