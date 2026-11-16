# Foundry Wallpaper

A live desktop wallpaper for [Plash](https://sindresorhus.com/plash): the date, UK and Pakistan time,
today's calendar as a 24-hour dial, Gmail and Slack, what people have asked of you, the promises
you've made in Foundry, your Claude and Codex usage, and every client's uptime.

It runs on Cloudflare Workers and never writes to Google or Foundry. Each source fails on its own
and says so on the wallpaper. A source that can't be read never shows as "nothing there".

## Where it runs

- Cloudflare: the `foundry-wallpaper` Worker in Dan's personal Cloudflare account, deployed by
  Workers Builds on every push to `main`.
- Address: `https://foundry-wallpaper.skcpcs48r9.workers.dev`. Below, `<address>` means this.
- It reads Gitwork's data: Google is signed in as dan@gitwork.co.uk, and the Slack and Foundry
  credentials are Gitwork's. Which Cloudflare account hosts it doesn't change what it can read.
- The wallpaper link is `<address>/?k=<PAGE_KEY>`. Without the key every route answers 404.
- Options: `&discreet=1` blurs names and subjects (for screen sharing); `&still=1` stops the
  background moving.
- Secrets must be type **Secret**, never Variable: a deploy resets plain variables to what's in
  `wrangler.toml`, and a Variable's value is shown to anyone with dashboard access.

## Set-up

### 1. Google (calendar + Gmail, read-only)

1. In Google Cloud Console, in a project under the gitwork.co.uk organisation, enable the
   **Google Calendar API** and the **Gmail API**.
2. **OAuth consent screen**: user type **Internal**. Internal apps need no Google review.
3. **Credentials → Create OAuth client ID → Web application.**
   - Authorised redirect URI: `<address>/oauth/callback`
4. Add the client ID and secret to the Worker as secrets, `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. Cloudflare → Workers & Pages → foundry-wallpaper → Settings →
   Variables and secrets → Add → type Secret.
5. Open `<address>/connect?k=<PAGE_KEY>` and sign in with
   your Gitwork account. The refresh token is kept in the Worker's KV store, never in the page.

To disconnect Google, remove the app at myaccount.google.com → Security → Third-party access.

### 2. Foundry (commitments + monitors)

1. Foundry → Settings → Developer → API keys → create one called "Wallpaper".
2. Add it to the Worker as the secret `FOUNDRY_API_KEY`.

The key acts as you, read-only here. Archiving you in Foundry stops it.

### 3. Slack (mentions and DMs, read-only)

1. In your Slack app (api.slack.com/apps → Foundry Wallpaper) → **OAuth & Permissions** →
   **User Token Scopes** (not Bot Token Scopes): add `search:read` and `users:read`.
2. Click **Reinstall to Workspace** at the top of that page. Slack only grants new scopes on a
   reinstall.
3. Copy the **User OAuth Token** (starts `xoxp-`) into the Worker as the secret `SLACK_USER_TOKEN`.
   Don't paste it anywhere else. The bot and app tokens aren't used.

It searches the last 3 days for messages that mention you and DMs sent to you (`to:me`), the
same searches you'd type in Slack. Not yet checked against a real workspace: if DMs never show,
`to:me` isn't honoured by the API and the DM half needs switching to `conversations.list`.

(There's also a sign-in route, `/connect-slack`, for an app set up with `SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET` and the redirect URL `…/oauth/slack`. You only need one of the two.)

### 4. Your Mac's jobs: asks and usage

Two scheduled jobs, run by your own Claude Code. **Neither can send or change anything** in Gmail,
Slack or Foundry.

- **Asks** (hourly, weekdays 07:00–19:00): see *On you* below.
- **Usage** (every 5 minutes): sends your Claude and Codex plan usage to the wallpaper's
  **Claude · Codex** card, showing the 5-hour and weekly windows, how much is used and when each
  resets. It calls no model, so it costs nothing.
  - Claude's figures come from Claude Code's status line, which `--install` sets up (unless you
    already have one, in which case it tells you). They update whenever you use Claude Code.
  - Codex's come from its session logs in `~/.codex/sessions`, so they update whenever you use Codex.
  - A reading older than 6 hours shows its age in amber. A window whose reset time has passed
    shows as 0%.

Set-up:
1. Install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`), sign in, and
   `brew install jq git`.
