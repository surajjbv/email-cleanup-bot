// One-time Google login: node login.js  (saves the refresh token into .env)
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, requireConfig, ROOT } from './lib.js';

// gmail.modify = read mail and move it to Trash. It can't send mail or delete permanently.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

requireConfig('googleClientId', 'googleClientSecret');
const state = crypto.randomBytes(16).toString('hex');
const server = http.createServer().listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const client = { client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: redirect };
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'select_account consent', state,
    scope: SCOPES.join(' '),
  });
  execFile('open', [url]);
  console.log(`If no browser opened, visit:\n${url}\n`);
  console.log('In the browser, sign in with the Gmail account to clean up...');
  server.on('request', async (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    if (!q.get('code') || q.get('state') !== state) return res.end('Waiting...');
    const tok = await (await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ ...client, code: q.get('code'), grant_type: 'authorization_code' }),
    })).json();
    if (!tok.refresh_token) { res.end('Failed, see terminal.'); console.error('No refresh token:', tok.error || 'unknown'); process.exit(1); }
    const envPath = path.join(ROOT, '.env');
    const env = fs.readFileSync(envPath, 'utf8');
    const line = `GOOGLE_REFRESH_TOKEN=${tok.refresh_token}`;
    fs.writeFileSync(envPath, /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line) : `${env}\n${line}\n`, { mode: 0o600 });
    res.end('Done. You can close this tab.');
    console.log('Saved the refresh token to .env.');
    process.exit(0);
  });
});
