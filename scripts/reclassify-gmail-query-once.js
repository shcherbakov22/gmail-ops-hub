#!/usr/bin/env node

const fs = require('node:fs');
const https = require('node:https');
const { classify } = require('./classify-email-for-n8n.js');

const credentialPath = process.env.GMAIL_N8N_CREDENTIAL_PATH || '/tmp/gmail-credential-decrypted.json';
const query = process.env.GMAIL_RECLASSIFY_QUERY || 'in:inbox label:auto/needs-review -in:spam -in:trash';
const pageSize = Number(process.env.GMAIL_RECLASSIFY_PAGE_SIZE || 500);
const maxPages = Number(process.env.GMAIL_RECLASSIFY_MAX_PAGES || 10);
const concurrency = Number(process.env.GMAIL_RECLASSIFY_CONCURRENCY || 12);
const typeLabelIds = [
  'Label_5', 'Label_6', 'Label_17', 'Label_18', 'Label_19', 'Label_20', 'Label_21', 'Label_22',
  'Label_23', 'Label_24', 'Label_25', 'Label_7', 'Label_8', 'Label_9', 'Label_10', 'Label_11',
  'Label_26', 'Label_27', 'Label_28', 'Label_29', 'Label_30',
  'Label_31', 'Label_32', 'Label_33', 'Label_34', 'Label_35', 'Label_36',
  'Label_37',
];

function readCredential() {
  const exported = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  const credential = Array.isArray(exported) ? exported[0] : exported;
  return credential.data;
}

function request(method, url, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': headers['content-type'] || 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }
        reject(new Error(`${method} ${url} failed ${res.statusCode}: ${text.slice(0, 500)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
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
  const response = await request('POST', 'https://oauth2.googleapis.com/token', {
    body: params.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  return response.access_token || tokenData.access_token;
}

function decodeBase64Url(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function header(headers, name) {
  const found = (headers || []).find((item) => String(item.name || '').toLowerCase() === name);
  return found?.value || '';
}

function collectParts(part, out = { text: [], html: [], attachments: [] }) {
  if (!part) return out;
  if (part.filename) out.attachments.push({ filename: part.filename, mimeType: part.mimeType || '' });
  const data = part.body?.data;
  if (data && part.mimeType === 'text/plain') out.text.push(decodeBase64Url(data));
  if (data && part.mimeType === 'text/html') out.html.push(decodeBase64Url(data));
  for (const child of part.parts || []) collectParts(child, out);
  return out;
}

function gmailToEmail(message) {
  const headers = message.payload?.headers || [];
  const parts = collectParts(message.payload);
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
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function listIds(token) {
  const ids = [];
  let pageToken = '';
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const listed = await withRetry(() => request('GET', url, { token }));
    ids.push(...(listed.messages || []).map((message) => message.id));
    console.log(`listed page=${page} ids=${ids.length}`);
    pageToken = listed.nextPageToken || '';
    if (!pageToken) break;
  }
  return [...new Set(ids)];
}

function keyFor(labels) {
  return [...new Set(labels)].sort().join(',');
}

async function main() {
  const credential = readCredential();
  const token = await refreshAccessToken(credential);
  const ids = await listIds(token);
  const totals = { listed: ids.length, changed: 0, skippedNeedsReview: 0, byLabel: {} };

  for (let offset = 0; offset < ids.length; offset += pageSize) {
    const batchIds = ids.slice(offset, offset + pageSize);
    const messages = await mapLimit(batchIds, concurrency, (id) => withRetry(() => {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      url.searchParams.set('format', 'full');
      return request('GET', url, { token });
    }));

    const groups = new Map();
    for (const message of messages) {
      const result = classify(gmailToEmail(message));
      totals.byLabel[result.label] = (totals.byLabel[result.label] || 0) + 1;
      if (result.label === 'needs-review') {
        totals.skippedNeedsReview += 1;
        continue;
      }
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
      await withRetry(() => request('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
        token,
        body: {
          ids: group.ids,
          addLabelIds: [...new Set(group.addLabelIds)],
          removeLabelIds: [...new Set(group.removeLabelIds)],
        },
      }));
      totals.changed += group.ids.length;
    }
    console.log(`processed offset=${offset} changed=${totals.changed} skippedNeedsReview=${totals.skippedNeedsReview} counts=${JSON.stringify(totals.byLabel)}`);
  }

  console.log(`complete ${JSON.stringify(totals)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
