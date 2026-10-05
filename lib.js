// Shared helpers: config, logging, state, unsubscribe rules, local model (LM Studio).
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// ── config ────────────────────────────────────────────────────────────────
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const e = process.env;
export const config = {
  googleClientId: e.GOOGLE_CLIENT_ID,
  googleClientSecret: e.GOOGLE_CLIENT_SECRET,
  googleRefreshToken: e.GOOGLE_REFRESH_TOKEN,
  model: 'Qwen3.8-27B-MLX-4bit',
  dryRun: (e.DRY_RUN ?? 'true') !== 'false' || process.argv.includes('--dry-run'),
  firstRunHours: Number(e.FIRST_RUN_HOURS || 48),
  maxInbox: Number(e.MAX_INBOX || 60),
  maxSpam: Number(e.MAX_SPAM || 300),
};

export function requireConfig(...keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')} (see .env.example)`);
}

// ── logging (data/bot.log) ────────────────────────────────────────────────
const LOG = path.join(DATA, process.env.NODE_TEST_CONTEXT ? 'test.log' : 'bot.log');
try { if (fs.statSync(LOG).size > 2e6) fs.renameSync(LOG, LOG + '.1'); } catch { /* no log yet */ }
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const STYLE = { INFO: '36', WARN: '33', ERROR: '1;31', DONE: '1;32' };

