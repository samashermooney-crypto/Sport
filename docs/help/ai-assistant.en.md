---
title: 'AI assistance'
summary: 'Optional AI features: form drafting, translation, and a family help assistant — and how to turn them on.'
category: 'AI features'
audience: 'admin'
order: 30
---

# AI assistance

Athlentry includes optional AI features. They remain **off unless the platform operator configures an AI provider and enables the feature**. When they are off, AI controls are hidden and no AI request is made.

## What AI can do

- **Draft forms from documents** — upload a PDF, Word, or text file and AI prepares a form draft. Review it before saving; it is never applied automatically.
- **Translate text** — translate text between English and Spanish, then edit it before use.
- **Family help assistant** — when your organization has public programs, a chat assistant answers general questions using public program and facility details and family help articles. It cites the source. It refuses questions about a specific child, account balance, payment, or medical matter.

## Privacy

- Email addresses and phone numbers are redacted from prompts, saved drafts, translations, and assistant answers.
- Assistant conversations are kept for at most 30 days, then deleted.
- Each request records its organization, feature, model, token counts, redaction count, and outcome.
- Monthly usage limits follow the organization's plan; short bursts are also limited.

## Turning it on

AI is enabled per environment by the platform operator. It requires `AI_PROVIDER=anthropic` and an Anthropic API key. When available, staff form drafting and translation are in AI assistance; families see the assistant in Help only when public program content is available.
