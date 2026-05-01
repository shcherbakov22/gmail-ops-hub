#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rulesPath = path.join(__dirname, '..', 'rules', 'default-rules.json');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

function normalizeSender(from) {
  const raw = String(from || '').trim();
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

function scoreMatches(scoreboard, reasons, label, points, reason) {
  scoreboard[label] = (scoreboard[label] || 0) + points;
  reasons.push(`${label}: ${reason} (+${points})`);
}

const labelPriority = [
  'account-security',
  'invoice',
  'receipt',
  'transaction',
  'shipping',
  'travel',
  'domains-hosting',
  'cloud-dev',
  'ai-tools',
  'google-services',
  'finance',
  'support',
  'shopping',
  'promotions',
  'subscription',
  'job',
  'social',
  'community',
  'forums',
  'gaming',
  'media',
  'food-rides',
  'surveys-rewards',
  'system-alert',
  'personal',
  'newsletter',
  'needs-review',
];
const priorityByLabel = new Map(labelPriority.map((label, index) => [label, index]));

function priority(label) {
  return priorityByLabel.get(label) ?? labelPriority.length;
}

function subjectPoints(label) {
  if (label === 'account-security') return 12;
  if (['invoice', 'system-alert', 'job'].includes(label)) return 12;
  if (['receipt', 'shipping', 'transaction', 'travel'].includes(label)) return 8;
  if (label === 'support') return 5;
  return 3;
}

function bodyPoints(label) {
  if (label === 'account-security') return 6;
  if (['invoice', 'receipt', 'system-alert'].includes(label)) return 4;
  return 2;
}

function pickWinner(scoreboard) {
  const entries = Object.entries(scoreboard).sort((a, b) => {
    const scoreDelta = b[1] - a[1];
    return scoreDelta || priority(a[0]) - priority(b[0]);
  });
  if (entries.length === 0) return { label: 'needs-review', confidence: 0, ranked: [] };
  const [winner, topScore] = entries[0];
  const secondScore = entries[1]?.[1] ?? 0;
  return {
    label: topScore >= 3 ? winner : 'needs-review',
    confidence: topScore - secondScore,
    ranked: entries,
  };
}

function classifyEmail(email) {
  const sender = normalizeSender(email.from);
  const subject = String(email.subject || '').toLowerCase();
  const text = String(email.text || '').toLowerCase();
  const snippet = String(email.snippet || '').toLowerCase();
  const body = `${text}\n${snippet}`;
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const attachmentNames = attachments.map((a) => String(a.filename || '').toLowerCase());
  const attachmentMimeTypes = attachments.map((a) => String(a.mimeType || '').toLowerCase());

  const scoreboard = {};
  const reasons = [];

  for (const [label, domains] of Object.entries(rules.domains)) {
    if (domains.some((domain) => domainMatches(sender.domain, domain))) {
      const points = label === 'account-security' ? 2 : (['newsletter', 'personal'].includes(label) ? 5 : 9);
      scoreMatches(scoreboard, reasons, label, points, `sender domain matched ${sender.domain}`);
    }
  }

  for (const [label, keywords] of Object.entries(rules.subjectKeywords)) {
    if (hasAny(subject, keywords)) {
      scoreMatches(scoreboard, reasons, label, subjectPoints(label), 'subject keyword match');
    }
  }

  for (const [label, keywords] of Object.entries(rules.bodyKeywords)) {
    if (hasAny(body, keywords)) {
      scoreMatches(scoreboard, reasons, label, bodyPoints(label), 'body keyword match');
    }
  }

  for (const [label, keywords] of Object.entries(rules.attachmentNameKeywords)) {
    if (attachmentNames.some((name) => hasAny(name, keywords))) {
      scoreMatches(scoreboard, reasons, label, 2, 'attachment filename match');
    }
  }

  if (attachmentMimeTypes.includes('application/pdf') && scoreboard.invoice) {
    scoreMatches(
      scoreboard,
      reasons,
      'invoice',
      rules.signals.pdfAttachmentInvoiceBonus,
      'pdf attachment with invoice signals'
    );
  }

  if (sender.email.startsWith('noreply@') || sender.email.startsWith('no-reply@')) {
    scoreMatches(
      scoreboard,
      reasons,
      'newsletter',
      rules.signals.newsletterNoReplyBonus,
      'noreply sender pattern'
    );
  }

  if (sender.email && sender.email.includes('@') && !sender.email.startsWith('noreply@') && !sender.email.startsWith('no-reply@')) {
    scoreMatches(
      scoreboard,
      reasons,
      'personal',
      rules.signals.personalDirectSenderBonus,
      'direct sender pattern'
    );
  }

  const winner = pickWinner(scoreboard);
  const label = winner.label;
  const defaults = rules.labelDefaults[label] || rules.labelDefaults['needs-review'];

  return {
    label,
    confidence: winner.confidence,
    ranked: winner.ranked,
    reasons,
    actions: {
      archive: defaults.archive,
      star: defaults.star,
      markRead: defaults.markRead,
    },
  };
}

function main() {
  const input = fs.readFileSync(0, 'utf8').trim();
  if (!input) {
    console.error('Expected one email JSON object on stdin');
    process.exit(1);
  }

  const email = JSON.parse(input);
  const result = classifyEmail(email);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { classifyEmail };
