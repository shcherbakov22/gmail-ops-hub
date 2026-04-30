#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rulesDir = '/var/lib/n8n/gmail-rules';
const rulesPath = path.join(rulesDir, 'learned-rules.json');
const historyPath = path.join(rulesDir, 'learned-rules.jsonl');
const validLabels = new Set(['invoice', 'receipt', 'transaction', 'newsletter', 'system-alert', 'account-security', 'personal']);

function normalizeSender(from) {
  const raw = String(from || '').trim();
  const match = raw.match(/<([^>]+)>/);
  const email = (match ? match[1] : raw).trim().toLowerCase();
  const domain = email.includes('@') ? email.split('@').pop() : '';
  return { email, domain };
}

function readRules() {
  try {
    return JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  } catch {
    return { emails: {}, domains: {}, updatedAt: null };
  }
}

function main() {
  const arg = process.argv[2] || '';
  if (!arg) {
    console.error('Usage: record-learned-rule.js <base64-json>');
    process.exit(2);
  }

  const input = JSON.parse(Buffer.from(arg, 'base64').toString('utf8'));
  if (!validLabels.has(input.label)) {
    console.error(`Invalid learned label: ${input.label}`);
    process.exit(3);
  }

  const sender = normalizeSender(input.from);
  if (!sender.domain) {
    console.error('Cannot learn rule without sender domain');
    process.exit(4);
  }

  fs.mkdirSync(rulesDir, { recursive: true });
  const rules = readRules();
  rules.domains ||= {};
  rules.emails ||= {};
  rules.domains[sender.domain] = input.label;
  rules.updatedAt = new Date().toISOString();

  const event = {
    learnedAt: rules.updatedAt,
    messageId: input.messageId,
    from: input.from,
    senderEmail: sender.email,
    senderDomain: sender.domain,
    label: input.label,
    subject: input.subject || '',
  };

  fs.writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  fs.appendFileSync(historyPath, `${JSON.stringify(event)}\n`);
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

main();
