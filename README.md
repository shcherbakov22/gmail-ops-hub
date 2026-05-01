# Gmail Ops Hub

Gmail-first personal email automation for `n8n`.

This package is designed for one person using Gmail as the only UI. The automation adds structure around the inbox instead of replacing it.

## Goal

Classify new mail into operational types and apply Gmail actions automatically:

- add a type label
- archive low-value mail
- star high-priority mail
- keep uncertain mail visible with a review label
- optionally send a daily digest later

## Initial Label Set

Create these Gmail labels:

- `auto/invoice`
- `auto/receipt`
- `auto/transaction`
- `auto/shipping`
- `auto/shopping`
- `auto/travel`
- `auto/support`
- `auto/education`
- `auto/job`
- `auto/social`
- `auto/subscription`
- `auto/cloud-dev`
- `auto/gaming`
- `auto/promotions`
- `auto/finance`
- `auto/community`
- `auto/newsletter`
- `auto/system-alert`
- `auto/account-security`
- `auto/personal`
- `auto/needs-review`
- `auto/processed`
- `auto/error`
- `auto/attachment-saved`
- `auto/learn`
- `auto/rule-learned`

`auto/processed` is operational only. It prevents duplicate handling and gives you a simple Gmail search for "already touched by automation".

## Default Behavior

- `newsletter`
  - add `auto/newsletter`
  - add `auto/processed`
  - archive
  - mark read
- `receipt`
  - add `auto/receipt`
  - add `auto/processed`
  - keep in inbox
- `transaction`
  - add `auto/transaction`
  - add `auto/processed`
  - keep in inbox
- `shipping`
  - add `auto/shipping`
  - add `auto/processed`
  - keep in inbox
- `shopping`
  - add `auto/shopping`
  - add `auto/processed`
  - keep in inbox
- `travel`
  - add `auto/travel`
  - add `auto/processed`
  - keep in inbox
  - star
- `support`
  - add `auto/support`
  - add `auto/processed`
  - keep in inbox
  - star
- `education`
  - add `auto/education`
  - add `auto/processed`
  - keep in inbox
- `job`
  - add `auto/job`
  - add `auto/processed`
  - keep in inbox
  - star
- `social`
  - add `auto/social`
  - add `auto/processed`
  - archive
  - mark read
- `subscription`
  - add `auto/subscription`
  - add `auto/processed`
  - keep in inbox
- `cloud-dev`
  - add `auto/cloud-dev`
  - add `auto/processed`
  - keep in inbox
- `gaming`
  - add `auto/gaming`
  - add `auto/processed`
  - archive
  - mark read
- `promotions`
  - add `auto/promotions`
  - add `auto/processed`
  - archive
  - mark read
- `finance`
  - add `auto/finance`
  - add `auto/processed`
  - keep in inbox
  - star
- `community`
  - add `auto/community`
  - add `auto/processed`
  - archive
  - mark read
- `invoice`
  - add `auto/invoice`
  - add `auto/processed`
  - keep in inbox
  - star
- `system-alert`
  - add `auto/system-alert`
  - add `auto/processed`
  - keep in inbox
  - star
- `account-security`
  - add `auto/account-security`
  - add `auto/processed`
  - keep in inbox
  - star
- `personal`
  - add `auto/personal`
  - add `auto/processed`
  - keep in inbox
- `needs-review`
  - add `auto/needs-review`
  - add `auto/processed`
  - keep in inbox

## Workflow Set

This package is split into three parts:

1. `WORKFLOW_DESIGN.md`
   - node-by-node build plan for the actual `n8n` workflows
2. `rules/default-rules.json`
   - deterministic rule lists and action defaults
3. `scripts/classify-email.js`
   - local classifier implementation you can test before pasting the logic into an `n8n` Code node

Live workflows imported into `n8n`:

- `Gmail Ops Hub - New Mail Triage`
  - active
  - handles new Gmail messages
- `Gmail Ops Hub - Auto Catch-Up Backfill`
  - active
  - every 5 minutes, searches recent Gmail mail without `auto/processed`
  - handles mail received while n8n or the machine was offline/asleep
- `Gmail Ops Hub - OpenRouter Needs Review Fallback`
  - active
  - checks `auto/needs-review` every 15 minutes through OpenRouter `openai/gpt-oss-120b:free`
- `Gmail Ops Hub - Daily Digest`
  - active
  - sends a daily Gmail summary at 09:00
- `Gmail Ops Hub - Save Invoice Receipt Attachments`
  - active
  - saves invoice/receipt attachments to `/var/lib/n8n/gmail-attachments`
- `Gmail Ops Hub - Failure Alerts`
  - active
  - sends a Gmail alert when configured Gmail ops workflows fail
- `Gmail Ops Hub - Learn From Corrections`
  - active
  - learns sender-domain rules from messages tagged `auto/learn`
- `Gmail Ops Hub - Manual Backfill`
  - inactive by design
  - run manually when you want to process recent old mail
- `Gmail Ops Hub - Bootstrap Labels`
  - inactive after initial setup
- `Gmail Ops Hub - Create Error Label`
  - inactive after initial setup
- `Gmail Ops Hub - Create Attachment Saved Label`
  - inactive after initial setup
- `Gmail Ops Hub - Create Learning Labels`
  - inactive after initial setup

## Current Decisions

- Gmail OAuth credential is configured as `Gmail account`
- receipts stay in the inbox
- transaction/payment activity stays in the inbox
- daily digest is enabled
- OpenRouter fallback is enabled locally

## Future Tuning

- add more sender/domain rules after a few days of real mail
- to teach the classifier, correct the message's `auto/*` type label in Gmail, then add `auto/learn`
- learned rules are stored in `/var/lib/n8n/gmail-rules/learned-rules.json`
- run manual backfill when ready

## Local Testing

The classifier script reads one email JSON object from stdin.

Example:

```bash
cat sample.json | node /home/q/n8n-projects/gmail-ops-hub/scripts/classify-email.js
```

Expected input shape:

```json
{
  "from": "Amazon <shipment-tracking@amazon.com>",
  "subject": "Your receipt is ready",
  "text": "Thanks for your order",
  "snippet": "Thanks for your order",
  "attachments": [
    { "filename": "receipt.pdf", "mimeType": "application/pdf" }
  ]
}
```
