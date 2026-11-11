# Foundry Wallpaper

A live desktop wallpaper for [Plash](https://sindresorhus.com/plash): today's calendar as a 24-hour
dial, your Gmail inbox, the promises you've made in Foundry, and every client's uptime.

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

### 3. Plash

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
| Foundry `/api/monitors` | production monitors only: state per service; names only where something's wrong | targets, URLs |

Data is cached for 60 seconds in KV, so many open screens cost one read a minute.
