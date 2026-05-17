#!/usr/bin/env node

const fs = require('node:fs');
const https = require('node:https');
const { classify } = require('./classify-email-for-n8n.js');

const credentialPath = process.env.GMAIL_N8N_CREDENTIAL_PATH || '/tmp/gmail-credential-decrypted.json';
const query = process.env.GMAIL_AUDIT_QUERY || 'in:anywhere -in:spam -in:trash';
const pageSize = Number(process.env.GMAIL_AUDIT_PAGE_SIZE || 250);
const maxPages = Number(process.env.GMAIL_AUDIT_MAX_PAGES || 200);
const concurrency = Number(process.env.GMAIL_AUDIT_CONCURRENCY || 3);
const fix = process.env.GMAIL_AUDIT_FIX === '1';
const maxExamples = Number(process.env.GMAIL_AUDIT_MAX_EXAMPLES || 40);

const labelIds = {
  invoice: 'Label_5',
  receipt: 'Label_6',
  transaction: 'Label_17',
  shipping: 'Label_18',
  shopping: 'Label_19',
  travel: 'Label_20',
  support: 'Label_21',
  education: 'Label_22',
  job: 'Label_23',
  social: 'Label_24',
  subscription: 'Label_25',
  'cloud-dev': 'Label_26',
  gaming: 'Label_27',
  promotions: 'Label_28',
  finance: 'Label_29',
  community: 'Label_30',
  'ai-tools': 'Label_31',
  media: 'Label_32',
  'food-rides': 'Label_33',
  'surveys-rewards': 'Label_34',
  'domains-hosting': 'Label_35',
  forums: 'Label_36',
  'google-services': 'Label_37',
  newsletter: 'Label_7',
  'system-alert': 'Label_8',
  'account-security': 'Label_9',
  personal: 'Label_10',
  'needs-review': 'Label_11',
  processed: 'Label_12',
};

const idToLabel = Object.fromEntries(Object.entries(labelIds).map(([label, id]) => [id, label]));
const typeLabelIds = Object.entries(labelIds)
  .filter(([label]) => label !== 'processed')
  .map(([, id]) => id);

function readCredential() {
  const exported = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  const credential = Array.isArray(exported) ? exported[0] : exported;
  return credential.data;
}

function retryAfterMs(headers) {
  const raw = headers['retry-after'];
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
}

function retryAfterFromBodyMs(body) {
  const message = body?.error?.message || '';
  const match = String(message).match(/Retry after ([0-9T:.-]+Z)/);
  if (!match) return 0;
  const dateMs = Date.parse(match[1]);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
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
        const error = new Error(`${method} ${url} failed ${res.statusCode}: ${text.slice(0, 500)}`);
        error.statusCode = res.statusCode;
        error.retryAfterMs = retryAfterMs(res.headers) || retryAfterFromBodyMs(parsed);
        error.body = parsed;
        reject(error);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, tries = 8) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const waitMs = error.retryAfterMs || Math.min(60000, 2000 * (i + 1));
      console.error(`retryable error: ${error.message.split('\n')[0]} waitMs=${waitMs}`);
      await sleep(waitMs);
    }
  }
  throw last;
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

function currentTypeLabels(message) {
  return (message.labelIds || []).filter((id) => typeLabelIds.includes(id)).map((id) => idToLabel[id]);
}

function keyFor(labels) {
  return [...new Set(labels)].sort().join(',');
}

function exampleFor(message, email, result, current) {
  return {
    id: message.id,
    current,
    predicted: result.label,
    confidence: result.confidence,
    from: email.from,
    subject: email.subject,
    date: email.date,
    reasons: result.reasons.slice(0, 8),
    ranked: result.ranked.slice(0, 6),
  };
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

async function main() {
  const token = await refreshAccessToken(readCredential());
  const ids = await listIds(token);
  const totals = {
    query,
    fix,
    listed: ids.length,
    checked: 0,
    fixed: 0,
    conflicts: 0,
    predictedNeedsReview: 0,
    multipleTypeLabels: 0,
    missingTypeLabel: 0,
    byPredictedLabel: {},
    examples: [],
  };

  for (let offset = 0; offset < ids.length; offset += pageSize) {
    const batchIds = ids.slice(offset, offset + pageSize);
    const messages = await mapLimit(batchIds, concurrency, (id) => withRetry(() => {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      url.searchParams.set('format', 'full');
      return request('GET', url, { token });
    }));

    const groups = new Map();
    for (const message of messages) {
      totals.checked += 1;
      const email = gmailToEmail(message);
      const result = classify(email);
      const current = currentTypeLabels(message);
      totals.byPredictedLabel[result.label] = (totals.byPredictedLabel[result.label] || 0) + 1;
      if (current.length === 0) totals.missingTypeLabel += 1;
      if (current.length > 1) totals.multipleTypeLabels += 1;
      const mismatch = current.length !== 1 || current[0] !== result.label;
      if (!mismatch) continue;

      totals.conflicts += 1;
      if (result.label === 'needs-review') totals.predictedNeedsReview += 1;
      if (totals.examples.length < maxExamples) totals.examples.push(exampleFor(message, email, result, current));
      if (!fix || result.label === 'needs-review') continue;

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
      totals.fixed += group.ids.length;
    }

    console.log(`checked offset=${offset} checked=${totals.checked} conflicts=${totals.conflicts} fixed=${totals.fixed} predictedNeedsReview=${totals.predictedNeedsReview}`);
  }

  console.log(`complete ${JSON.stringify(totals, null, 2)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
