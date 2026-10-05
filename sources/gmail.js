// Gmail API (gmail.modify: read + move to Trash) and the RFC 8058 one-click unsubscribe POST.
import { googleApi } from '../kit/google.js';
import { htmlToText } from '../rules.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const unb64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const google = googleApi();

/** The mailbox's address (for the dashboard header). */
export const profileEmail = async () => (await google(`${GMAIL}/profile`)).emailAddress;

/** Message ids matching a Gmail search, newest first, at most `max`. */
export async function searchIds(q, max) {
  const ids = [];
  let page = '';
  do {
    const r = await google(`${GMAIL}/messages?maxResults=${Math.min(100, max)}&includeSpamTrash=${/in:spam/.test(q)}&q=${encodeURIComponent(q)}${page ? `&pageToken=${page}` : ''}`);
    ids.push(...(r.messages || []).map((m) => m.id));
    page = r.nextPageToken;
  } while (page && ids.length < max);
  return ids.slice(0, max);
}

/** One message: headers (lower-case keys, repeated headers joined with ';'), from, subject, text, labels. */
export async function getMail(id) {
  const m = await google(`${GMAIL}/messages/${id}?format=full`);
  const headers = {};
  for (const h of m.payload.headers || []) {
    const k = h.name.toLowerCase();
    headers[k] = headers[k] ? `${headers[k]}; ${h.value}` : h.value;
  }
  const parts = [];
  const walk = (p) => { parts.push(p); (p.parts || []).forEach(walk); };
  walk(m.payload);
  const body = (type) => parts.find((p) => p.mimeType === type && p.body?.data);
  const plain = body('text/plain');
  const html = body('text/html');
  const text = plain ? unb64(plain.body.data).toString() : html ? htmlToText(unb64(html.body.data).toString()) : m.snippet || '';
  return {
    id, threadId: m.threadId, ms: Number(m.internalDate), labels: m.labelIds || [], headers,
    from: headers.from || '', subject: headers.subject || '(no subject)',
    text: text.split(/^On .{5,200}?wrote:\s*$/ms)[0].replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim(),
  };
}

/** Moves messages to Trash (recoverable for 30 days). Never deletes permanently. */
export async function trash(ids) {
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map((id) => google(`${GMAIL}/messages/${id}/trash`, { method: 'POST' })));
  }
}

/** RFC 8058 one-click unsubscribe: a single POST, no redirects followed, no page opened. Returns true on 2xx/3xx. */
export async function oneClickUnsubscribe(url, log) {
  try {
    const res = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
    });
    return res.status >= 200 && res.status < 400;
  } catch (err) {
    log.warn(`unsubscribe POST to ${new URL(url).hostname} failed: ${err.message}`);
    return false;
  }
}
