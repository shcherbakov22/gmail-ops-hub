# Workflow Design

This is the concrete `n8n` build shape for a Gmail-first personal triage setup.

## Workflow 1: Bootstrap Labels

Purpose:

- create the Gmail labels once

Suggested nodes:

1. `Manual Trigger`
2. `Code`
   - output one item per label name
3. `Gmail`
   - resource: `label`
   - operation: `create`
   - name: `={{ $json.name }}`

Code output:

```js
return [
  { json: { name: 'auto/invoice' } },
  { json: { name: 'auto/receipt' } },
  { json: { name: 'auto/newsletter' } },
  { json: { name: 'auto/system-alert' } },
  { json: { name: 'auto/account-security' } },
  { json: { name: 'auto/personal' } },
  { json: { name: 'auto/needs-review' } },
  { json: { name: 'auto/processed' } },
];
```

Notes:

- Gmail will reject duplicates. That is acceptable.
- Run this once after the Gmail credential is connected.

## Workflow 2: New Mail Triage

Purpose:

- classify each new email
- apply labels and inbox/star behavior

### Trigger

Use `Gmail Trigger` with:

- authentication: Gmail OAuth2
- simplify: `false`
- query:
  - `-label:auto/processed -in:spam -in:trash`
- read status:
  - `both`

Reason:

- `simplify=false` gives full body fields, headers, subject, and attachment metadata
- excluding `auto/processed` prevents rework

### Node Layout

1. `Gmail Trigger`
2. `Code` named `Normalize Email`
3. `Code` named `Classify Email`
4. `If` named `Needs Custom Label`
5. `Gmail` named `Add Type Label`
6. `Gmail` named `Add Processed Label`
7. `If` named `Should Star`
8. `Gmail` named `Add Star`
9. `If` named `Should Archive`
10. `Gmail` named `Remove Inbox`
11. `If` named `Should Mark Read`
12. `Gmail` named `Mark Read`

### Normalize Email

Purpose:

- clean up raw Gmail output into stable fields for rule logic

Code outline:

```js
const item = $json;
const from = item.from ?? '';
const subject = item.subject ?? '';
const text = item.text ?? '';
const snippet = item.snippet ?? '';
const html = item.html ?? '';
const attachments = Array.isArray(item.attachments) ? item.attachments : [];

const senderEmailMatch = from.match(/<([^>]+)>/);
const senderEmail = (senderEmailMatch?.[1] ?? from).trim().toLowerCase();
const senderDomain = senderEmail.includes('@') ? senderEmail.split('@').pop() : '';

return [{
  json: {
    ...item,
    normalized: {
      senderEmail,
      senderDomain,
      fromLower: from.toLowerCase(),
      subjectLower: subject.toLowerCase(),
      textLower: text.toLowerCase(),
      snippetLower: snippet.toLowerCase(),
      htmlLower: html.toLowerCase(),
      attachmentNames: attachments.map((a) => (a.filename ?? '').toLowerCase()),
      attachmentMimeTypes: attachments.map((a) => (a.mimeType ?? '').toLowerCase()),
    },
  },
}];
```

### Classify Email

Paste the logic from:

- `/home/q/n8n-projects/gmail-ops-hub/scripts/classify-email.js`

Expected output fields:

- `label`
- `confidence`
- `reasons`
- `actions.archive`
- `actions.star`
- `actions.markRead`

### Label Application

The workflow should add:

- one type label, for example `auto/newsletter`
- one operational label: `auto/processed`

Important implementation detail:

- Gmail add-label operations need label IDs, not just display names.
- The clean approach is:
  - first run the bootstrap workflow
  - then add a small lookup table in the `Classify Email` code node mapping label names to Gmail label IDs

This is the one part that needs live Gmail credential data, so I am not hardcoding fake IDs here.

Minimal label map structure:

```js
const labelIds = {
  'auto/invoice': 'Label_123',
  'auto/receipt': 'Label_124',
  'auto/newsletter': 'Label_125',
  'auto/system-alert': 'Label_126',
  'auto/account-security': 'Label_127',
  'auto/personal': 'Label_128',
  'auto/needs-review': 'Label_129',
  'auto/processed': 'Label_130',
};
```

Built-in Gmail labels can be used directly:

- `INBOX`
- `STARRED`

### Conditions

`Should Star`

- true when `={{ $json.actions.star === true }}`

`Should Archive`

- true when `={{ $json.actions.archive === true }}`

`Should Mark Read`

- true when `={{ $json.actions.markRead === true }}`

### Behavior Summary

- custom labels classify mail
- `auto/processed` marks that the workflow handled the item
- removing `INBOX` acts as archive
- adding `STARRED` surfaces important mail

## Workflow 3: Daily Review Digest

Purpose:

- once a day, summarize:
  - `auto/needs-review`
  - `auto/account-security`
  - `auto/system-alert`
  - any new `auto/invoice`

Suggested nodes:

1. `Schedule Trigger`
   - daily, for example `09:00`
2. `Gmail`
   - resource: `message`
   - operation: `getAll`
   - query:
     - `(label:auto/needs-review OR label:auto/account-security OR label:auto/system-alert OR label:auto/invoice) newer_than:1d`
   - simplify: `true`
3. `Code`
   - render a plain-text digest body
4. `Gmail`
   - resource: `message`
   - operation: `send`
   - send to yourself

## Rule Tuning Process

Do not over-engineer this at the start.

Tuning loop:

1. let it run for several days
2. search Gmail for `label:auto/needs-review`
3. identify obvious misses
4. update `rules/default-rules.json`
5. paste the revised rules into the classifier code

## Why This Design

- Gmail stays the only UI
- automation is visible and reversible
- the rule engine stays deterministic at first
- low-value mail leaves the inbox
- high-value mail is surfaced without custom software
