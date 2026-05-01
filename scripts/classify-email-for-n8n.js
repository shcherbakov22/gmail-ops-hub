#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

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
  newsletter: 'Label_7',
  'system-alert': 'Label_8',
  'account-security': 'Label_9',
  personal: 'Label_10',
  'needs-review': 'Label_11',
  processed: 'Label_12',
};
const typeLabelIds = Object.entries(labelIds)
  .filter(([label]) => label !== 'processed')
  .map(([, id]) => id);

const learnedRulesPath = '/var/lib/n8n/gmail-rules/learned-rules.json';
const bundledRulesPath = path.join(__dirname, 'rules', 'default-rules.json');
const repoRulesPath = path.join(__dirname, '..', 'rules', 'default-rules.json');
const defaultRulesPath = fs.existsSync(bundledRulesPath) ? bundledRulesPath : repoRulesPath;
const rules = JSON.parse(fs.readFileSync(defaultRulesPath, 'utf8'));

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeSender(from) {
  const raw = typeof from === 'object' && from !== null
    ? String(from.value?.[0]?.address || from.text || from.html || '').trim()
    : String(from || '').trim();
  const match = raw.match(/<([^>]+)>/);
  const email = (match ? match[1] : raw).trim().toLowerCase();
  const domain = email.includes('@') ? email.split('@').pop() : '';
  return { email, domain, raw: raw.toLowerCase() };
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function domainMatches(senderDomain, ruleDomain) {
  return senderDomain === ruleDomain || senderDomain.endsWith(`.${ruleDomain}`);
}

function score(scoreboard, reasons, label, points, reason) {
  scoreboard[label] = (scoreboard[label] || 0) + points;
  reasons.push(`${label}: ${reason} (+${points})`);
}

function classify(email) {
  const learned = readJsonIfExists(learnedRulesPath, { emails: {}, domains: {} });
  const sender = normalizeSender(email.from);
  const subject = String(email.subject || '').toLowerCase();
  const text = String(email.text || '').toLowerCase();
  const snippet = String(email.snippet || '').toLowerCase();
  const html = String(email.html || '').toLowerCase();
  const body = `${subject}\n${text}\n${snippet}\n${html.slice(0, 20000)}`;
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const attachmentNames = attachments.map((a) => String(a.filename || '').toLowerCase());
  const attachmentMimeTypes = attachments.map((a) => String(a.mimeType || '').toLowerCase());
  const scoreboard = {};
  const reasons = [];

  if (learned.emails?.[sender.email]) {
    score(scoreboard, reasons, learned.emails[sender.email], 25, `learned sender ${sender.email}`);
  }
  if (learned.domains?.[sender.domain]) {
    score(scoreboard, reasons, learned.domains[sender.domain], 20, `learned domain ${sender.domain}`);
  }

  for (const [label, domains] of Object.entries(rules.domains)) {
    const points = label === 'account-security' ? 2 : (['newsletter', 'personal'].includes(label) ? 5 : 9);
    if (domains.some((domain) => domainMatches(sender.domain, domain))) score(scoreboard, reasons, label, points, `sender domain ${sender.domain}`);
  }
  for (const [label, keywords] of Object.entries(rules.subjectKeywords)) {
    if (hasAny(subject, keywords)) score(scoreboard, reasons, label, label === 'account-security' ? 9 : 3, 'subject keyword');
  }
  for (const [label, keywords] of Object.entries(rules.bodyKeywords)) {
    if (hasAny(body, keywords)) score(scoreboard, reasons, label, label === 'account-security' ? 5 : 2, 'body keyword');
  }
  for (const [label, keywords] of Object.entries(rules.attachmentNameKeywords)) {
    if (attachmentNames.some((name) => hasAny(name, keywords))) score(scoreboard, reasons, label, 2, 'attachment filename');
  }
  if (attachmentMimeTypes.includes('application/pdf') && scoreboard.invoice) score(scoreboard, reasons, 'invoice', 2, 'pdf attachment with invoice signal');
  if (sender.email.startsWith('noreply@') || sender.email.startsWith('no-reply@')) score(scoreboard, reasons, 'newsletter', 2, 'noreply sender');
  if (sender.email.includes('@') && !sender.email.startsWith('noreply@') && !sender.email.startsWith('no-reply@')) score(scoreboard, reasons, 'personal', 2, 'direct sender');

  const ranked = Object.entries(scoreboard).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const label = top && top[1] >= 3 ? top[0] : 'needs-review';
  const confidence = top ? top[1] - secondScore : 0;
  const actions = rules.labelDefaults[label] || rules.labelDefaults['needs-review'];
  const labelsToAdd = [labelIds[label], labelIds.processed];
  const labelsToRemoveForRelabel = typeLabelIds.filter((id) => id !== labelIds[label]);
  if (actions.star) labelsToAdd.push('STARRED');
  const labelsToRemove = [];
  if (actions.archive) labelsToRemove.push('INBOX');
  if (actions.markRead) labelsToRemove.push('UNREAD');

  return {
    id: email.id,
    label,
    confidence,
    ranked,
    reasons,
    actions,
    labelsToAdd,
    labelsToRemoveForRelabel,
    labelsToRemove,
  };
}

function main() {
  const arg = process.argv[2] || '';
  if (!arg) {
    console.error('Usage: classify-email-for-n8n.js <base64-email-json>');
    process.exit(2);
  }
  const email = JSON.parse(Buffer.from(arg, 'base64').toString('utf8'));
  process.stdout.write(`${JSON.stringify(classify(email))}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { classify };
