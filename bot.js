// One run: clean the spam folder, summarise new important inbox mail, write data/dashboard.html.
//   npm start            (config.json "dryRun" decides whether anything is changed)
//   npm run dry          (never changes or saves anything)
//   npm start -- --open  (also opens the dashboard)
//   npm run login        (Google sign-in for the mailbox to clean)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { googleLogin } from './kit/google.js';
import * as llm from './kit/llm.js';
import { notify } from './kit/notify.js';
import { runBot } from './kit/run.js';
import { renderDashboard } from './dashboard.js';
import { checkDue, dkimAligned, fromDomain, localDate, oneClickUrl } from './rules.js';
import { getMail, oneClickUnsubscribe, profileEmail, searchIds, trash } from './sources/gmail.js';

const DAY = 86400000;
const prompt = (name) => fs.readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8').trim();
const SPAM_SYSTEM = prompt('spam');
const INBOX_SYSTEM = prompt('inbox');
const SPAM_SCHEMA = { type: 'object', additionalProperties: false, required: ['results'], properties: { results: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['n', 'kind', 'reason'],
  properties: { n: { type: 'integer' }, kind: { enum: ['marketing', 'scam', 'other'] }, reason: { type: 'string' } } } } } };
const INBOX_SCHEMA = { type: 'object', additionalProperties: false, required: ['important', 'category', 'priority', 'summary', 'action', 'due_date', 'date_source'], properties: {
  important: { type: 'boolean' },
  category: { enum: ['bill', 'finance', 'work', 'personal', 'travel', 'school', 'health', 'account', 'delivery', 'other'] },
  priority: { enum: ['high', 'medium', 'low'] },
  summary: { type: 'string' }, action: { type: ['string', 'null'] }, due_date: { type: ['string', 'null'] }, date_source: { type: ['string', 'null'] } } };