// Callers must never pass secrets.
function write(level, msg) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${level} ${msg}\n`);
  console.log(`${paint('2', new Date().toLocaleTimeString('en-GB', { hour12: false }))} ${paint(STYLE[level], level.padEnd(5))} ${msg}`);
}
export const log = { info: (m) => write('INFO', m), warn: (m) => write('WARN', m), error: (m) => write('ERROR', m), done: (m) => write('DONE', m) };

// ── state (data/state.json) ───────────────────────────────────────────────
const STATE = path.join(DATA, 'state.json');
export const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { lastRunMs: 0, unsubscribed: {}, dueItems: [], runs: [] }; }
};
export const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

/** Local calendar date 'YYYY-MM-DD'. */
export const localDate = (ms = Date.now()) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const htmlToText = (html) => html
  .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&#\d+;|&zwnj;|‌|͏/g, '')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// ── unsubscribe rules ─────────────────────────────────────────────────────
// Unsubscribing from real spam only confirms to the spammer that the address is live. So the bot
// unsubscribes only from senders that look like a genuine business, and only the safe way:
//  1. the mail has an RFC 8058 one-click header (List-Unsubscribe-Post: List-Unsubscribe=One-Click)
//     with an https link, so it's a single POST and no web page is ever opened,
//  2. the sender's domain is DKIM-verified by Gmail (the From domain can't be faked),
//  3. the local model says it's legitimate marketing, not a scam/phishing mail.
// Everything else in spam is just moved to Trash (Gmail empties Trash after 30 days).

/** Domain of the From address: 'Shop <news@mail.shop.com>' -> 'mail.shop.com'. */
export const fromDomain = (from) => (from.match(/@([\w.-]+)>?\s*$/)?.[1] || '').toLowerCase();

/** The https one-click unsubscribe URL, or null if the mail doesn't support RFC 8058. */
export function oneClickUrl(headers) {
  if (!/List-Unsubscribe=One-Click/i.test(headers['list-unsubscribe-post'] || '')) return null;
  const url = (headers['list-unsubscribe'] || '').match(/<(https:\/\/[^>]+)>/i)?.[1];
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (net.isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || !host.includes('.')) return null; // no IPs / local hosts
    return url;
  } catch { return null; }
}

/** True if Gmail verified a DKIM signature from the From domain (or its parent domain). */
export function dkimAligned(headers, from) {
  const domain = fromDomain(from);
  if (!domain) return false;
  const signers = [...(headers['authentication-results'] || '').matchAll(/dkim=pass[^;]*?header\.(?:i|d)=@?([\w.-]+)/gi)].map((m) => m[1].toLowerCase());
  // Same domain, or one is a subdomain of the other (news@shop.com signed by mail.shop.com). A shared
  // suffix like .co.in is not enough, and neither is a signature from the mailing provider's own domain.
  return signers.some((s) => domain === s || domain.endsWith(`.${s}`) || s.endsWith(`.${domain}`));
}

// ── local model (LM Studio) ───────────────────────────────────────────────
// Reuses the model if it's already loaded (and leaves it loaded); otherwise loads it and unloads it
// on exit. LM Studio's memory guardrails are respected: if they'd refuse MODEL, MODEL_FALLBACK is used.
const LMS = path.join(os.homedir(), '.lmstudio/bin/lms');
const MODEL_ID = 'email-cleanup-bot';
const CONTEXT = '16384';
const lms = async (...a) => (await promisify(execFile)(LMS, a, { encoding: 'utf8' })).stdout;
let model = null; // { id, key, owned, startedServer }

/** Loads (or reuses) the model; returns its key. */
export async function ensureModel() {
  const startedServer = !JSON.parse(await lms('server', 'status', '--json')).running;
  if (startedServer) await lms('server', 'start');
  const loaded = JSON.parse(await lms('ps', '--json'));
  const leftover = loaded.find((m) => m.identifier === MODEL_ID); // left by a crashed run: use it, then unload it
  if (leftover) { model = { id: MODEL_ID, key: leftover.modelKey, owned: true, startedServer }; return leftover.modelKey; }
  const names = [config.model, config.modelFallback].filter(Boolean);
  for (const name of names) {
    const matches = (m) => [m.modelKey, m.path, m.indexedModelIdentifier].includes(name);
    const running = loaded.find(matches);
    if (running) { model = { id: running.identifier, key: running.modelKey, owned: false, startedServer }; log.info(`reusing loaded model ${running.modelKey}`); return running.modelKey; }
    const key = JSON.parse(await lms('ls', '--json')).find(matches)?.modelKey;
    if (!key) throw new Error(`Model "${name}" is not downloaded in LM Studio`);
    if (/will fail to load/i.test(await lms('load', key, '--estimate-only', '--context-length', CONTEXT))) {
      log.warn(`not enough free memory for ${key} (LM Studio guardrails)`);
      continue;
    }
    model = { id: MODEL_ID, key, owned: true, startedServer }; // set first so a crash mid-load still cleans up
    try {
      await lms('load', key, '--identifier', MODEL_ID, '--context-length', CONTEXT, '-y');
    } catch (err) {
      if (!/memory|resource|guardrail/i.test(err.message) || name === names.at(-1)) throw err;
      log.warn(`LM Studio could not load ${key} for lack of memory, trying the fallback`);
      continue;
    }
    log.info(`model loaded: ${key}`);
    return key;
  }
  throw new Error(`Not enough free memory to load ${names.join(' or ')}: close other apps (e.g. Chrome) and retry`);
}

/** Unload the model only if this run loaded it. Synchronous so it also works in the exit handler. */
export function releaseModel() {
  if (!model) return;
  const { owned, startedServer } = model;
  model = null;
  const run = (...a) => execFileSync(LMS, a, { stdio: 'ignore' });
  if (owned) try { run('unload', MODEL_ID); log.info('model unloaded'); } catch (err) { log.warn(`model unload failed: ${err.message}`); }
  if (startedServer) try { run('server', 'stop'); } catch { /* already stopped */ }
}
process.on('exit', releaseModel);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:1234${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model?.id ?? MODEL_ID, temperature: 0, max_tokens: 1200, ...body }), signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

async function complete(messages) {
  if (/qwen/i.test(model?.key ?? config.model)) {
    // Qwen thinks by default; its own chat format ending in an empty <think> block switches that off (much faster).
    const prompt = messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('') + '<|im_start|>assistant\n<think>\n\n</think>\n\n';
    return (await post('/v1/completions', { prompt, stop: ['<|im_end|>'] })).choices[0].text;
  }
  return (await post('/v1/chat/completions', { messages })).choices[0].message.content;
}

export function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

/** Model reply as JSON; one retry on invalid JSON, then null. */
async function askJson(system, user, check) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await complete(messages);
    try { const obj = parseJson(reply); check(obj); return obj; } catch (err) {
      messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `Invalid (${err.message}). Reply with ONLY the JSON object.` });
    }
  }
  return null;
}

const SPAM_SYSTEM = `You triage emails from a Gmail spam folder. For each email decide:
- "marketing": a newsletter, promotion or notification from a real, identifiable business or organisation the person may once have signed up with.
- "scam": phishing, fake invoices/prizes/lottery, crypto or investment schemes, adult content, impersonation of a bank/brand, "your account will be suspended", unknown-person pleas, anything deceptive.
- "other": anything else, or unsure.
When in doubt choose "scam" or "other", never "marketing".
Return ONLY JSON: {"results":[{"n":1,"kind":"marketing|scam|other","reason":"max 8 words"}]} with one entry per email.`;

/** Classifies spam mails in batches of 8; returns Map(id -> {kind, reason}). */
export async function classifySpam(mails) {
  const out = new Map();
  for (let i = 0; i < mails.length; i += 8) {
    const batch = mails.slice(i, i + 8);
    const user = batch.map((m, j) => `#${j + 1}\nFrom: ${m.from}\nSubject: ${m.subject}\nText: ${m.text.slice(0, 800)}`).join('\n---\n');
    const obj = await askJson(SPAM_SYSTEM, user, (o) => { if (!Array.isArray(o.results)) throw new Error('missing results'); });
    for (const r of obj?.results || []) {
      const m = batch[Number(r.n) - 1];
      if (m && ['marketing', 'scam', 'other'].includes(r.kind)) out.set(m.id, { kind: r.kind, reason: String(r.reason || '').slice(0, 80) });
    }
  }
  return out;
}

