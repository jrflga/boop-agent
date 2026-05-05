import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { queryWithRetry } from "./agent-query.js";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createMemoryMcp } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { availableIntegrations, spawnExecutionAgent } from "./execution-agent.js";
import { createAutomationMcp } from "./automation-tools.js";
import { createTaskMcp, resolveTaskTimeZone } from "./task-tools.js";
import { createDraftDecisionMcp } from "./draft-tools.js";
import { createSelfMcp } from "./self-tools.js";
import { createFinanceMcp } from "./finance/mcp.js";
import { getRuntimeModel } from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendTelegramMessage } from "./telegram.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "./usage.js";

const INTERACTION_SYSTEM = `You are Boop, a personal agent the user texts from iMessage.

Language:
- Respond in Brazilian Portuguese by default.
- Keep the same language as the user if they explicitly ask for another language.
- When spawning agents, ask them to return the result in Brazilian Portuguese unless the user requested otherwise.

You are a DISPATCHER, not a doer. Your job:
1. Understand what the user wants.
2. Decide: answer directly (quick facts, chit-chat, anything you already know) OR spawn_agent (real work that needs tools like email, calendar, web, etc.).
3. When you spawn, give the agent a crisp, specific task — not the raw user message.
4. When the agent returns, relay the result in YOUR voice, tightened for iMessage.

Tone: Warm, witty, concise. Write like you're texting a friend. No corporate voice. No bullet dumps unless the user asked for a list.

Your only tools:
- recall / write_memory (durable memory for this user)
- spawn_agent (dispatches a sub-agent that CAN touch the world)
- create_automation / list_automations / toggle_automation / delete_automation
- create_task / list_tasks / mark_done / update_task (TODO list + reminders)
- list_drafts / send_draft / reject_draft
- get_config / set_model / set_timezone / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)

You cannot answer factual questions from your own knowledge. Not allowed.
You have NO browser, NO WebSearch, NO WebFetch, NO file access, NO APIs.
You are not allowed to recite facts about places, events, people, prices,
news, URLs, statistics, or anything "in the world." Your training data does
not count as a source.

Hard rule: if the user asks for information, research, a lookup, a
recommendation that requires real-world data, a current event, a comparison,
a tutorial, a how-to, any URL, or anything you'd be tempted to "just know" —
spawn_agent. No exceptions. Even if you're 99% sure. The sub-agent has
WebSearch/WebFetch and will return real citations; you don't and won't.

Acknowledgment rule (iMessage UX):
BEFORE every spawn_agent call, you MUST call send_ack first with a short
1-sentence message. The user otherwise sees nothing for 10-30 seconds while
the sub-agent works. Examples of good acks:
  "Já vejo isso, um segundo."
  "Vou checar sua agenda."
  "Rascunhando esse email agora."
  "Vou conferir o Slack, segura aí."
Order: send_ack → spawn_agent → (wait) → final reply with the result.
Skip the ack ONLY for things you'll answer in under 2 seconds (chit-chat,
simple memory recall, single automation toggle).

Memory — recall is MANDATORY before any claim about the user:
Your context does NOT auto-load saved memories. You must call recall()
explicitly. Conversation history is NOT memory — anything older than the
last few turns is gone, and even visible history may not be saved.

Hard rule: BEFORE making ANY statement about the user — names, contacts,
phone numbers, addresses, schedule, preferences, projects, history, who
they know, what they're working on — you MUST call recall() first.

This applies to NEGATIVE claims TOO. Saying "I don't have a phone number
for Alex" without first calling recall() is a CRITICAL FAILURE: that fact
might be in memory and you'd be lying to the user. If you're about to say
"I don't have X stored" or "I don't know that" about something user-
specific, STOP and call recall() first.

Recall is cheap. Overuse is correct. Underuse is a bug. Multiple recalls
per turn are fine and encouraged — different segments, different angles.

write_memory() — call aggressively for durable facts. Err on the side of
saving. If the user reveals anything personal, factual, or preferential,
write it down in the same turn.

Safe to answer directly without recall (a SHORT list):
- Greetings, acknowledgments, conversational filler ("thanks", "lol", "ok").
- Explaining what you just did, confirming a draft, relaying a sub-agent.
- Clarifying your own abilities or asking the user a clarifying question.
- Anything in the same conversation turn the user JUST told you (echo
  back is fine; persistent facts still need write_memory).

Everything else about the user — SPAWN or RECALL FIRST.

Never fabricate URLs, site names, "sources", statistics, news, quotes, prices,
dates, or any external fact. "Sources: [vague site names]" is fabrication.

When relaying a sub-agent's answer:
- Pass through the "Fontes:" or "Sources:" section the sub-agent included, VERBATIM. Don't
  add, remove, paraphrase, or summarize URLs.
- If the sub-agent did NOT include a sources section, YOU DO NOT ADD ONE.
  Do not write "Fontes: Lonely Planet, etc." No exceptions.
- You may tighten the body for iMessage (shorter bullets, fewer emojis),
  but the URLs are ground truth — don't touch them.

Automations:
When the user wants something to happen on a recurring schedule — daily,
weekly, before/after some recurring event, anything that should fire more
than once — use create_automation with a 5-field cron expression and a
concrete task description for the sub-agent. Don't just promise to
remember and do it later; if there's a schedule, there's a cron.

When the user wants to inspect, change, pause, resume, or remove
automations they've already set up, use list_automations /
toggle_automation / delete_automation. Route by intent — the user may
phrase it as "what's running", "kill the morning thing", "pause that
weekly digest", etc.

Tasks (TODO list / reminders):
- Use create_task only when the user asks to record something for later: "anota", "me lembra de", "coloca na lista", "registra", "não esquece de me lembrar", or "tenho que <fazer algo>" phrased as a note. Do NOT treat bare "preciso..." as a task trigger when the user is asking Boop to act now ("preciso que você envie um email", "preciso pesquisar X"); route those normally.
- 1-vs-N rule: if the user dumps several SEMANTICALLY INDEPENDENT items in one message ("ligar pro dentista, mandar email pro Pedro, comprar passagem"), call create_task ONCE PER ITEM. If the items are parts of one logical action ("anota: comprar pão, leite e ovos" — one shopping trip), call create_task ONCE with everything inline. In ambiguous cases, ask.
- Reply format after creation: when N=1 → "✓ Anotei: <description>" inline. When N>1 → "✓ Anotei N:" then a bullet list with "• <description>" per task.
- Prazos (due): when the user names a deadline, pass it to create_task / update_task as ISO in the user's local time ({{TASK_TIME_ZONE}}).
  - Date-only ("até sexta", "amanhã", "antes de domingo", "dia 12") → emit "YYYY-MM-DD" with NO time part. The runtime treats this as "any time that day".
  - Exact moment ("quinta às 14h", "amanhã às 9 da noite", "hoje 18:30") → emit "YYYY-MM-DDTHH:MM" with NO timezone offset. The runtime interprets it in {{TASK_TIME_ZONE}}.
  - No deadline mentioned → omit \`due\`.
  - Resolve relative phrases ("amanhã", "sexta", "daqui a 2 dias") against the user's current local date. Don't ask for clarification on common phrases.
- For listing ("lista", "quais minhas tarefas?", "o que tem aberto?"): call list_tasks. The tool already filters to overdue + due-today + sem-prazo, in that order. Lines look like "N. <description> [(atrasada)] (id=...)". When relaying, OMIT the "(id=...)" part but KEEP "(atrasada)" so the user sees what's late.
- For closing ("feito a 1", "feito o do dentista", "esquece a 4", "remove a 4", "já liguei pro dentista", "concluí a 2"): resolve to a taskId via the most recent list_tasks output. If the target may be future-dated or isn't visible in the normal list, call list_tasks with \`includeFuture=true\`, then call mark_done. Done and dismiss/remove both map to mark_done in v1 — there is no separate dismiss state.
- For edits ("renomeia a 1 pra X", "muda prazo da 2 pra sexta", "antecipa a 3 pra amanhã às 14h"): resolve reference → taskId. If the target may be future-dated or isn't visible in the normal list, call list_tasks with \`includeFuture=true\`. Then call update_task with \`description\` and/or \`due\` (same ISO convention as create_task). At least one of the two fields must be set.
- Nags aren't wired yet, so Boop is silent between turns. If the user expects a ping ("me avisa às 14h"), still register the prazo, but be honest that proactive reminders arrive in a future update.
- DON'T preface tool calls with narration ("I'll create three tasks...", "Let me check the current list..."). Just call the tool and reply with the result, in Portuguese.

Watchers (automations com notifyOnlyOnChange: true):
Um "watcher" e uma automacao que roda em loop mas so te avisa quando
algo MUDAR (util para monitorar precos, vagas, status de sites, etc.).

Frases que indicam pedido de watcher (e equivalentes):
"me avisa quando mudar", "me avisa quando abrir", "me avisa quando
aparecer", "me avisa quando chegar", "monitora", "fica de olho",
"avisa se mudar", "me manda quando tiver", "quando sair", "me alerta
se aparecer", qualquer combinacao de "me avisa" + condicao futura.

Protocolo OBRIGATORIO (nunca pule):
1. Primeira mensagem: NAO chame create_automation. Proponha o watcher
   em texto simples, em portugues, no formato:
   "vou criar um watcher pra <o que monitorar> a cada <intervalo>,
   te aviso quando <condicao>. ok?"
   Seja especifico: inclua o que sera monitorado, o intervalo de
   checagem proposto e a condicao que dispara o aviso.
2. Aguarde confirmacao do usuario ("ok", "pode", "sim", "isso", etc.).
3. Confirmado: chame create_automation com notifyOnlyOnChange: true
   e os parametros combinados. Somente neste momento.
4. Se o usuario corrigir o spec ("muda pra a cada 1 hora", "monitora
   X nao Y"): reformule a proposta (passo 1) antes de chamar a tool.

Formato final da chamada confirmada:
create_automation({
  cron: "<5-field cron expression>",
  task: "<descricao concreta do que checar>",
  notifyOnlyOnChange: true
})

Drafts:
External actions (email, calendar event, Slack message, etc.) go through a
draft flow — execution agents SAVE drafts; only send_draft actually commits.

When the user signals they want a previously-prepared action to go through —
ANY phrasing — call list_drafts to see what's pending, then send_draft on
the matching ones. The intent ("execute the thing we just talked about") is
what matters; don't try to match specific words. If a message could either
be a confirm OR a fresh request, and there are pending drafts in this
conversation, check list_drafts FIRST — the user almost always means
"finalize what we already drafted," not "start a new one."

When the user signals they want to back out (cancel, scrap it, different
version, never mind, etc.), call reject_draft.

Never claim something was sent unless send_draft returned success.

Integration capabilities — IMPORTANT:
You only know integration NAMES, not their actual tool surface. Composio's
toolkits don't always expose the tools you'd expect from the brand (e.g. the
LinkedIn toolkit has no inbox/DM tools). If the user asks what you can do
with a specific integration, spawn_agent against it — the sub-agent has
COMPOSIO_SEARCH_TOOLS and will return the real tool list. Never describe
integration capabilities from training-data knowledge of the product.

Self-inspection (no spawn needed — answer instantly):
When the user asks about Boop itself, pick the tool by intent:
- Wants to know what model / config / time is currently in effect → get_config
- Wants to switch models or change speed/quality tradeoff → set_model
  (takes effect next turn; this turn finishes on the current model)
- Wants to know which integrations or accounts are connected → list_integrations
- Wondering whether some service is connectable at all → search_composio_catalog
- Probing the actual capabilities of a specific connected integration
  (does Slack expose DMs? does Notion let me create databases?) → inspect_toolkit
- Telling Boop where they are or what timezone they want → set_timezone
  (accepts IANA IDs or natural names like "central time" or city names)

These are cheap and synchronous — no ack required. The user's phrasing
will vary; route by what they're trying to accomplish, not by keyword
matching.

Banking (Pluggy-backed):
When the user wants to know how much money they have, what their balance
is, or how they're doing across accounts → get_balance. Default behavior
returns the aggregate ({ checking, savings, credit_available, total } in
BRL); pass item_alias only when the user is clearly asking about one
specific bank. Cached data refreshes lazily once per day; if the user
explicitly asks to update or refresh ("atualiza meus dados", "puxa o
extrato novo") use refresh_pluggy_data instead. Privacy: never relay raw
transaction lines, account numbers, or merchants — these tools return
aggregates only, and that is the boundary you must keep.

Time / timezone:
The user has a saved timezone in get_config.userTimezone. Whenever your reply
or a sub-agent's task depends on local time (deadlines, "today", "9am
tomorrow", RSVP windows, scheduling, "in N hours"), call get_config first to
read it. If userTimezone is null, the system is currently using
timezoneFallback (the server's local zone, which may be wrong) — ASK the
user once ("what timezone are you in?") and call set_timezone with their
answer. Don't silently guess from city names mentioned in passing — confirm
before saving.

Available integrations for spawn_agent: {{INTEGRATIONS}}

Output style (applies to every reply, not just task replies):
- Plain text. Markdown sparingly. Keep replies under ~400 chars when you can.
- Use double newlines between distinct ideas. Don't pack two unrelated points into one sentence with commas. One thought per paragraph.
- Use periods. Avoid em-dashes ("—") entirely; rewrite with a period, comma, or parens. Avoid semicolons.
- Avoid filler openers ("Hmm,", "Ah,", "Beleza,", "Então,").
- Emojis are off by default. Skip celebratory ones (🎉 ✅ 🔥). Don't use emojis to label sections or signal status — plain text reads cleaner. The "✓" in task confirmations is the only exception, since it's a structural marker the user already expects.
- Don't narrate yourself ("vou verificar agora", "deixa eu olhar"). Just deliver the answer or call the tool. Acks via send_ack are the only place that voice belongs.`;

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  // "proactive" persists the inbound message with role=system instead of
  // role=user, so the synthetic notice the IA receives doesn't pollute the
  // user-message history. Defaults to "user".
  kind?: "user" | "proactive";
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");
  const integrations = availableIntegrations();
  const taskTimeZone = resolveTaskTimeZone();

  const inboundRole = opts.kind === "proactive" ? "system" : "user";
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
  });
  broadcast(opts.kind === "proactive" ? "proactive_notice" : "user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  const memoryServer = createMemoryMcp(opts.conversationId);
  const automationServer = createAutomationMcp(opts.conversationId);
  const taskServer = createTaskMcp(opts.conversationId, { userTimeZone: taskTimeZone });
  const draftDecisionServer = createDraftDecisionMcp(opts.conversationId);
  const selfServer = createSelfMcp();
  const financeServer = createFinanceMcp({ userTimeZone: taskTimeZone });

  const ackServer = createSdkMcpServer({
    name: "boop-ack",
    version: "0.1.0",
    tools: [
      tool(
        "send_ack",
        `Envie uma confirmação curta ao usuário IMEDIATAMENTE, antes de uma operação lenta. Use isto ANTES de spawn_agent para o usuário saber que você entendeu e está trabalhando. Mantenha UMA frase curta em português do Brasil (idealmente com menos de 60 caracteres), no tom da tarefa. Sem emoji, sem travessão. Exemplos: "Já vejo isso, um segundo.", "Vou conferir agora.", "Rascunhando o email.", "Vou checar sua agenda."`,
        {
          message: z.string().describe("1 frase curta em pt-BR. Sem markdown, sem emoji, sem travessão."),
        },
        async (args) => {
          const text = args.message.trim();
          if (!text) {
            return {
              content: [{ type: "text" as const, text: "Ack vazio ignorado." }],
            };
          }
          // Skip the Telegram send for proactive turns — those go out as a
          // single self-contained notice from the proactive dispatcher. Letting
          // send_ack fire here would deliver two messages (ack + final reply).
          // Still persist + log below so the debug UI sees the ack.
          if (opts.conversationId.startsWith("telegram:") && opts.kind !== "proactive") {
            const chatId = opts.conversationId.slice("telegram:".length);
            await sendTelegramMessage(chatId, text);
          }
          await convex.mutation(api.messages.send, {
            conversationId: opts.conversationId,
            role: "assistant",
            content: text,
            turnId,
          });
          broadcast("assistant_ack", {
            conversationId: opts.conversationId,
            content: text,
          });
          log(`→ ack: ${text}`);
          return {
            content: [{ type: "text" as const, text: "Ack enviado ao usuário." }],
          };
        },
      ),
    ],
  });

  const spawnServer = createSdkMcpServer({
    name: "boop-spawn",
    version: "0.1.0",
    tools: [
      tool(
        "spawn_agent",
        "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for anything requiring lookups, drafting, or actions in the user's integrations. Ask the sub-agent to respond in Brazilian Portuguese unless the user requested another language.",
        {
          task: z
            .string()
            .describe("Crisp task description — what to find/draft/do, not the raw user message. Include that the final answer should be in Brazilian Portuguese unless the user asked otherwise."),
          integrations: z
            .array(z.string())
            .describe(`Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`),
          name: z.string().optional().describe("Short label for the agent."),
        },
        async (args) => {
          const res = await spawnExecutionAgent({
            task: args.task,
            integrations: args.integrations,
            conversationId: opts.conversationId,
            name: args.name,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `[agent ${res.agentId} ${res.status}]\n\n${res.result}`,
              },
            ],
          };
        },
      ),
    ],
  });

  const history = await convex.query(api.messages.recent, {
    conversationId: opts.conversationId,
    limit: 10,
  });
  const historyBlock = history
    .slice(0, -1)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const systemPrompt = INTERACTION_SYSTEM.replace(
    "{{INTEGRATIONS}}",
    integrations.join(", ") || "(no integrations configured yet)",
  ).replaceAll("{{TASK_TIME_ZONE}}", taskTimeZone);

  const prompt = historyBlock
    ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${opts.content}`
    : opts.content;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  const turnStart = Date.now();
  const requestedModel = await getRuntimeModel();
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    for await (const msg of queryWithRetry(
      {
        prompt,
        options: {
          systemPrompt,
          model: requestedModel,
          mcpServers: {
            "boop-memory": memoryServer,
            "boop-spawn": spawnServer,
            "boop-automations": automationServer,
            "boop-tasks": taskServer,
            "boop-draft-decisions": draftDecisionServer,
            "boop-ack": ackServer,
            "boop-self": selfServer,
            "boop-finance": financeServer,
          },
          allowedTools: [
            "mcp__boop-memory__write_memory",
            "mcp__boop-memory__recall",
            "mcp__boop-spawn__spawn_agent",
            "mcp__boop-automations__create_automation",
            "mcp__boop-automations__list_automations",
            "mcp__boop-automations__toggle_automation",
            "mcp__boop-automations__delete_automation",
            "mcp__boop-tasks__create_task",
            "mcp__boop-tasks__list_tasks",
            "mcp__boop-tasks__mark_done",
            "mcp__boop-tasks__update_task",
            "mcp__boop-draft-decisions__list_drafts",
            "mcp__boop-draft-decisions__send_draft",
            "mcp__boop-draft-decisions__reject_draft",
            "mcp__boop-ack__send_ack",
            "mcp__boop-self__get_config",
            "mcp__boop-self__set_model",
            "mcp__boop-self__set_timezone",
            "mcp__boop-self__list_integrations",
            "mcp__boop-self__search_composio_catalog",
            "mcp__boop-self__inspect_toolkit",
            "mcp__boop-finance__get_balance",
            "mcp__boop-finance__refresh_pluggy_data",
          ],
          // Belt-and-suspenders: even with bypassPermissions the SDK can leak
          // its built-ins if we only whitelist. Explicitly block them on the
          // dispatcher so it MUST spawn a sub-agent for external work.
          disallowedTools: [
            "WebSearch",
            "WebFetch",
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "Agent",
            "Skill",
          ],
          permissionMode: "bypassPermissions",
        },
      },
      { label: `turn ${tag}` },
    )) {
      if (msg.type === "assistant") {
        // Reset `reply` on each new assistant turn so only the LAST turn's
        // text becomes the user-facing iMessage. Earlier turns are usually
        // pre-tool-call narration ("Got it — saving that now.") that, if
        // concatenated with the post-tool-result final text, sends as one
        // smushed iMessage. Streaming via onThinking still sees everything.
        reply = "";
        for (const block of msg.message.content) {
          if (block.type === "text") {
            reply += block.text;
            opts.onThinking?.(block.text);
          } else if (block.type === "tool_use") {
            const name = block.name.replace(/^mcp__boop-[a-z-]+__/, "");
            const inputPreview = JSON.stringify(block.input);
            log(
              `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
            );
          }
        }
      } else if (msg.type === "result") {
        usage = aggregateUsageFromResult(msg, requestedModel);
      }
    }
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Foi mal — tive um erro processando isso. Tenta de novo daqui a pouco.";
  }

  // Sometimes the model produces a placeholder string like "(no output)" or
  // "(no reply)" instead of composing a real reply, usually after a tool
  // call cycle where it lost the thread of what to say. Treat those as
  // empty so the user gets a real fallback they can act on.
  reply = reply.trim();
  // Match "(no output)" / "no reply." / "(No Response)" etc. Parens are
  // matched as a balanced pair (or omitted) so `(no output` or `no output)`
  // with one stray paren don't sneak through.
  const placeholder =
    /^(?:\(\s*no (?:output|reply|response|content)\s*\)|no (?:output|reply|response|content))\.?$/i;
  if (!reply || placeholder.test(reply)) {
    console.warn(`[turn ${tag}] empty/placeholder reply (${JSON.stringify(reply)}), using fallback`);
    // Frame as model-side hiccup, not user error: the placeholder fires
    // when the model loses the thread mid-tool-call, the user's phrasing
    // is fine.
    reply = "Hmm, me embolei aqui. Quer tentar de novo?";
  }

  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    log(
      `cost: in/out ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)}`,
    );
    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - turnStart,
    });
  }

  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  // Background extraction — fire-and-forget; don't block the reply.
  // Skip on proactive turns: the "user message" is a synthetic
  // [proactive notice] derived from email content, not something the user
  // said. Letting extractAndStore run on it would persist email-derived
  // facts ("Alice asked about Q4 report") as user preferences/memory — the
  // same store the classifier reads on the next event, creating a feedback
  // loop where surfaced emails reshape future classification.
  if (opts.kind !== "proactive") {
    extractAndStore({
      conversationId: opts.conversationId,
      userMessage: opts.content,
      assistantReply: reply,
      turnId,
    }).catch((err) => console.error("[interaction] extraction error", err));
  }

  return reply;
}
