// Deterministic rules: which spam senders may be unsubscribed from, and which due dates are kept.
//
// Unsubscribing from real spam only confirms to the spammer that the address is live. So the bot
// unsubscribes only from senders that look like a genuine business, and only the safe way:
//  1. the mail has an RFC 8058 one-click header (List-Unsubscribe-Post: List-Unsubscribe=One-Click)
//     with an https link, so it's a single POST and no web page is ever opened,
//  2. the sender's domain is DKIM-verified by Gmail (the From domain can't be faked),
//  3. the local model says it's legitimate marketing, not a scam/phishing mail.
// Everything else in spam is just moved to Trash (Gmail empties Trash after 30 days).
import net from 'node:net';

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

/** Keeps due_date only if it's a real date and its date_source is quoted from the email. */
export function checkDue(obj, mail) {
  const src = (obj.date_source || '').trim().toLowerCase();
  const hay = `${mail.subject}\n${mail.text}`.toLowerCase().replace(/\s+/g, ' ');
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(obj.due_date || '') && !Number.isNaN(Date.parse(obj.due_date));
  if (!valid || !src || !hay.includes(src.replace(/\s+/g, ' '))) { obj.due_date = null; obj.date_source = null; }
  return obj;
}
