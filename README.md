# email-cleanup-bot

Once a day: empties the Gmail spam folder (into Trash, recoverable for 30 days), unsubscribes from genuine
marketing senders the safe way, and writes a dashboard (`data/dashboard.html`) of the mail that matters and what's
due. The mail is read by a local model (Qwen3.8 27B in LM Studio); nothing goes to the cloud.

## How it works

1. **Collect**: Gmail spam (up to `maxSpam`) and new inbox mail since the last run (not Promotions, Social, Forums).
2. **Decide**: the model triages spam (marketing / scam / other) and summarises each inbox mail (important?
   category, priority, one-line summary, action, due date), two requests at a time. Code-side rules decide:
   - unsubscribe only if the mail has an RFC 8058 one-click header with an https link (a single POST, no page
     opened), Gmail verified the sender's DKIM signature, and the model says marketing (unsubscribing from real
     spam would confirm your address);
   - a due date is kept only if the email's own words for it are quoted.
3. **Act**: unsubscribe (once per domain), move all spam to Trash, update the dashboard, macOS notification.

The model is shared with the other bots; if it can't be had (busy, or too little memory for LM Studio's
guardrail), the run is retried. Google scope `gmail.modify`: read and move to Trash, never send or delete.

## Setup (macOS, Node 24+, LM Studio with Qwen3.8 27B)

```
cp .env.example .env    # a Google Desktop OAuth client (Gmail API on): ID and secret
npm run login           # sign in with the mailbox to clean; saves the refresh token into .env
npm start -- --open     # run now and open the dashboard
npm run schedule        # daily at runTimes from now on (npm run unschedule to stop)
```
Settings: `config.json` (`runTimes`, `timezone`, `firstRunHours`, `maxInbox`, `maxSpam`, `model`).
Personal values: `.env` only (gitignored). Run now: double-click `run-now.command` (opens the dashboard).

## Files

```
bot.js            the run: collect → decide → act
sources.js        Gmail API and the one-click unsubscribe POST
rules.js          prompts, schemas, unsubscribe and due-date rules, dashboard HTML (pure, tested)
test.js           tests for rules.js           kit.test.js   tests for kit.js
kit.js            shared kit: config, log, store, model sharing, Google login, run, scheduler
config.json       public settings              .env.example  personal values template
pii-check.sh      personal-data gate before a commit: bash pii-check.sh && git commit ...
run-now.command   double-click = npm start     package.json  npm start · test · login · schedule · unschedule
data/             (gitignored) bot.db state · bot.log log · run.out scheduler · dashboard.html
```

## When something goes wrong

A failure shows a macOS notification and is listed on the dashboard. Details: `data/bot.log` (each step,
`FAILED during …` with the error) and `data/run.out` (each scheduled try). Google access revoked: `npm run login`.
A wrong unsubscribe: resubscribe on the sender's site. `npm test` checks the rules and the kit.

## License

MIT
