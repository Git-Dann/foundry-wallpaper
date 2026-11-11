// Local preview with made-up data: node preview.mjs → http://localhost:8788/?k=dev
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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
  commitments: { ok: true, open: 7, overdue: 1, suggested: 2, items: [
    { title: "Send Valu the revised proposal", dueAt: ago(60 * 20), counterpart: "Valu" },
    { title: "Reply to Luke on the course feed outage", dueAt: at(17, 0), counterpart: "Big Wedge" },
    { title: "Review Coachman phase 2 estimate", dueAt: at(12, 0, 2), counterpart: "Coachman" },
  ] },
  slack: { ok: true, mentions: 3, dms: 2, days: 3, items: [
    { id: "C1:1", kind: "mention", from: "Harry Brown", fromId: "U1", channel: "fellas-loaded", text: "@Dan can you sign off the 3.4 release notes before 2?", at: ago(12) },
    { id: "D1:2", kind: "dm", from: "Syed", fromId: "U2", channel: null, text: "Coachman want to move Thursday's call to Friday, ok?", at: ago(55) },
    { id: "C2:3", kind: "mention", from: "Waqar", fromId: "U3", channel: "wedge-dev", text: "@Dan course feed is back, catching up 41 requests", at: ago(130) },
  ] },
  drafts: { ok: true, generatedAt: ago(18), skipped: 4, drafts: [
    { source: "gmail", to: "Luke McFarland", about: "Confirming 3.4 approval and the course-feed fix", client: "Big Wedge", ref: "t1", urgency: "high" },
    { source: "slack", to: "Syed", about: "Friday works, 2pm UK", client: "Coachman", ref: "D1:2", urgency: "normal" },
    { source: "gmail", to: "Sarah Chen", about: "Thanks for the notes, proposal by Friday", client: "Valu", ref: "t2", urgency: "normal" },
  ] },
  monitors: { ok: true, total: 18, up: 16, down: [], trouble: [{ client: "Fellas Loaded", name: "Analytics", state: "flaky" }, { client: "Wedge", name: "Course API", state: "slow" }],
    dots: [...Array(16).fill("up"), "flaky", "slow"], incidents: 0 },
});
const mode = process.env.MODE || "full";
createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/data") {
    let d = sample();
    if (mode === "unconnected") d = { ...d, calendar: { ok: false, reason: "not_connected" }, mail: { ok: false, reason: "not_connected" }, commitments: { ok: false, reason: "not_configured" }, monitors: { ok: false, reason: "not_configured" }, slack: { ok: false, reason: "not_connected_slack" }, drafts: { ok: false, reason: "not_set_up" } };
    res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(d));
  }
  res.setHeader("content-type", "text/html"); res.end(readFileSync(new URL("./src/page.html", import.meta.url)));
}).listen(Number(process.env.PORT || 8788), () => console.log("preview on", process.env.PORT || 8788));
