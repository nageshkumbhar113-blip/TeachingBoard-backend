# nks-wa-bot — WhatsApp parent bot + CRM API (Cloudflare Worker)

The rules live in `src/waFlow.js` (the same file runs the demo page). This Worker only stores, sends and routes:

| Path | Who calls it | What |
|---|---|---|
| `GET /webhook` | Meta (once) | webhook check (`VERIFY_TOKEN`) |
| `POST /webhook` | Meta | parents' messages + delivery statuses (signature checked with `META_APP_SECRET`) |
| `POST /event` | Render | test done / paid / app / form number / महा-Test result / sync (`X-Bot-Key`) |
| `POST /tick` | cron every 10 min (and tests) | the schedule + jobs to Render |
| `/crm/…` | Admin › 📇 CRM | lists, chat, call result, team message, reply (token from Render) |

Rules that protect money: the bot never pays for a message by itself (`autoTemplates: false` in waFlow.js);
a paid template only by hand from Admin, capped by `DAILY_CAP_RS`, and only with an approved `REENGAGE_TEMPLATE`.
`BOT_OFF = "1"` stops all sending at once.

## Run the tests on this computer
```
npm install
npm test          # local Worker + local D1 + fake Meta + fake Render — needs no account
```

## First deploy (one time)
1. `npx wrangler login` (opens Cloudflare in the browser).
2. `npx wrangler d1 create nks-wa` → copy the `database_id` into `wrangler.toml`.
3. `npm run db:remote` (creates the tables).
4. Secrets (typed in the terminal, never in chat or git):
   ```
   npx wrangler secret put WA_TOKEN
   npx wrangler secret put WA_PHONE_ID
   npx wrangler secret put META_APP_SECRET
   npx wrangler secret put VERIFY_TOKEN
   npx wrangler secret put SHARED_SECRET
   ```
5. `npm run deploy` → note the URL (`https://nks-wa-bot.<name>.workers.dev`).
6. In `wrangler.toml` `[vars]`: `BOT_NUMBER = "91XXXXXXXXXX"` (the bot's number), `TEAM_NUMBER`, then deploy again.
7. Render → Environment: `WA_WORKER_URL` = the Worker URL, `BOT_SHARED_SECRET` = the same text as `SHARED_SECRET`,
   `WA_BOT_NUMBER` = `91XXXXXXXXXX` (this switches on the website's WhatsApp buttons).
8. Meta → WhatsApp → Configuration → Webhook: URL `<Worker URL>/webhook`, verify token = `VERIFY_TOKEN`;
   subscribe to **messages**.

## Switch off quickly
Cloudflare → Workers → nks-wa-bot → Settings → Variables: `BOT_OFF = 1` (or remove `WA_BOT_NUMBER` on Render to hide
the website buttons).
