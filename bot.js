// One run: clean the spam folder, summarise new important inbox mail, write data/dashboard.html.
//   node bot.js            (DRY_RUN in .env decides whether anything is changed)
//   node bot.js --dry-run  (never changes anything)
//   node bot.js --open     (also opens the dashboard)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { renderDashboard } from './dashboard.js';
import { getMail, oneClickUnsubscribe, profileEmail, searchIds, trash } from './gmail.js';
import { classifySpam, config, DATA, dkimAligned, ensureModel, fromDomain, loadState, localDate, log, oneClickUrl, requireConfig, saveState, summarizeMail } from './lib.js';

const DAY = 86400000;
const started = Date.now();
const errors = [];

async function mapLimit(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

requireConfig('googleClientId', 'googleClientSecret', 'googleRefreshToken');
const state = loadState();
state.unsubscribed ??= {};
state.important ??= [];
state.dueItems ??= [];
state.runs ??= [];
const today = localDate();
const account = await profileEmail();
log.info(`run for ${account}${config.dryRun ? ' (dry run: nothing will be changed)' : ''}`);

// ── read ──────────────────────────────────────────────────────────────────
const spamIds = await searchIds('in:spam', config.maxSpam);
const spam = (await mapLimit(spamIds, 10, getMail)).map((m) => ({ ...m, domain: fromDomain(m.from), url: oneClickUrl(m.headers), dkim: dkimAligned(m.headers, m.from) }));
const candidates = spam.filter((m) => m.url && m.dkim && !state.unsubscribed[m.domain]);
log.info(`spam: ${spam.length} messages, ${candidates.length} from verified senders with one-click unsubscribe`);

const since = state.lastRunMs || started - config.firstRunHours * 3600000;
const inboxIds = await searchIds(`in:inbox -category:promotions -category:social -category:forums after:${Math.floor(since / 1000)}`, config.maxInbox);
const inbox = (await mapLimit(inboxIds, 10, getMail)).filter((m) => m.ms >= since);
log.info(`inbox: ${inbox.length} new messages since ${new Date(since).toLocaleString('en-GB')}`);

// ── local model ───────────────────────────────────────────────────────────
let modelKey = '-';
let verdicts = new Map();
const summaries = [];
let inboxOk = true;
if (candidates.length || inbox.length) {
  modelKey = await ensureModel();
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
}

// ── act on spam: unsubscribe only verified marketing senders (one POST each), trash everything ──
const spamReport = [];
const doneDomains = new Set();
for (const m of spam) {
  const v = verdicts.get(m.id);
  let action = config.dryRun ? 'would-trash' : 'trashed';
  let reason = v?.reason || (!m.url ? 'no one-click unsubscribe' : !m.dkim ? 'sender not verified (DKIM)' : '');
  if (state.unsubscribed[m.domain]) { action = 'already-unsubscribed'; reason = `unsubscribed ${state.unsubscribed[m.domain]}`; }
  else if (v?.kind === 'marketing' && m.url && m.dkim) {
    if (config.dryRun) action = 'would-unsubscribe';
    else if (doneDomains.has(m.domain)) action = 'unsubscribed';
    else {
      const ok = await oneClickUnsubscribe(m.url);
      action = ok ? 'unsubscribed' : 'unsubscribe-failed';
      if (ok) { doneDomains.add(m.domain); state.unsubscribed[m.domain] = today; log.info(`unsubscribed from ${m.domain}`); }
    }
  } else if (v) reason = `${v.kind}: ${v.reason}`;
  spamReport.push({ from: m.from, domain: m.domain, subject: m.subject, action, reason });
}
if (!config.dryRun && spam.length) {
  try { await trash(spam.map((m) => m.id)); log.info(`moved ${spam.length} spam messages to Trash`); }
  catch (err) { errors.push(`Trash failed: ${err.message}`); log.error(errors.at(-1)); }
}

// ── save + dashboard ──────────────────────────────────────────────────────
const keep = (list, item) => [...list.filter((x) => x.id !== item.id), item];
for (const s of summaries) {
  state.important = keep(state.important, s);
  if (s.due_date) state.dueItems = keep(state.dueItems, s);
}
state.important = state.important.filter((x) => x.ms > started - 14 * DAY);
state.dueItems = state.dueItems.filter((x) => x.due_date >= localDate(started - 7 * DAY));
if (inboxOk) state.lastRunMs = started;

const run = {
  at: started, account, dryRun: config.dryRun, model: modelKey, spam: spamReport, inboxCount: inbox.length,
  important: state.important.filter((x) => x.ms > started - 14 * DAY).map((x) => ({ ...x, isNew: summaries.some((s) => s.id === x.id) })),
  newImportant: summaries.length, errors, seconds: (Date.now() - started) / 1000,
};
state.runs = [...state.runs, { at: started, spamCount: spam.length, importantCount: summaries.length }].slice(-60);
saveState(state);
const file = path.join(DATA, 'dashboard.html');
fs.writeFileSync(file, renderDashboard({ run, dueItems: state.dueItems, runs: state.runs }));

const dueSoon = state.dueItems.filter((d) => d.due_date >= today && d.due_date <= localDate(started + 7 * DAY)).length;
const line = `${summaries.length} important, ${dueSoon} due this week, ${spam.length} spam ${config.dryRun ? 'found (dry run)' : 'trashed'}`;
log.done(`${line} · dashboard: ${file}`);
execFile('osascript', ['-e', `display notification "${line}" with title "Inbox brief" sound name "default"`]);
if (process.argv.includes('--open')) execFile('open', [file]);
process.exitCode = errors.length ? 1 : 0;
