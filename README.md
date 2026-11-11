# Foundry Wallpaper

A live desktop wallpaper for [Plash](https://sindresorhus.com/plash): the date, UK and Pakistan time,
today's calendar as a 24-hour dial, Gmail and Slack, replies Claude has drafted for you, the promises
you've made in Foundry, and every client's uptime.

It runs on Cloudflare Workers and never writes to Google or Foundry. Each source fails on its own
and says so on the wallpaper. A source that can't be read never shows as "nothing there".

## Where it is

- Worker: `foundry-wallpaper` on Cloudflare, at `https://foundry-wallpaper.skcpcs48r9.workers.dev`.
- The wallpaper link is `https://foundry-wallpaper.skcpcs48r9.workers.dev/?k=<PAGE_KEY>`. Without
  the key every route answers 404.
- Options: `&discreet=1` blurs names and subjects (for screen sharing); `&still=1` stops the
  background moving.

## Set-up

### 1. Google (calendar + Gmail, read-only)

1. In Google Cloud Console, in a project under the gitwork.co.uk organisation, enable the
   **Google Calendar API** and the **Gmail API**.
2. **OAuth consent screen**: user type **Internal**. Internal apps need no Google review.
3. **Credentials → Create OAuth client ID → Web application.**
   - Authorised redirect URI: `https://foundry-wallpaper.skcpcs48r9.workers.dev/oauth/callback`
4. Add the client ID and secret to the Worker as secrets, `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. Cloudflare → Workers & Pages → foundry-wallpaper → Settings →
   Variables and secrets → Add → type Secret.
5. Open `https://foundry-wallpaper.skcpcs48r9.workers.dev/connect?k=<PAGE_KEY>` and sign in with
   your Gitwork account. The refresh token is kept in the Worker's KV store, never in the page.

To disconnect Google, remove the app at myaccount.google.com → Security → Third-party access.

### 2. Foundry (commitments + monitors)

1. Foundry → Settings → Developer → API keys → create one called "Wallpaper".
2. Add it to the Worker as the secret `FOUNDRY_API_KEY`.

The key acts as you, read-only here. Archiving you in Foundry stops it.

### 3. Slack (mentions and DMs, read-only)

1. api.slack.com/apps → **Create New App → From scratch**, in the Gitwork workspace. Name it
   "Foundry Wallpaper".
2. **OAuth & Permissions:**
   - Redirect URL: `https://foundry-wallpaper.skcpcs48r9.workers.dev/oauth/slack`
   - **User Token Scopes** (not Bot): `search:read`, `users:read`
3. **Basic Information:** copy the Client ID and Client Secret into the Worker as secrets
   `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.
4. Open `https://foundry-wallpaper.skcpcs48r9.workers.dev/connect-slack?k=<PAGE_KEY>` and allow it.

It searches the last 3 days for messages that mention you and DMs sent to you (`to:me`), the
same searches you'd type in Slack. Not yet checked against a real workspace: if DMs never show,
`to:me` isn't honoured by the API and the DM half needs switching to `conversations.list`.

### 4. Claude drafts your replies (runs on your Mac)

`local/draft-replies.sh` runs your own Claude Code with your own connectors (Gmail, Slack, Foundry,
Calendar). It finds messages waiting on you, looks up the client, tasks and meeting notes in
Foundry, and writes a **draft** in your voice. It never sends: send, reply, forward and post tools
are blocked, and `claude -p` refuses any tool not on its allow-list. It then tells the wallpaper
what it drafted, so those rows get a green DRAFT tag. The draft text itself stays in Gmail/Slack;
only "who" and "about" reach the wallpaper.

1. Install Claude Code (`npm i -g @anthropic-ai/claude-code`), sign in, and `brew install jq`.
2. Make sure your connectors show up: `claude mcp list`.
3. `./local/draft-replies.sh` once. It creates `~/.foundry-drafter/env`: add your `PAGE_KEY`.
4. `./local/draft-replies.sh --check` and fix the four server names in that file if they differ
   from what `claude mcp list` shows.
5. `./local/draft-replies.sh` to run it now. Check the drafts in Gmail and Slack before trusting it.
6. `./local/draft-replies.sh --install` to run it hourly on weekdays, 07:00–19:00.

Cost: each run is one Claude Code session. A trivial run measured $0.36 on the default model, so it
uses Sonnet by default (`MODEL` in the env file). A real run reading a dozen threads will cost more;
check the first few in your usage page before leaving it on. On a Claude subscription it counts
against your plan's limits instead.

Edit `local/prompt.md` to change how it writes or what it skips.

### 5. Plash

Plash → Add Website → paste the wallpaper link. Set reload to every 5 minutes. The page refreshes
its data every minute on its own; the reload is only a safety net.

## Changing the design

The design lives in `src/page.html` and is stored in KV, so changing it needs no redeploy:

```bash
npm run preview   # http://localhost:8788/?k=dev, with made-up data
WALLPAPER_URL=https://foundry-wallpaper.skcpcs48r9.workers.dev PAGE_KEY=… npm run publish-page
```

Changing `src/worker.js` needs a deploy: `npm run deploy` (Wrangler, logged in to the same
Cloudflare account).

## What it reads

| Source | Read | Never shown |
|---|---|---|
| Google Calendar | today and tomorrow's events: title, time, people count, external or not, Meet link | descriptions, attendee emails |
| Gmail | inbox unread count; the 7 newest unread in Primary: sender name, subject, time | message bodies |
| Foundry `/api/backstage/commitments` | open commitments, sorted by due date | quotes, evidence |
| Slack search | mentions of you and DMs to you, last 3 days: sender, channel, first 180 characters | anything else |
| Local drafter | who each draft is to, a one-line summary, the client | the draft itself |
| Foundry `/api/monitors` | production monitors only: state per service; names only where something's wrong | targets, URLs |

Data is cached for 60 seconds in KV, so many open screens cost one read a minute.