async function mapLimit(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

/** The model's answer; one more try if it was unusable, then null. */
async function askTwice(q) {
  for (let i = 0; i < 2; i++) try { return await llm.ask({ maxTokens: 1200, ...q }); } catch (e) { if (!(e instanceof llm.BadReply)) throw e; }
  return null;
}

/** Spam verdicts in batches of 8: Map(id -> {kind, reason}). */
async function classifySpam(mails) {
  const out = new Map();
  for (let i = 0; i < mails.length; i += 8) {
    const batch = mails.slice(i, i + 8);
    const user = batch.map((m, j) => `#${j + 1}\nFrom: ${m.from}\nSubject: ${m.subject}\nText: ${m.text.slice(0, 800)}`).join('\n---\n');
    const obj = await askTwice({ system: SPAM_SYSTEM, user, schema: SPAM_SCHEMA, name: 'spam' });
    for (const r of obj?.results || []) {
      const m = batch[Number(r.n) - 1];
      if (m) out.set(m.id, { kind: r.kind, reason: String(r.reason || '').slice(0, 80) });
    }
  }
  return out;
}

/** Summary of one inbox mail, or null if the model failed twice. Drops due dates not backed by the email text. */
async function summarizeMail(mail, today) {
  const user = `Today: ${today}\nEmail date: ${localDate(mail.ms)}\nFrom: ${mail.from}\nSubject: ${mail.subject}\n---\n${mail.text.slice(0, 6000)}`;
  const obj = await askTwice({ system: INBOX_SYSTEM, user, schema: INBOX_SCHEMA, name: 'inbox' });
  return obj && checkDue(obj, mail);
}

runBot({
  name: 'email-cleanup-bot',
  root: import.meta.dirname,
  defaults: {
    runTimes: ['07:00'],
    firstRunHours: 48, // the first run summarises this much inbox mail; later runs read everything since the last
    maxInbox: 60, // caps per run (keep a run to a few minutes)
    maxSpam: 300,
  },
  env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  optionalEnv: ['GOOGLE_REFRESH_TOKEN'],
  importJson: (state, store) => { for (const k of ['lastRunMs', 'unsubscribed', 'important', 'dueItems', 'runs']) if (k in state) store.set(k, state[k]); },
  async main({ cfg, store, log, dry, args }) {
    // gmail.modify = read mail and move it to Trash. It can't send mail or delete permanently.
    if (args.includes('--login')) return googleLogin(cfg.root, ['gmail.modify'], 'the Gmail account to clean up');
    const started = Date.now();
    const errors = [];
    const unsubscribed = store.get('unsubscribed') ?? {};
    const today = localDate();
    const account = await profileEmail();
    log.info(`run for ${account}`);

    // collect
    const spamIds = await searchIds('in:spam', cfg.maxSpam);
    const spam = (await mapLimit(spamIds, 10, getMail)).map((m) => ({ ...m, domain: fromDomain(m.from), url: oneClickUrl(m.headers), dkim: dkimAligned(m.headers, m.from) }));
    const candidates = spam.filter((m) => m.url && m.dkim && !unsubscribed[m.domain]);
    log.info(`spam: ${spam.length} messages, ${candidates.length} from verified senders with one-click unsubscribe`);
    const since = store.get('lastRunMs') || started - cfg.firstRunHours * 3600000;
    const inboxIds = await searchIds(`in:inbox -category:promotions -category:social -category:forums after:${Math.floor(since / 1000)}`, cfg.maxInbox);
    const inbox = (await mapLimit(inboxIds, 10, getMail)).filter((m) => m.ms >= since);
    log.info(`inbox: ${inbox.length} new messages since ${new Date(since).toLocaleString('en-GB')}`);

    // decide
    let verdicts = new Map();
    const summaries = [];
    let inboxOk = true;
    if (candidates.length || inbox.length) {
      await llm.acquire(); // no model now: retry the whole run later (exit 75)
      try {
        verdicts = await classifySpam(candidates);
      } catch (err) { errors.push(`Spam check failed: ${err.message}`); log.error(errors.at(-1)); }
      for (const [i, m] of inbox.entries()) {
        try {
          const s = await summarizeMail(m, today);
          if (!s) { log.warn(`no summary for "${m.subject}" (invalid model reply)`); continue; }
          log.info(`[${i + 1}/${inbox.length}] ${s.important ? `important (${s.priority})` : 'skip'}: ${m.subject.slice(0, 60)}`);
          if (s.important) summaries.push({ id: m.id, ms: m.ms, from: m.from, subject: m.subject, ...s });
        } catch (err) { inboxOk = false; errors.push(`Summary failed for "${m.subject}": ${err.message}`); log.error(errors.at(-1)); }
      }
      llm.release();
    }

    // act on spam: unsubscribe only verified marketing senders (one POST each), trash everything
    const spamReport = [];
    const doneDomains = new Set();
    for (const m of spam) {
      const v = verdicts.get(m.id);
      let action = dry ? 'would-trash' : 'trashed';
      let reason = v?.reason || (!m.url ? 'no one-click unsubscribe' : !m.dkim ? 'sender not verified (DKIM)' : '');
      if (unsubscribed[m.domain]) { action = 'already-unsubscribed'; reason = `unsubscribed ${unsubscribed[m.domain]}`; }
      else if (v?.kind === 'marketing' && m.url && m.dkim) {
        if (dry) action = 'would-unsubscribe';
        else if (doneDomains.has(m.domain)) action = 'unsubscribed';
        else {
          const ok = await oneClickUnsubscribe(m.url, log);
          action = ok ? 'unsubscribed' : 'unsubscribe-failed';
          if (ok) { doneDomains.add(m.domain); unsubscribed[m.domain] = today; log.info(`unsubscribed from ${m.domain}`); }
        }
      } else if (v) reason = `${v.kind}: ${v.reason}`;
      spamReport.push({ from: m.from, domain: m.domain, subject: m.subject, action, reason });
    }
    if (!dry && spam.length) {
      try { await trash(spam.map((m) => m.id)); log.info(`moved ${spam.length} spam messages to Trash`); }
      catch (err) { errors.push(`Trash failed: ${err.message}`); log.error(errors.at(-1)); }
    }

    // save (rolled back in a dry run) + dashboard
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
      at: started, account, dryRun: dry, model: llm.usage().calls ? cfg.model : '-', spam: spamReport, inboxCount: inbox.length,
      important: important.map((x) => ({ ...x, isNew: summaries.some((s) => s.id === x.id) })),
      newImportant: summaries.length, errors, seconds: (Date.now() - started) / 1000,
    };
    const file = path.join(cfg.data, 'dashboard.html');
    fs.writeFileSync(file, renderDashboard({ run, dueItems, runs }));
    const dueSoon = dueItems.filter((d) => d.due_date >= today && d.due_date <= localDate(started + 7 * DAY)).length;
    const line = `${summaries.length} important, ${dueSoon} due this week, ${spam.length} spam ${dry ? 'found (dry run)' : 'trashed'}`;
    log.done(`${line} · dashboard: ${file}`);
    if (!dry) notify('Inbox brief', line);
    if (args.includes('--open')) execFile('open', [file]);
    if (errors.length) throw new Error(`${errors.length} problem(s), see the dashboard: ${errors[0]}`);
  },
});