2. `./local/draft-replies.sh` once. It creates `~/.foundry-drafter/env`: paste your wallpaper
   link (with its `?k=`) under `WALLPAPERS`.
3. `./local/draft-replies.sh --check` and fix the server names in that file if they differ.
4. `./local/draft-replies.sh --install` to schedule both jobs and set the status line. It also
   removes the old suggested-replies jobs. Run it again after a `git pull` that changes the schedule.
5. `./local/draft-replies.sh` collects asks now; `./local/draft-replies.sh --usage` sends usage now.

Log: `~/.foundry-drafter/drafter.log`. Edit `local/asks.md` to change what counts as an ask.

### On you: what's been asked of you

The hourly job also collects every request or deadline someone has given you in the last 3 days,
from Slack, Gmail, Foundry meeting notes and Claude Meetings action items. Each one carries the
person's exact words, so a made-up item can't slip in. The wallpaper's **On you** card mixes these
with what you've promised in Foundry, soonest deadline first; **All ↗** opens `<address>/asks?k=…`,
grouped Late / Today / This week / Later / No date, where you can mark one **Done**, **Add to my
week** (a Foundry commitment due that day) or **Not for me**. A decision sticks: a later scan finding
the same message won't bring it back.

### Your week

**This week** (under the dial) is Monday to Friday, or next week at the weekend: meetings per day,
plus every dated open commitment from Foundry → Backstage → Commitments, with repeating ones (↻)
on each day they fall.

**Add or tick off tasks** at `<address>/controller?k=…` (the wallpaper's **+ Add** link opens it).
Changes show on the wallpaper within about 15 seconds; it checks `/api/stamp` for changes.

While production Foundry can't store repeats (it's behind on deploys), a repeat it rejects is kept
by the wallpaper in KV (`repeat:overlay`), and "Done this time" moves the task to its next date.
Once Foundry stores repeats, new ones go there instead.

### 5. Plash

Plash → Add Website → paste the wallpaper link. Set reload to every 5 minutes. The page refreshes
its data every minute on its own; the reload is only a safety net.

## Changing it

The look is all in `src/page.html`. The fast loop:

1. `npm run preview:live` and open http://localhost:8788. It shows **your real data** (read from
   the live wallpaper, using the link in `~/.foundry-drafter/env`), and **reloads itself a second
   after you save** `src/page.html`. Put http://localhost:8788 in Plash while you work to see it
   on the desktop. (`npm run preview` does the same with made-up data.)
2. Change `src/page.html`, by hand or by asking Claude Code (`claude` in this folder).
3. When it's right: `git add -A && git commit -m "…" && git push`. Cloudflare deploys `main` in
   about a minute, and Plash picks it up on its next reload.

Changes to `src/worker.js` (what data is read) only take effect once pushed, because the preview
reads data from the live wallpaper.

```bash
npm run check     # syntax check + a Wrangler dry run of exactly what will deploy
```

Secrets live only in Cloudflare (Settings → Variables and secrets); a deploy keeps them.

## What it reads

| Source | Read | Never shown |
|---|---|---|
| Google Calendar | today and tomorrow's events: title, time, people count, external or not, Meet link | descriptions, attendee emails |
| Gmail | inbox unread count; the 7 newest unread in Primary: sender name, subject, time | message bodies |
| Foundry `/api/backstage/commitments` | open commitments, sorted by due date | quotes, evidence |
| Slack search | mentions of you and DMs to you, last 3 days: sender, channel, first 180 characters | anything else |
| Your Mac | asks (who, what, due, their words); Claude and Codex usage (percent used, reset times) | message bodies, prompts, tokens |
| Foundry `/api/monitors` | production monitors only: state per service; names only where something's wrong | targets, URLs |

Data is cached for 60 seconds in KV, so many open screens cost one read a minute.