const INBOX_SYSTEM = `You read one email for a busy person and decide if it matters.
Important = needs their action or attention: bills/payments, renewals, deadlines, appointments, bookings/travel, bank/tax/insurance/government, work or personal mail from real people, school, deliveries needing action, security alerts about their own accounts.
Not important = newsletters, promotions, social notifications, receipts needing no action, automated FYI mail.
Return ONLY JSON:
{"important":true|false,"category":"bill|finance|work|personal|travel|school|health|account|delivery|other","priority":"high|medium|low","summary":"one sentence, max 25 words","action":"what they must do, starting with a verb, or null","due_date":"YYYY-MM-DD or null","date_source":"exact words from the email that state that date, or null"}
Rules:
- Never put verification codes, OTPs, passwords or full account/card numbers in any field.
- due_date only if the email itself states a deadline, payment date, appointment or event date; copy those exact words into date_source. Never guess. Resolve relative dates against the email date.
- priority high = money/legal/security consequences or due within 3 days.`;

/** Summary of one inbox mail, or null if the model failed twice. Drops due dates not backed by the email text. */
export async function summarizeMail(mail, today) {
  const user = `Today: ${today}\nEmail date: ${localDate(mail.ms)}\nFrom: ${mail.from}\nSubject: ${mail.subject}\n---\n${mail.text.slice(0, 6000)}`;
  const obj = await askJson(INBOX_SYSTEM, user, (o) => { if (typeof o.important !== 'boolean') throw new Error('missing important'); });
  if (!obj) return null;
  return checkDue(obj, mail);
}

/** Keeps due_date only if it's a real date and its date_source is quoted from the email. */
export function checkDue(obj, mail) {
  const src = (obj.date_source || '').trim().toLowerCase();
  const hay = `${mail.subject}\n${mail.text}`.toLowerCase().replace(/\s+/g, ' ');
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(obj.due_date || '') && !Number.isNaN(Date.parse(obj.due_date));
  if (!valid || !src || !hay.includes(src.replace(/\s+/g, ' '))) { obj.due_date = null; obj.date_source = null; }
  return obj;
}
