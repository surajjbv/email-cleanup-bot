import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDashboard } from './dashboard.js';
import { checkDue, dkimAligned, fromDomain, oneClickUrl } from './rules.js';

const H = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

test('fromDomain', () => {
  assert.equal(fromDomain('Shop <News@Mail.Shop.com>'), 'mail.shop.com');
  assert.equal(fromDomain('plain@x.org'), 'x.org');
  assert.equal(fromDomain('no address'), '');
});

test('oneClickUrl needs RFC 8058 POST header and a public https link', () => {
  const ok = H({ 'List-Unsubscribe': '<mailto:u@shop.com>, <https://shop.com/u?id=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.equal(oneClickUrl(ok), 'https://shop.com/u?id=1');
  assert.equal(oneClickUrl({ ...ok, 'list-unsubscribe-post': undefined }), null);
  assert.equal(oneClickUrl({ ...ok, 'list-unsubscribe': '<http://shop.com/u>' }), null);
  assert.equal(oneClickUrl({ ...ok, 'list-unsubscribe': '<mailto:u@shop.com>' }), null);
  assert.equal(oneClickUrl({ ...ok, 'list-unsubscribe': '<https://192.168.1.1/u>' }), null);
  assert.equal(oneClickUrl({ ...ok, 'list-unsubscribe': '<https://localhost/u>' }), null);
});

test('dkimAligned requires a passing signature from the From domain family', () => {
  const ar = (d) => ({ 'authentication-results': `mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass` });
  assert.ok(dkimAligned(ar('shop.com'), 'News <n@shop.com>'));
  assert.ok(dkimAligned(ar('shop.com'), 'n@mail.shop.com'));
  assert.ok(dkimAligned(ar('mail.shop.com'), 'n@shop.com'));
  assert.ok(!dkimAligned(ar('sendgrid.net'), 'n@shop.com'));
  assert.ok(!dkimAligned(ar('evil.co.in'), 'n@bank.co.in'));
  assert.ok(!dkimAligned({ 'authentication-results': 'mx.google.com; dkim=fail header.i=@shop.com' }, 'n@shop.com'));
  assert.ok(!dkimAligned({}, 'n@shop.com'));
});

test('checkDue keeps only dates quoted from the email', () => {
  const mail = { subject: 'Card bill', text: 'Your payment of Rs 4,200 is due on 15 Oct 2026.' };
  assert.equal(checkDue({ due_date: '2026-10-15', date_source: 'due on 15 Oct 2026' }, mail).due_date, '2026-10-15');
  assert.equal(checkDue({ due_date: '2026-10-15', date_source: 'by Friday' }, mail).due_date, null);
  assert.equal(checkDue({ due_date: 'soon', date_source: 'due on 15 Oct 2026' }, mail).due_date, null);
});

test('dashboard escapes email content', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderDashboard({
    run: { at: Date.now(), account: 'me@example.com', dryRun: true, model: 'm', inboxCount: 1, newImportant: 1, errors: [], seconds: 1,
      spam: [{ from: evil, domain: 'x.com', subject: evil, action: 'would-trash', reason: '' }],
      important: [{ id: 'a"b', ms: Date.now(), from: evil, subject: evil, summary: evil, action: evil, category: 'bill', priority: 'high', isNew: true }] },
    dueItems: [], runs: [],
  });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes("default-src 'none'"));
});
