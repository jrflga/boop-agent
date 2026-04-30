---
name: debug-paizao-error
description: Diagnose why the prod Boop bot (paizao at paizao.jardim.dev.br) replied with the canonical error fallback ("Foi mal — tive um erro processando isso..."). Pulls PM2 logs from the VPS, classifies the failure, and points at the fix. Use when the user reports the bot is broken or silent.
---

# About

When paizao replies with the literal string

> Foi mal — tive um erro processando isso. Tenta de novo daqui a pouco.

that is the catch-all fallback in `server/interaction-agent.ts` (the
`} catch (err) {` around the `query(...)` loop). The real error is in
the PM2 stderr on the VPS. This skill walks through the diagnosis fast
so the user does not have to remember the SSH path.

A second failure mode is **silence**: user sends a message and the bot
never replies. The dispatcher might never be reached if Telegram cannot
deliver the webhook, the chat id is not allowed, or the webhook secret
header does not match.

This skill covers both.

## Inputs you may have

- A rough timestamp ("a 5 min atrás", "agora pouco", "às 22:56").
- A turn id from the user's report (rare — they usually do not see it).
- The literal user message (sometimes useful to grep against).

If you have nothing, scope the search to the last 200 lines of stderr.

## Step 1: pull the recent error window

Run in parallel:

```bash
ssh jardim-vps 'pm2 logs paizao --lines 200 --nostream --err 2>&1' | tail -80
ssh jardim-vps 'pm2 logs paizao --lines 200 --nostream 2>&1 | grep -E "(\[turn |query failed|memory.extract|listening on|spawn|integration)"'
```

If you have a timestamp, also pull the journal-style log file directly:

```bash
ssh jardim-vps 'tail -200 /root/.pm2/logs/paizao-error.log /root/.pm2/logs/paizao-out.log'
```

## Step 2: classify the failure

Match the stderr against these signatures. The most common cases first:

| Signature | Likely cause | Fix |
|---|---|---|
| `Claude Code process exited with code 1` from `ProcessTransport.getProcessExitError` | The `claude` CLI that the Claude Agent SDK spawns is missing or unauthed. | See "Fix: Claude CLI missing or unauthed" below. |
| `query failed Error: 401` / `403` from Anthropic | Subscription token expired, or `ANTHROPIC_API_KEY` invalid. | Re-login `claude` CLI on VPS, or rotate API key. |
| `query failed Error: 429` | Rate limit / quota exhausted. | Wait, or upgrade plan, or set a budget cap. |
| `Convex error` / `ConvexError` / `ECONNREFUSED <convex-host>` | Convex client cannot reach the deploy. | Verify `CONVEX_URL` in `/opt/boop-agent/.env.local`; curl it. |
| `Composio` errors (`COMPOSIO_*`, 401/403 on a toolkit) | Connected account expired or revoked. | Re-auth the toolkit via the debug dashboard at https://paizao.jardim.dev.br + `/composio/...` (admin-token gated). |
| `ECONNREFUSED 127.0.0.1:3456` from Caddy | Boop server is down. | `ssh jardim-vps 'pm2 restart paizao'`. |
| `[telegram] missing TELEGRAM_WEBHOOK_SECRET` | Env var not loaded. | Confirm `/opt/boop-agent/.env.local` has it set; check pm2 inherits cwd correctly. |
| `webhook` returning 401 to Telegram (visible in `paizao-out.log`) | Webhook secret header mismatch (re-registered with a different secret). | See "Fix: Re-register Telegram webhook" below. |
| Silent — no logs around the user message timestamp | Telegram is not delivering. | See "Fix: silence — webhook not delivering" below. |
| `ERR_MODULE_NOT_FOUND` for a Convex generated path | `convex/_generated/` missing on VPS (was gitignored). | rsync from local: `rsync -a /Users/jrflga/boop-agent/convex/_generated/ jardim-vps:/opt/boop-agent/convex/_generated/` then `pm2 restart paizao`. |

## Step 3: confirm with Convex if a turn id or agent id is identifiable

When the stderr line includes `[turn XXXXXX]`, the turn id is the suffix
of `turn_<random>`. To find related agent logs:

```bash
# Find the agent that ran for this conversation around that time
pnpm exec convex run agents:listByConversation '{"conversationId":"telegram:<chat-id>","limit":5}' 2>&1 | tail -30

# Then logs for the failing agent
pnpm exec convex run agentLogs:byAgent '{"agentId":"<agent-id>"}' 2>&1 | tail -40
```

The `agentLogs` rows include `tool_use` / `tool_result` / `error` block
content trimmed to 2000 chars per row — usually enough to see what the
spawn was doing when it died.

## Step 4: report

Write a short triaged summary to the user:

1. **Class:** what category of failure (CLI / auth / convex / integration / silence).
2. **Evidence:** one or two lines from stderr (verbatim, in a code block).
3. **Probable fix:** the matching row from the table.
4. **Action:** offer to run the fix recipe; do not run a pm2 restart or env-var change without confirmation.

