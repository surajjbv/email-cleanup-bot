// email-cleanup-bot: once a day, clean the Gmail spam folder (safe one-click unsubscribe + Trash) and write a
// dashboard of the important mail and due dates (data/dashboard.html), read by the local model.
//   npm start · npm start -- --open (also open the dashboard) · npm run login (Google sign-in)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { googleLogin, llm, notify, runBot } from './kit.js';
import { checkDue, classifySpam, dkimAligned, fromDomain, localDate, oneClickUrl, renderDashboard, summarizeMail } from './rules.js';
import { getMail, oneClickUnsubscribe, profileEmail, searchIds, trash } from './sources.js';

const DAY = 86400000;
/** fn over items, at most n at a time, results in order. */
async function mapLimit(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

runBot({
  name: 'email-cleanup-bot',
  defaults: {
    runTimes: ['07:00'],
    firstRunHours: 48, // the first run summarises this much inbox mail; later runs read everything since the last
    maxInbox: 60, // caps per run (keep a run to a few minutes)
    maxSpam: 300,
  },
  env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  optionalEnv: ['GOOGLE_REFRESH_TOKEN'],
  importJson: (state, store) => { for (const k of ['lastRunMs', 'unsubscribed', 'important', 'dueItems', 'runs']) if (k in state) store.set(k, state[k]); },
  async main({ cfg, store, log, args }) {
    // gmail.modify = read mail and move it to Trash. It can't send mail or delete permanently.
    if (args.includes('--login')) return googleLogin(['gmail.modify'], 'the Gmail account to clean up');
    const started = Date.now();
    const errors = [];
    const unsubscribed = store.get('unsubscribed') ?? {};
    const today = localDate();
    const account = await profileEmail();
    log.info(`run for ${account}`);

    // collect
    const since = store.get('lastRunMs') || started - cfg.firstRunHours * 3600000;
    const [spamIds, inboxIds] = await Promise.all([
      searchIds('in:spam', cfg.maxSpam),
      searchIds(`in:inbox -category:promotions -category:social -category:forums after:${Math.floor(since / 1000)}`, cfg.maxInbox),
    ]);
    const spam = (await mapLimit(spamIds, 10, getMail)).map((m) => ({ ...m, domain: fromDomain(m.from), url: oneClickUrl(m.headers), dkim: dkimAligned(m.headers, m.from) }));
    const inbox = (await mapLimit(inboxIds, 10, getMail)).filter((m) => m.ms >= since);
    const candidates = spam.filter((m) => m.url && m.dkim && !unsubscribed[m.domain]);
    log.info(`spam: ${spam.length} messages, ${candidates.length} from verified senders with one-click unsubscribe; inbox: ${inbox.length} new since ${new Date(since).toLocaleString('en-GB')}`);

    // decide: spam triage and inbox summaries together, 2 requests at a time (the model's parallel slots)
    let verdicts = new Map();
    const summaries = [];
    let inboxOk = true;
    if (candidates.length || inbox.length) {
      await llm.acquire(); // no model now: retry the whole run later (exit 75)
      const triage = classifySpam(candidates, llm.ask).then((v) => { verdicts = v; }, (err) => { errors.push(`Spam check failed: ${err.message}`); log.error(errors.at(-1)); });
      await mapLimit([...inbox.entries()], candidates.length ? 1 : 2, async ([i, m]) => {
        try {
          const s = await summarizeMail(m, today, llm.ask);
          if (!s) return log.warn(`no summary for "${m.subject}" (invalid model reply)`);
          log.info(`[${i + 1}/${inbox.length}] ${s.important ? `important (${s.priority})` : 'skip'}: ${m.subject.slice(0, 60)}`);
          if (s.important) summaries.push({ id: m.id, ms: m.ms, from: m.from, subject: m.subject, ...s });
        } catch (err) { inboxOk = false; errors.push(`Summary failed for "${m.subject}": ${err.message}`); log.error(errors.at(-1)); }
      });
      await triage;
      llm.release();
      summaries.sort((a, b) => inbox.findIndex((m) => m.id === a.id) - inbox.findIndex((m) => m.id === b.id));
    }

    // act: unsubscribe only verified marketing senders (one POST each), trash all spam
    const spamReport = [];
    const doneDomains = new Set();
    for (const m of spam) {
      const v = verdicts.get(m.id);
      let action = 'trashed';
      let reason = v?.reason || (!m.url ? 'no one-click unsubscribe' : !m.dkim ? 'sender not verified (DKIM)' : '');
      if (unsubscribed[m.domain]) { action = 'already-unsubscribed'; reason = `unsubscribed ${unsubscribed[m.domain]}`; }
      else if (v?.kind === 'marketing' && m.url && m.dkim) {
        if (doneDomains.has(m.domain)) action = 'unsubscribed';
        else {
          const ok = await oneClickUnsubscribe(m.url, log);
          action = ok ? 'unsubscribed' : 'unsubscribe-failed';
          if (ok) { doneDomains.add(m.domain); unsubscribed[m.domain] = today; log.info(`unsubscribed from ${m.domain}`); }
        }
      } else if (v) reason = `${v.kind}: ${v.reason}`;
      spamReport.push({ from: m.from, domain: m.domain, subject: m.subject, action, reason });
    }
    if (spam.length) {
      try { await trash(spam.map((m) => m.id)); log.info(`moved ${spam.length} spam messages to Trash`); }
      catch (err) { errors.push(`Trash failed: ${err.message}`); log.error(errors.at(-1)); }
    }

    // save + dashboard
    const keep = (list, item) => [...list.filter((x) => x.id !== item.id), item];
    let important = store.get('important') ?? [];
    let dueItems = store.get('dueItems') ?? [];
    for (const s of summaries) {
      important = keep(important, s);
      if (s.due_date) dueItems = keep(dueItems, s);
    }
    important = important.filter((x) => x.ms > started - 14 * DAY);
    dueItems = dueItems.filter((x) => x.due_date >= localDate(started - 7 * DAY));
    const runs = [...(store.get('runs') ?? []), { at: started, spamCount: spam.length, importantCount: summaries.length }].slice(-60);
    store.set('unsubscribed', unsubscribed);
    store.set('important', important);
    store.set('dueItems', dueItems);
    store.set('runs', runs);
    if (inboxOk) store.set('lastRunMs', started);
    const run = {
      at: started, account, model: llm.usage().calls ? cfg.model : '-', spam: spamReport, inboxCount: inbox.length,
      important: important.map((x) => ({ ...x, isNew: summaries.some((s) => s.id === x.id) })),
      newImportant: summaries.length, errors, seconds: (Date.now() - started) / 1000,
    };
    const file = path.join(cfg.data, 'dashboard.html');
    fs.writeFileSync(file, renderDashboard({ run, dueItems, runs }));
    const dueSoon = dueItems.filter((d) => d.due_date >= today && d.due_date <= localDate(started + 7 * DAY)).length;
    const line = `${summaries.length} important, ${dueSoon} due this week, ${spam.length} spam trashed`;
    log.done(`${line} · dashboard: ${file}`);
    notify('Inbox brief', line);
    if (args.includes('--open')) execFile('open', [file]);
    if (errors.length) throw new Error(`${errors.length} problem(s), see the dashboard: ${errors[0]}`);
  },
});
