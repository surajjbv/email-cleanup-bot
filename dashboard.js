// Renders data/dashboard.html: one self-contained page, no scripts (CSP forbids them), light + dark.
// All email text is untrusted, so every value goes through esc().
import { localDate } from './rules.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gmailLink = (id) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
const sender = (from) => from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || from;
const DAY = 86400000;
const daysUntil = (date, today) => Math.round((Date.parse(date) - Date.parse(today)) / DAY);
const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const whenLabel = (n) => (n < 0 ? `${-n}d overdue` : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `in ${n} days`);

const ACTION = {
  unsubscribed: ['Unsubscribed + trashed', 'ok'],
  trashed: ['Trashed', 'muted'],
  'unsubscribe-failed': ['Unsubscribe failed, trashed', 'warn'],
  'already-unsubscribed': ['Already unsubscribed, trashed', 'muted'],
};

export function renderDashboard({ run, dueItems, runs }) {
  const today = localDate(run.at);
  const due = dueItems.filter((d) => daysUntil(d.due_date, today) >= -3).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const dueWeek = due.filter((d) => daysUntil(d.due_date, today) <= 7).length;
  const important = [...run.important].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.priority] ?? 3) || b.ms - a.ms);
  const unsub = run.spam.filter((s) => s.action === 'unsubscribed').length;
  const hist = runs.slice(-14);
  const histMax = Math.max(1, ...hist.map((r) => r.spamCount));

  const tile = (label, value, note) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-note">${note}</div></div>`;

  const dueRows = due.map((d) => {
    const n = daysUntil(d.due_date, today);
    const tone = n < 0 ? 'overdue' : n <= 2 ? 'soon' : '';
    return `<li class="due ${tone}">
      <div class="due-date"><strong>${esc(fmtDate(d.due_date))}</strong><span>${esc(whenLabel(n))}</span></div>
      <div class="due-body"><div class="due-action">${esc(d.action || d.summary)}</div>
      <div class="meta">${esc(sender(d.from))} · <a href="${gmailLink(d.id)}" target="_blank" rel="noopener noreferrer">${esc(d.subject)}</a></div></div></li>`;
  }).join('') || '<li class="empty">No due dates found.</li>';

  const cards = important.map((m) => `<article class="card p-${esc(m.priority)}">
      <div class="card-top">${m.isNew ? '<span class="pill new">New</span>' : ''}<span class="pill">${esc(m.category)}</span><span class="prio">${esc(m.priority)}</span>${m.due_date ? `<span class="pill due-pill">Due ${esc(fmtDate(m.due_date))}</span>` : ''}</div>
      <h3><a href="${gmailLink(m.id)}" target="_blank" rel="noopener noreferrer">${esc(m.subject)}</a></h3>
      <div class="meta">${esc(sender(m.from))} · ${esc(new Date(m.ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</div>
      <p>${esc(m.summary)}</p>${m.action ? `<p class="todo">→ ${esc(m.action)}</p>` : ''}</article>`).join('') || '<p class="empty">Nothing important in the last 14 days.</p>';

  const spamRows = run.spam.map((s) => {
    const [label, tone] = ACTION[s.action] || [s.action, 'muted'];
    return `<tr><td>${esc(sender(s.from))}<div class="meta">${esc(s.domain)}</div></td><td>${esc(s.subject)}</td><td><span class="tag ${tone}">${esc(label)}</span></td><td class="meta">${esc(s.reason)}</td></tr>`;
  }).join('');

  const bars = hist.map((r) => `<div class="bar" title="${esc(localDate(r.at))}: ${r.spamCount} spam, ${r.importantCount} important">
      <div class="bar-fill" style="height:${Math.round((r.spamCount / histMax) * 100)}%"></div><span>${esc(new Date(r.at).getDate())}</span></div>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>Inbox Brief</title>
<style>
:root{--bg:#f6f5f2;--surface:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e5e2dc;--accent:#2f5bd3;--ok:#1f7a4d;--ok-bg:#e3f3ea;--warn:#a15c00;--warn-bg:#fdf0dc;--bad:#b42318;--bad-bg:#fde7e4;--chip:#efede8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--surface:#1e1d1b;--ink:#ecebe7;--muted:#a19d95;--line:#33312d;--accent:#8aa8ff;--ok:#6fd19c;--ok-bg:#163325;--warn:#f0b35a;--warn-bg:#3a2a12;--bad:#ff8a7a;--bad-bg:#3d1a16;--chip:#2a2926}}
:root[data-theme="dark"]{--bg:#141413;--surface:#1e1d1b;--ink:#ecebe7;--muted:#a19d95;--line:#33312d;--accent:#8aa8ff;--ok:#6fd19c;--ok-bg:#163325;--warn:#f0b35a;--warn-bg:#3a2a12;--bad:#ff8a7a;--bad-bg:#3d1a16;--chip:#2a2926}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 16px 64px}a{color:inherit;text-decoration-color:var(--line);text-underline-offset:3px}a:hover{color:var(--accent)}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:end;gap:12px;margin-bottom:24px}
h1{font-size:28px;margin:0;letter-spacing:-.02em}h2{font-size:17px;margin:36px 0 12px}h3{font-size:15px;margin:8px 0 2px}
.meta{color:var(--muted);font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.tile-label{font-size:13px;color:var(--muted)}.tile-value{font-size:30px;font-weight:650;font-variant-numeric:tabular-nums}.tile-note{font-size:12px;color:var(--muted)}
ul.dues{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.due{display:flex;gap:16px;padding:12px 16px;border-top:1px solid var(--line)}.due:first-child{border-top:0}
.due-date{min-width:110px;display:flex;flex-direction:column}.due-date span{font-size:12px;color:var(--muted)}
.due.soon .due-date span{color:var(--warn);font-weight:600}.due.overdue .due-date span{color:var(--bad);font-weight:600}.due-action{font-weight:550}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:12px;padding:12px 16px}.card p{margin:6px 0 0}
.card.p-high{border-left-color:var(--bad)}.card.p-medium{border-left-color:var(--warn)}.card-top{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pill{font-size:12px;padding:1px 8px;border-radius:99px;background:var(--chip);color:var(--muted)}.due-pill{background:var(--warn-bg);color:var(--warn)}.pill.new{background:var(--accent);color:var(--surface);font-weight:600}
.prio{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.p-high .prio{color:var(--bad);font-weight:700}.todo{font-weight:550}
.empty{color:var(--muted);padding:12px 16px}
details{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:4px 16px}summary{cursor:pointer;padding:10px 0;font-weight:550}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 8px 8px 0;border-top:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:500}
.tag{font-size:12px;padding:2px 8px;border-radius:6px;white-space:nowrap}.tag.ok{background:var(--ok-bg);color:var(--ok)}.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.muted{background:var(--chip);color:var(--muted)}
.bars{display:flex;align-items:end;gap:6px;height:90px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px 26px}
.bar{flex:1;height:100%;display:flex;flex-direction:column;justify-content:end;position:relative}.bar-fill{background:var(--accent);border-radius:3px 3px 0 0;min-height:2px;opacity:.8}.bar span{position:absolute;bottom:-20px;left:0;right:0;text-align:center;font-size:11px;color:var(--muted)}
footer{margin-top:40px;font-size:12px;color:var(--muted)}
@media (max-width:560px){.due{flex-direction:column;gap:2px}h1{font-size:24px}}
</style></head><body><main>
<header><div><div class="meta">${esc(run.account)}</div><h1>Inbox brief · ${esc(fmtDate(today))}</h1></div>
</header>
<section class="tiles">
${tile('Due in 7 days', dueWeek, `${due.length} upcoming in total`)}
${tile('New important mail', run.newImportant, `of ${run.inboxCount} read since last run`)}
${tile('Spam trashed', run.spam.length, 'moved to Trash, recoverable 30 days')}
${tile('Unsubscribed', unsub, 'verified senders, one-click only')}
</section>
<h2>Due dates</h2><ul class="dues">${dueRows}</ul>
<h2>Important emails <span class="meta">last 14 days</span></h2><div class="cards">${cards}</div>
<h2>Spam cleanup</h2>
<details><summary>${run.spam.length} spam messages · ${unsub} unsubscribe${unsub === 1 ? '' : 's'}</summary>
${spamRows ? `<div class="scroll"><table><thead><tr><th>Sender</th><th>Subject</th><th>Action</th><th>Why</th></tr></thead><tbody>${spamRows}</tbody></table></div>` : '<p class="empty">Spam folder was empty.</p>'}
</details>
${hist.length > 1 ? `<h2>Spam per run</h2><div class="bars">${bars}</div>` : ''}
${run.errors.length ? `<h2>Problems</h2><ul>${run.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
<footer>Generated ${esc(new Date(run.at).toLocaleString('en-GB'))} by email-cleanup-bot · model ${esc(run.model)} (local, nothing sent to the cloud) · ${Math.round(run.seconds)}s</footer>
</main></body></html>`;
}