Keep the summary tight. Three to six lines. The user does not need the
full stack trace pasted back — they just need to know what to do next.

---

## Fix recipes

### Claude CLI missing or unauthed

The Claude Agent SDK spawns `claude` (the Claude Code CLI) under the
hood. On a fresh VPS the binary is not installed, so the SDK exits 1
the moment any agent runs.

Check first:

```bash
ssh jardim-vps 'which claude; claude --version 2>&1 | head -3'
```

If `command not found` — install it. Two paths, pick with the user:

**A. Subscription auth (matches the user's Max5x plan, no per-call $).**

```bash
ssh jardim-vps 'npm install -g @anthropic-ai/claude-code'
# then interactive login (needs a TTY):
ssh -t jardim-vps 'claude login'
```

The OAuth flow prints a URL the user opens in their local browser; the
callback redirects to `localhost`, so they need to copy the resulting
code back into the SSH session manually. Painful but works.

**B. API key (off-plan, billed per token).**

Create a key at https://console.anthropic.com/settings/keys then:

```bash
ssh jardim-vps 'echo "ANTHROPIC_API_KEY=sk-ant-..." >> /opt/boop-agent/.env.local && pm2 restart paizao'
```

The user is on Max5x — they will probably not want this unless option
A is too painful. Confirm before running.

After either fix, verify by sending a test message via `/chat`:

```bash
ssh jardim-vps 'curl -sS -X POST http://localhost:3456/chat \
  -H "Authorization: Bearer $(grep ^ADMIN_TOKEN= /opt/boop-agent/.env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"smoke:cli-fix\",\"content\":\"diga ola\"}" --max-time 30'
```

(Note: this command reads the admin token from .env.local on the VPS
and pipes it into curl on the VPS — the token never leaves the VPS, so
it does not show up in the Claude Code transcript. Do not pull it back
to local.)

### Re-register Telegram webhook

```bash
ssh jardim-vps 'cd /opt/boop-agent && node scripts/telegram-webhook.mjs https://paizao.jardim.dev.br/telegram/webhook'
```

The script reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`
from `.env.local` and posts to `setWebhook`. Output should be:

```
[webhook] registered https://paizao.jardim.dev.br/telegram/webhook
```

### Silence — webhook not delivering

Run from the user's machine (not the VPS) to ask Telegram what it
thinks the webhook state is. This requires the bot token, so prompt
the user to paste the output rather than reading the secret yourself:

> "Roda isto em um terminal local seu e me cola o output:
>  `curl -s 'https://api.telegram.org/bot<TOKEN>/getWebhookInfo' | jq`"

Look at:

- `result.url` — should be `https://paizao.jardim.dev.br/telegram/webhook`.
- `result.last_error_message` — usually the smoking gun ("Wrong response from the webhook: 401 Unauthorized" → secret mismatch; "SSL error" → cert issue; "Bad webhook: connection refused" → server down).
- `result.pending_update_count` — high means Telegram is queuing because the bot is failing to ack.

Also:

- Confirm chat id is in the allowlist:
  ```bash
  ssh jardim-vps 'grep ^TELEGRAM_ALLOWED_CHAT_IDS= /opt/boop-agent/.env.local | wc -c'
  ```
  Compare against the user's reported chat id (they can get it from `@userinfobot` on Telegram).

- Confirm Caddy is up:
  ```bash
  ssh jardim-vps 'systemctl is-active caddy; curl -sS https://paizao.jardim.dev.br/health'
  ```

---

## Trigger this skill from inside the bot? (future work)

Right now this skill only runs from local Claude Code in the repo
directory. The user asked whether it could be triggered from the bot
itself ("paizao, qual foi o último erro?"). Today no — the catch block
that emits the fallback already runs in the failed turn, so any
self-introspection from inside that same turn would also fail.

Sketch of what would unlock it (not implemented):

1. **Self-tool `recent_errors`** in `server/self-tools.ts`. Reads the
   last N lines of `/root/.pm2/logs/paizao-error.log` via a thin CLI
   wrapper or via a tail-like SSE endpoint on the same Express app.
   Exposed only to the dispatcher, gated by `ADMIN_TOKEN`. Then the
   user types "qual foi o último erro?" and the dispatcher calls this
   tool instead of spawning an agent. The dispatcher LLM call itself
   must succeed — only the spawn-side failures are surfaceable this
   way.

2. **HTTP endpoint** `/admin/recent-errors` reading `paizao-error.log`,
   gated by `ADMIN_TOKEN`. The user could `curl` it from anywhere with
   the token. Bot-side integration is then optional.

3. **Cron broadcast** that posts a Telegram message when stderr grows
   by N lines in a minute. Less surgical but catches the failures the
   user does not notice.

If the user later confirms which of (1) (2) (3) they want, lift the
chosen item out of this skill into a plan via writing-plans, then
ship.
