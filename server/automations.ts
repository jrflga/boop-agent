import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { sendTelegramMessage } from "./telegram.js";
import { broadcast } from "./broadcast.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const SNAPSHOT_MAX_CHARS = 16384;

export function normalizeSnapshot(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function diffAdditions(prev: string[], curr: string[]): string[] {
  const prevSet = new Set(prev);
  return curr.filter((line) => !prevSet.has(line));
}

export function nextRunFor(schedule: string): number | null {
  try {
    const c = new Cron(schedule, { paused: true });
    const next = c.nextRun();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function validateSchedule(schedule: string): { valid: boolean; error?: string } {
  try {
    new Cron(schedule, { paused: true }).nextRun();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

async function runAutomation(a: {
  automationId: string;
  name: string;
  task: string;
  integrations: string[];
  schedule: string;
  conversationId?: string;
  notifyConversationId?: string;
  notifyOnlyOnChange?: boolean;
  lastSnapshot?: string;
}): Promise<void> {
  const runId = randomId("run");
  await convex.mutation(api.automations.createRun, {
    runId,
    automationId: a.automationId,
  });
  broadcast("automation_started", { automationId: a.automationId, runId, name: a.name });

  try {
    if (a.notifyOnlyOnChange) {
      const watcherTask =
        `AUTOMATION "${a.name}": ${a.task}\n\n` +
        `Retorne uma lista, um item por linha. Formato consistente, sem variação. Sem comentários, sem cabeçalho, sem rodapé.`;
      const res = await spawnExecutionAgent({
        task: watcherTask,
        integrations: a.integrations,
        conversationId: a.conversationId,
        name: `auto:${a.name}`,
        model: "claude-haiku-4-5",
        temperature: 0,
      });

      if (res.status !== "completed" || !res.result) {
        await convex.mutation(api.automations.updateRun, {
          runId,
          status: "failed",
          result: res.result,
          agentId: res.agentId,
          error: res.status !== "completed" ? "agent did not complete" : "empty result",
        });
        broadcast("automation_failed", { automationId: a.automationId, runId });
      } else {
        await convex.mutation(api.automations.updateRun, {
          runId,
          status: "completed",
          result: res.result,
          agentId: res.agentId,
        });

        const currLines = normalizeSnapshot(res.result);
        const currText = currLines.join("\n").slice(0, SNAPSHOT_MAX_CHARS);

        if (a.lastSnapshot == null) {
          await convex.mutation(api.automations.updateSnapshot, {
            automationId: a.automationId,
            lastSnapshot: currText,
          });
        } else {
          const prevLines = normalizeSnapshot(a.lastSnapshot);
          const additions = diffAdditions(prevLines, currLines);

          await convex.mutation(api.automations.updateSnapshot, {
            automationId: a.automationId,
            lastSnapshot: currText,
          });

          if (additions.length > 0 && a.notifyConversationId) {
            const body =
              `[${a.name}]\n` + additions.map((line) => `Novo: ${line}`).join("\n");
            if (a.notifyConversationId.startsWith("telegram:")) {
              const chatId = a.notifyConversationId.slice("telegram:".length);
              await sendTelegramMessage(chatId, body);
            }
            await convex.mutation(api.messages.send, {
              conversationId: a.notifyConversationId,
              role: "assistant",
              content: body,
            });
          }
        }

        broadcast("automation_completed", { automationId: a.automationId, runId });
      }
    } else {
      const res = await spawnExecutionAgent({
        task: `AUTOMATION "${a.name}": ${a.task}`,
        integrations: a.integrations,
        conversationId: a.conversationId,
        name: `auto:${a.name}`,
      });
      await convex.mutation(api.automations.updateRun, {
        runId,
        status: res.status === "completed" ? "completed" : "failed",
        result: res.result,
        agentId: res.agentId,
      });

      if (a.notifyConversationId && res.result) {
        if (a.notifyConversationId.startsWith("telegram:")) {
          const chatId = a.notifyConversationId.slice("telegram:".length);
          const preamble = `[${a.name}]\n\n`;
          await sendTelegramMessage(chatId, preamble + res.result);
        }
        await convex.mutation(api.messages.send, {
          conversationId: a.notifyConversationId,
          role: "assistant",
          content: `[${a.name}]\n\n${res.result}`,
        });
      }

      broadcast("automation_completed", { automationId: a.automationId, runId });
    }
  } catch (err) {
    await convex.mutation(api.automations.updateRun, {
      runId,
      status: "failed",
      error: String(err),
    });
    broadcast("automation_failed", { automationId: a.automationId, runId, error: String(err) });
  }

  const next = nextRunFor(a.schedule);
  await convex.mutation(api.automations.markRan, {
    automationId: a.automationId,
    lastRunAt: Date.now(),
    nextRunAt: next ?? undefined,
  });
}

export async function tickAutomations(): Promise<void> {
  const all = await convex.query(api.automations.list, { enabledOnly: true });
  const now = Date.now();
  const due = all.filter((a) => a.nextRunAt !== undefined && a.nextRunAt <= now);
  for (const a of due) {
    runAutomation({
      automationId: a.automationId,
      name: a.name,
      task: a.task,
      integrations: a.integrations,
      schedule: a.schedule,
      conversationId: a.conversationId,
      notifyConversationId: a.notifyConversationId,
      notifyOnlyOnChange: a.notifyOnlyOnChange,
      lastSnapshot: a.lastSnapshot,
    }).catch((err) => console.error("[automations] run error", err));
  }
}

export function startAutomationLoop(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    tickAutomations().catch((err) => console.error("[automations] tick error", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
