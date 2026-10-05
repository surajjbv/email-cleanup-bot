# email-cleanup-bot

**Every morning: your spam folder is emptied, and you get a dashboard of the mail that matters and what's due.**

## What it does

- **Spam cleanup.** Every message in Spam is moved to Trash (recoverable for 30 days; nothing is deleted permanently).
- **Safe unsubscribe.** It unsubscribes only from real businesses, never from scammers (unsubscribing from real spam tells them your address works). All three must hold:
  1. the mail supports one-click unsubscribe (RFC 8058, a single POST; no web page is opened),
  2. Gmail verified the sender's domain (DKIM),
  3. the local model judges it legitimate marketing, not phishing or a scam.
- **Important mail.** New inbox mail (except Promotions, Social, Forums) is read by **Qwen3.8 27B** in LM Studio, on this Mac. Nothing goes to the cloud. You get a one-line summary, an action, and the due date, but only if the email states that date.
- **Dashboard.** `data/dashboard.html` shows what's due (overdue ones too), important mail from the last 14 days, and the spam log. You also get a macOS notification after each run.

Each email takes about 5–15 s, so a typical run takes a few minutes.

## Setup (5 minutes, once)

1. `.env` already holds the Google client from school-reminder-bot. Run `npm run login` and choose **your** mailbox. Google warns that the app is unverified; continue, since it's your own app.
2. `npm start -- --open` runs it once and opens the dashboard.
3. `npm run schedule` runs it daily at `runTimes` in `config.json` (07:00). If the Mac is asleep, it runs 10 min after it wakes (up to 10 h late); a failed run is retried every 5 min three times, then every 30 min.

**Run now:** double-click `run-now.command` (it opens the dashboard when it finishes).

## If something goes wrong

Details are in `data/bot.log`.

| Problem | Fix |
|---|---|
| Google access revoked | `npm run login` |
| Not enough memory for Qwen | The run exits and is retried later (LM Studio's guardrail stays on). Close other apps (e.g. Chrome) to free memory |
| Wrong unsubscribe | Resubscribe on the sender's site. Remove the domain from the `unsubscribed` key in `data/bot.db` |
| Stop the schedule | `npm run unschedule` |

## Safeguards

- Google scope `gmail.modify`: it can read mail and move it to Trash, but it can't send mail or delete permanently.
- It never unsubscribes by email and never opens unsubscribe pages. It also refuses links to IP addresses or localhost.
- Each sender domain is unsubscribed only once.
- A due date is kept only if the model quotes the email's own words for it.
- The dashboard escapes all email text and blocks scripts (CSP), so a crafted email can't run code in it.
- The model is shared with the other bots (lease protocol in `kit/llm.js`) and unloaded when the last one is done; LM Studio's memory guardrails are respected.

Code: `bot.js` (collect → decide → act), `sources/gmail.js`, `rules.js`, `prompts/`, `dashboard.js`; shared code in `kit/` (from botkit). Settings: `config.json`; the Google login: `.env`. Tests: `npm test`.
