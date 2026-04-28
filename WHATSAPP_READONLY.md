# WhatsApp Read-Only Context Plan

This is a future plan, not an implemented integration.

Goal: let Boop search or summarize WhatsApp history without automating WhatsApp Web, reverse-engineering the client, or sending raw private chats to cloud models.

## Non-goals

- Do not use WhatsApp Web automation, Selenium, Puppeteer, Baileys, `whatsapp-web.js`, or other reverse-engineered clients.
- Do not connect to a personal WhatsApp account programmatically.
- Do not send raw WhatsApp exports directly to Claude, OpenAI, or any other cloud model.
- Do not make WhatsApp the live primary channel for a general-purpose AI assistant.

Those paths are risky for account bans and privacy. Official programmatic WhatsApp access is for the WhatsApp Business Platform, not personal account read access.

## Safe Input Source

Use manual WhatsApp chat exports:

1. Export a chat from WhatsApp as `.txt` or `.zip`.
2. Import that file into Boop locally.
3. Parse and normalize messages into a local store.
4. Run privacy redaction before any model sees the content.

This gives read-only context without touching WhatsApp's live client.

## Proposed Pipeline

```txt
WhatsApp export (.txt/.zip)
        |
        v
local parser
        |
        v
raw local store
        |
        v
deterministic redaction
        |
        v
optional local classifier
        |
        v
redacted searchable store
        |
        v
Boop tool returns redacted snippets/summaries only
```

The raw store should stay local. Agent tools should read from the redacted store by default.

## Privacy Filter

Run deterministic redaction first:

- Phone numbers
- Emails
- Addresses
- CPF/CNPJ-like IDs
- Credit-card-like numbers
- URLs with private tokens
- Passwords, OTPs, recovery codes
- Bank/account/payment references where detectable

Then run a sensitivity classifier. Initially this can be rules-based. Later it can be a local model such as Gemma.

Sensitive categories to drop or heavily summarize:

- Health
- Relationship/family/private life
- Financial details
- Legal issues
- Passwords/secrets
- Exact home/work addresses
- Private third-party information
- Anything involving minors

## Model Boundary

Cloud models may receive only:

- Redacted snippets
- Redacted summaries
- Aggregate metadata
- Search hits with sensitive spans removed

Cloud models must not receive:

- Raw exported chat files
- Full unredacted conversations
- Phone numbers or identifying details unless explicitly allowlisted
- Secrets, codes, payment details, or private addresses

## Future Local Model Option

Gemma or another local model can be added later as a second-stage classifier:

```txt
regex redaction -> local Gemma sensitivity classifier -> redacted store
```

Keep regex redaction first even if a local model is used. Local classifiers can miss exact identifiers; deterministic filters are cheaper and more predictable.

## Possible Implementation Shape

- `scripts/import-whatsapp.ts`
  - accepts `.txt` or `.zip`
  - detects WhatsApp export format
  - parses messages into normalized records

- `server/privacy/redact.ts`
  - deterministic redaction rules
  - returns redacted text plus redaction metadata

- `server/privacy/classify.ts`
  - rules-based sensitivity labels first
  - optional local model backend later

- Local store
  - raw import: local-only, never exposed to agent tools by default
  - redacted index: safe default for agent tools

- Agent tool
  - `search_whatsapp_export(query)`
  - returns redacted snippets and dates only
  - refuses raw export access

## Example Redacted Output

```txt
[2026-04-20] CONTACT_A: asked about meeting availability.
[2026-04-21] CONTACT_B: mentioned a work deadline.
[redacted: relationship/private life]
[redacted: financial details]
```

## Open Questions Before Building

- Should raw imports be stored at all, or should Boop discard raw messages after generating the redacted store?
- Should contact names be preserved, hashed, or mapped to aliases like `CONTACT_A`?
- Should the importer support only one-on-one chats first, or group chats too?
- Should redacted WhatsApp context be merged into Boop memory, or kept in a separate searchable store?
- Should the default classifier be strict enough to drop more context than necessary?
