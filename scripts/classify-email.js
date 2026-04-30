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

function scoreMatches(scoreboard, reasons, label, points, reason) {
  scoreboard[label] = (scoreboard[label] || 0) + points;
  reasons.push(`${label}: ${reason} (+${points})`);
}

function pickWinner(scoreboard) {
  const entries = Object.entries(scoreboard).sort((a, b) => b[1] - a[1]);
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
  const body = `${subject}\n${text}\n${snippet}`;
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const attachmentNames = attachments.map((a) => String(a.filename || '').toLowerCase());
  const attachmentMimeTypes = attachments.map((a) => String(a.mimeType || '').toLowerCase());

  const scoreboard = {};
  const reasons = [];

  for (const [label, domains] of Object.entries(rules.domains)) {
    if (domains.includes(sender.domain)) {
      scoreMatches(scoreboard, reasons, label, 5, `sender domain matched ${sender.domain}`);
    }
  }

  for (const [label, keywords] of Object.entries(rules.subjectKeywords)) {
    if (hasAny(subject, keywords)) {
      scoreMatches(scoreboard, reasons, label, 3, 'subject keyword match');
    }
  }

  for (const [label, keywords] of Object.entries(rules.bodyKeywords)) {
    if (hasAny(body, keywords)) {
      scoreMatches(scoreboard, reasons, label, 2, 'body keyword match');
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
