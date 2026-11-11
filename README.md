# Foundry Wallpaper

A live desktop wallpaper for [Plash](https://sindresorhus.com/plash): the date, UK and Pakistan time,
today's calendar as a 24-hour dial, Gmail and Slack, replies Claude has drafted for you, the promises
you've made in Foundry, and every client's uptime.

It runs on Cloudflare Workers and never writes to Google or Foundry. Each source fails on its own
and says so on the wallpaper. A source that can't be read never shows as "nothing there".

## Where it runs

The same repo deploys to two Cloudflare accounts, each through its own Workers Builds connection
to this repo's `main`:

| Copy | Cloudflare account | Address |
|---|---|---|
| Gitwork | dan@gitwork.co.uk | `https://foundry-wallpaper.<gitwork subdomain>.workers.dev` |
| Personal | Dan's personal account | `https://foundry-wallpaper.skcpcs48r9.workers.dev` |

Each copy is fully separate: its own storage (Wrangler creates it on first deploy), its own
secrets, its own Google sign-in and its own link. A push to `main` updates both. Below,
`<address>` means the copy you're setting up.

- The wallpaper link is `<address>/?k=<PAGE_KEY>`. Without the key every route answers 404.
- Options: `&discreet=1` blurs names and subjects (for screen sharing); `&still=1` stops the
  background moving.

**Setting up a copy** means doing the steps below once in that account. Shortcuts for the second one:
- **Google:** reuse the same OAuth client and add the second copy's `<address>/oauth/callback` as
  another authorised redirect URI. Then open that copy's `<address>/connect?k=…`.
- **Slack:** the same `SLACK_USER_TOKEN` works in both.
- **Foundry:** create a separate API key per copy, so either can be revoked alone.
- **PAGE_KEY:** use a different one per copy (`openssl rand -base64 24 | tr '+/' '-_' | tr -d =`).

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

### 4. Claude drafts your replies (runs on your Mac)

`local/draft-replies.sh` runs your own Claude Code with your own connectors (Gmail, Slack, Foundry,
Calendar). It finds messages waiting on you, looks up the client, tasks and meeting notes in
Foundry, and writes a **draft** in your voice. It never sends: send, reply, forward and post tools
are blocked, and `claude -p` refuses any tool not on its allow-list. It then tells the wallpaper
what it drafted, so those rows get a green DRAFT tag. The draft text itself stays in Gmail/Slack;
only "who" and "about" reach the wallpaper.

1. Install Claude Code (`npm i -g @anthropic-ai/claude-code`), sign in, and `brew install jq`.
2. Make sure your connectors show up: `claude mcp list`.
3. `./local/draft-replies.sh` once. It creates `~/.foundry-drafter/env`: paste each wallpaper
   link (with its `?k=`) under `WALLPAPERS`, one per line. Drafts are reported to every one.
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

## Changing it

Push to `main` and Cloudflare deploys it (Workers Builds, connected to this repo). The design in
`src/page.html` is bundled into the Worker, so a design change is just a push too.

```bash
npm install
npm run preview   # http://localhost:8788/?k=dev, with made-up data
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
| Local drafter | who each draft is to, a one-line summary, the client | the draft itself |
| Foundry `/api/monitors` | production monitors only: state per service; names only where something's wrong | targets, URLs |

Data is cached for 60 seconds in KV, so many open screens cost one read a minute.
