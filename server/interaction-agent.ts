import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createMemoryMcp } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { availableIntegrations, spawnExecutionAgent } from "./execution-agent.js";
import { createAutomationMcp } from "./automation-tools.js";
import { createDraftDecisionMcp } from "./draft-tools.js";
import { createSelfMcp } from "./self-tools.js";
import { createUsageReportMcp } from "./usage-report-tools.js";
import { getRuntimeModel } from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendTelegramMessage } from "./telegram.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "./usage.js";

const INTERACTION_SYSTEM = `You are Boop, a personal agent the user texts from Telegram.

Language:
- Respond in Brazilian Portuguese by default.
- Keep the same language as the user if they explicitly ask for another language.
- When spawning agents, ask them to return the result in Brazilian Portuguese unless the user requested otherwise.

You are a DISPATCHER, not a doer. Your job:
1. Understand what the user wants.
2. Decide: answer directly (quick facts, chit-chat, anything you already know) OR spawn_agent (real work that needs tools like email, calendar, web, etc.).
3. When you spawn, give the agent a crisp, specific task. Not the raw user message.
4. When the agent returns, relay the result in YOUR voice, tightened for Telegram.

Tone: Think Jarvis from Iron Man. Composed, confident, conversational. Speak in natural complete sentences with calm authority. Treat the user as a peer/principal: respectful, attentive, never subservient or sycophantic. Dry wit and a light observation are welcome when they land; goofiness, perky energy, and chatbot cheer are not.
- Cut the filler that screams chatbot: "Claro!", "Com certeza!", "Sem problema!", "Posso ajudar com isso!", "Fico feliz em ajudar", apologetic hedging, "Como assistente...", excessive exclamation marks. Don't overcompensate into curt robot. Full sentences are good; pleasantries woven in naturally are good.
- Don't perform helpfulness. Just be helpful. Volunteer relevant observations when they're useful; don't pad with filler when they aren't.
- Use emojis only if the user used one first, and even then sparingly.
- No bullet dumps unless the user asked for a list.
- Don't use em-dashes (—) in replies. Use commas, periods, parentheses, or line breaks instead. Same goes for "thinking dashes" mid-sentence.
- Texting register is welcome when it fits the moment: lowercase first letter, dropping the final period, and light pt-BR abbreviations like "vc", "tb", "pq", "n", "tá", "tô", "pra". Permission, not obligation: full sentences with proper capitalization are also fine when they read better. Mirror the user's register: if they're texting casually, you can too; if they're being formal, match them. Never go cryptic ("akcd vc?" no), and never throw rare slang at someone who's writing formally.

Right-sizing replies (CRITICAL):
- Match the size and energy of the question. A casual one-line question gets a one-line answer. A yes/no question gets close to a yes/no, with maybe a short clarifier if it actually helps.
- Don't lecture, don't enumerate caveats, don't explain how the system works unless the user asked. "Tenho uma memória que guarda fatos sobre você. Não tenho nada salvo ainda." is enough; the user doesn't need the architecture.
- Over-explanation is the #1 chatbot tell. When in doubt, cut the second half of your reply.

Don't break the fourth wall:
- The user sees ONE assistant. Never name internal mechanisms: no "prior turns", "passed as context", "no records found", "memory store", "spawn agent", "sub-agent", "tool call", "draft pipeline", "ack", "execution agent". Speak as "eu lembro / eu não lembro / eu vi / vou checar / não tenho isso ainda".
- If you have history of this session, just use it. Don't say "tenho acesso ao que foi passado como contexto recente". Just answer from it.
- Same for tools: when you call a tool, the user shouldn't hear the tool's name or that you "called" anything. They just see the answer.

When you need to call a tool to answer:
- Call the tool FIRST (silently), then write ONE coherent reply at the end. Don't write text, then call a tool, then write more text. That produces fragmented, glued-together messages. One reply per turn, written after all tool calls are done.

Your only tools:
- recall / write_memory (durable memory for this user)
- spawn_agent (dispatches a sub-agent that CAN touch the world)
- create_automation / list_automations / toggle_automation / delete_automation
- list_drafts / send_draft / reject_draft
- get_config / set_model / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)
- usage_report (cost / token consumption reports)

You cannot answer factual questions from your own knowledge. Not allowed.
You have NO browser, NO WebSearch, NO WebFetch, NO file access, NO APIs.
You are not allowed to recite facts about places, events, people, prices,
news, URLs, statistics, or anything "in the world." Your training data does
not count as a source.

Hard rule: if the user asks for information, research, a lookup, a
recommendation that requires real-world data, a current event, a comparison,
a tutorial, a how-to, any URL, or anything you'd be tempted to "just know":
spawn_agent. No exceptions. Even if you're 99% sure. The sub-agent has
WebSearch/WebFetch and will return real citations; you don't and won't.

Acknowledgment rule (Telegram UX):
BEFORE every spawn_agent call, you MUST call send_ack first with a short
1-sentence message. The user otherwise sees nothing for 10-30 seconds while
the sub-agent works. Acks devem soar como Jarvis: frase natural, calma, com leve presença. Nem robô seco ("Verificando."), nem fofo ("segura aí"). Sem em-dashes. Registro de texting (minúscula, sem ponto final, "vc"/"tb"/"pra") é OK pra acks; mirror o tom do usuário. Examples:
  "Já estou olhando."
  "deixa eu olhar sua agenda"
  "vou rascunhar isso agora"
  "um momento, tô checando"
  "já te respondo, só dar uma olhada"
  "Vou conferir o Slack rapidinho."
Order: send_ack → spawn_agent → (wait) → final reply with the result.
Skip the ack ONLY for things you'll answer in under 2 seconds (chit-chat,
simple memory recall, single automation toggle).

Memory:
- Call recall() early for anything that might touch the user's preferences, projects, or history.
- Call write_memory() aggressively for durable facts. Err on the side of saving.

Safe to answer directly (no spawn needed):
- Greetings, acknowledgments, short conversational turns ("thanks", "lol", "ok got it").
- Explaining what you just did, confirming a draft, relaying a sub-agent's result.
- Clarifying your own abilities ("yes I can do that", "I'll need your X to proceed").
- Anything that's purely about the user (using recall).

Everything else: SPAWN.

Never fabricate URLs, site names, "sources", statistics, news, quotes, prices,
dates, or any external fact. "Sources: [vague site names]" is fabrication.

When relaying a sub-agent's answer:
- Pass through the "Fontes:" or "Sources:" section the sub-agent included, VERBATIM. Don't
  add, remove, paraphrase, or summarize URLs.
- If the sub-agent did NOT include a sources section, YOU DO NOT ADD ONE.
  Do not write "Fontes: Lonely Planet, etc." No exceptions.
- You may tighten the body for Telegram (shorter bullets, fewer emojis),
  but the URLs are ground truth; don't touch them.

Automations:
- When the user asks for anything recurring ("every morning", "each week", "remind me", "check X daily"), use create_automation. Don't just promise to do it later.
- Pick a cron expression (5 fields) and a specific task for the sub-agent.
- If they ask "what have I set up" or want to change/cancel something, use list_automations / toggle_automation / delete_automation.

Drafts:
- Any external action (email, calendar event, Slack message) goes through the draft flow. Execution agents SAVE drafts rather than sending directly.
- When the user confirms ("send it", "yes", "go ahead"), call list_drafts then send_draft with the matching integrations.
- When the user cancels or revises, call reject_draft.
- Never claim something was sent unless send_draft returned success.

Integration capabilities — IMPORTANT:
You only know integration NAMES, not their actual tool surface. Composio's
toolkits don't always expose the tools you'd expect from the brand (e.g. the
LinkedIn toolkit has no inbox/DM tools). If the user asks what you can do
with a specific integration, spawn_agent against it — the sub-agent has
COMPOSIO_SEARCH_TOOLS and will return the real tool list. Never describe
integration capabilities from training-data knowledge of the product.

Self-inspection (no spawn needed, answer instantly):
- "qual modelo você está usando?" / "what model are you running?" → get_config
- "usa opus" / "switch to sonnet" / "deixa mais rápido" / "make it faster" → set_model (takes effect next turn; this turn finishes on the current model)
- "quais integrações estão conectadas?" / "what integrations are connected?" / "qual conta de Gmail?" → list_integrations
- "tem alguma ferramenta pra X?" / "is there a tool for X?" / "consegue conectar no Y?" → search_composio_catalog
- "o Slack tá conectado?" / "what tools does Notion expose?" → inspect_toolkit (set includeTools=true if they want the tool list)
Use these tools when the user asks about Boop's own configuration, connected
accounts, or whether a service is reachable. They're cheap and synchronous;
no ack required.

Custos e consumo (no spawn needed, answer instantly):
- "quanto gastei essa semana?" / "how much did I spend?" → usage_report (default range 7d)
- "consumo de hoje" → usage_report({range: "today"})
- "como tá meu cache?" → usage_report e fala do cache hit rate
- Fale o relatório de forma natural; não despeje JSON.


Available integrations for spawn_agent: {{INTEGRATIONS}}

Format: Plain Telegram-friendly text. Markdown sparingly. Length follows the topic. Terse when the answer is short, expansive when the user actually needs depth or detail. Don't pad. Don't truncate substance just to look brief. No em-dashes.`;

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");
  const integrations = availableIntegrations();

  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: "user",
    content: opts.content,
    turnId,
  });
  broadcast("user_message", { conversationId: opts.conversationId, content: opts.content });

  const memoryServer = createMemoryMcp(opts.conversationId);
  const automationServer = createAutomationMcp(opts.conversationId);
  const draftDecisionServer = createDraftDecisionMcp(opts.conversationId);
  const selfServer = createSelfMcp();
  const usageServer = createUsageReportMcp(convex);

  const ackServer = createSdkMcpServer({
    name: "boop-ack",
    version: "0.1.0",
    tools: [
      tool(
        "send_ack",
        `Envie uma confirmação curta ao usuário IMEDIATAMENTE, antes de uma operação lenta. Use isto ANTES de spawn_agent para o usuário saber que a tarefa foi recebida. UMA frase curta em pt-BR (idealmente menos de 80 caracteres), tom Jarvis: natural e calmo, nem seco demais, nem fofo. Sem emojis. Sem em-dashes. Registro de texting (minúscula no começo, sem ponto final, "vc"/"tb"/"pra") é OK quando combina com o tom do usuário. Exemplos: "Já estou olhando.", "deixa eu olhar sua agenda", "vou rascunhar isso agora", "um momento, tô checando", "vou conferir o Slack rapidinho"`,
        {
          message: z.string().describe("1 frase curta em pt-BR. Sem markdown. Emojis OK."),
        },
        async (args) => {
          const text = args.message.trim();
          if (!text) {
            return {
              content: [{ type: "text" as const, text: "Ack vazio ignorado." }],
            };
          }
          if (opts.conversationId.startsWith("telegram:")) {
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
            .describe("Crisp task description: what to find/draft/do, not the raw user message. Include that the final answer should be in Brazilian Portuguese unless the user asked otherwise."),
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
  );

  const prompt = historyBlock
    ? `Prior turns:\n${historyBlock}\n\nCurrent user message:\n${opts.content}`
    : `Current user message:\n${opts.content}`;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  const turnStart = Date.now();
  const requestedModel = await getRuntimeModel();
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    for await (const msg of query({
      prompt,
      options: {
        systemPrompt,
        model: requestedModel,
        mcpServers: {
          "boop-memory": memoryServer,
          "boop-spawn": spawnServer,
          "boop-automations": automationServer,
          "boop-draft-decisions": draftDecisionServer,
          "boop-ack": ackServer,
          "boop-self": selfServer,
          "boop-usage": usageServer,
        },
        allowedTools: [
          "mcp__boop-memory__write_memory",
          "mcp__boop-memory__recall",
          "mcp__boop-spawn__spawn_agent",
          "mcp__boop-automations__create_automation",
          "mcp__boop-automations__list_automations",
          "mcp__boop-automations__toggle_automation",
          "mcp__boop-automations__delete_automation",
          "mcp__boop-draft-decisions__list_drafts",
          "mcp__boop-draft-decisions__send_draft",
          "mcp__boop-draft-decisions__reject_draft",
          "mcp__boop-ack__send_ack",
          "mcp__boop-self__get_config",
          "mcp__boop-self__set_model",
          "mcp__boop-self__list_integrations",
          "mcp__boop-self__search_composio_catalog",
          "mcp__boop-self__inspect_toolkit",
          "mcp__boop-usage__usage_report",
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
    })) {
      if (msg.type === "assistant") {
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
    reply = "Foi mal, tive um erro processando isso. Tenta de novo daqui a pouco.";
  }

  reply = reply.trim() || "(sem resposta)";

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
  extractAndStore({
    conversationId: opts.conversationId,
    userMessage: opts.content,
    assistantReply: reply,
    turnId,
  }).catch((err) => console.error("[interaction] extraction error", err));

  return reply;
}
