#!/usr/bin/env node

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { classify } = require('./classify-email-for-n8n.js');

const credentialPath = process.env.GMAIL_N8N_CREDENTIAL_PATH || '/tmp/gmail-credential-decrypted.json';
const query = process.env.GMAIL_CLASSIFY_QUERY || 'in:inbox -label:auto/processed -in:spam -in:trash';
const maxPages = Number(process.env.GMAIL_CLASSIFY_MAX_PAGES || 200);
const pageSize = Number(process.env.GMAIL_CLASSIFY_PAGE_SIZE || 500);
const concurrency = Number(process.env.GMAIL_CLASSIFY_CONCURRENCY || 12);

const typeLabelIds = ['Label_5', 'Label_6', 'Label_17', 'Label_7', 'Label_8', 'Label_9', 'Label_10', 'Label_11'];

function readCredential() {
  const exported = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  const credential = Array.isArray(exported) ? exported[0] : exported;
  return credential.data;
}

function requestJson(method, url, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed || {});
          return;
        }
        const error = new Error(`${method} ${url} failed ${res.statusCode}: ${text.slice(0, 500)}`);
        error.statusCode = res.statusCode;
        reject(error);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestForm(method, url, params, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(params.toString());
    const req = https.request(url, {
      method,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(payload.length),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed || {});
          return;
        }
        const error = new Error(`${method} ${url} failed ${res.statusCode}: ${text.slice(0, 500)}`);
        error.statusCode = res.statusCode;
        reject(error);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function refreshAccessToken(credential) {
  const tokenData = credential.oauthTokenData || {};
  const params = new URLSearchParams({
    client_id: credential.clientId,
    client_secret: credential.clientSecret,
    refresh_token: tokenData.refresh_token,
    grant_type: 'refresh_token',
  });
  const response = await requestForm('POST', 'https://oauth2.googleapis.com/token', params);
  return response.access_token || tokenData.access_token;
}

function decodeBase64Url(data) {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function header(headers, name) {
  const found = (headers || []).find((item) => String(item.name || '').toLowerCase() === name);
  return found?.value || '';
}

function collectParts(part, out = { text: [], html: [], attachments: [] }) {
  if (!part) return out;
  const filename = part.filename || '';
  if (filename) {
    out.attachments.push({ filename, mimeType: part.mimeType || '' });
  }
  const data = part.body?.data;
  if (data && part.mimeType === 'text/plain') out.text.push(decodeBase64Url(data));
  if (data && part.mimeType === 'text/html') out.html.push(decodeBase64Url(data));
  for (const child of part.parts || []) collectParts(child, out);
  return out;
}

function gmailToEmail(message) {
  const payload = message.payload || {};
  const headers = payload.headers || [];
  const parts = collectParts(payload);
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds || [],
    from: header(headers, 'from'),
    subject: header(headers, 'subject'),
    date: header(headers, 'date'),
    snippet: message.snippet || '',
    text: parts.text.join('\n'),
    html: parts.html.join('\n'),
    attachments: parts.attachments,
  };
}

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw last;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function keyFor(labels) {
  return [...new Set(labels)].sort().join(',');
}

async function main() {
  const credential = readCredential();
  const token = await refreshAccessToken(credential);
  const totals = { seen: 0, modified: 0, byLabel: {} };
  let pageToken = '';

  for (let page = 1; page <= maxPages; page += 1) {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', query);
    listUrl.searchParams.set('maxResults', String(pageSize));
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
    const listed = await withRetry(() => requestJson('GET', listUrl, { token }));
    const ids = (listed.messages || []).map((message) => message.id);
    if (ids.length === 0) {
      console.log(`page=${page} done empty`);
      break;
    }

    const messages = await mapLimit(ids, concurrency, (id) => withRetry(() => {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      url.searchParams.set('format', 'full');
      return requestJson('GET', url, { token });
    }));

    const groups = new Map();
    for (const message of messages) {
      const email = gmailToEmail(message);
      const result = classify(email);
      totals.seen += 1;
      totals.byLabel[result.label] = (totals.byLabel[result.label] || 0) + 1;
      const addLabelIds = result.labelsToAdd;
      const removeLabelIds = [
        ...typeLabelIds.filter((id) => id !== result.labelsToAdd[0]),
        ...(result.labelsToRemove || []),
      ];
      const key = `${keyFor(addLabelIds)}|${keyFor(removeLabelIds)}`;
      if (!groups.has(key)) groups.set(key, { ids: [], addLabelIds, removeLabelIds });
      groups.get(key).ids.push(message.id);
    }

    for (const group of groups.values()) {
      await withRetry(() => requestJson(
        'POST',
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify',
        {
          token,
          body: {
            ids: group.ids,
            addLabelIds: [...new Set(group.addLabelIds)],
            removeLabelIds: [...new Set(group.removeLabelIds)],
          },
        },
      ));
      totals.modified += group.ids.length;
    }

    console.log(`page=${page} fetched=${ids.length} modified=${totals.modified} counts=${JSON.stringify(totals.byLabel)}`);
    pageToken = listed.nextPageToken || '';
    if (!pageToken) break;
  }

  console.log(`complete seen=${totals.seen} modified=${totals.modified} counts=${JSON.stringify(totals.byLabel)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
