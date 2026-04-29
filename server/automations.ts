import { Cron } from "croner";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { sendTelegramMessage } from "./telegram.js";
import { broadcast } from "./broadcast.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

// Normalize a raw spawn result into a clean line list:
//   - trim leading/trailing whitespace per line
//   - drop empty lines (after trimming)
// Cases the caller relies on:
//   - multi-line input with mixed whitespace and empty interleaved lines → all
//     non-empty lines, trimmed, in original order
//   - single-line input → one-element array
//   - fully empty / whitespace-only input → empty array
export function normalizeSnapshot(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Pure set-difference: lines in `curr` that are not in `prev`.
// Cases:
//   - empty prev → returns all of curr (caller must skip notification on the
//     baseline first tick by checking lastSnapshot === undefined, not by
//     looking at the diff)
//   - identical prev/curr → empty array
//   - one new line → one-element array
//   - complete replacement → all of curr
//   - duplicate lines in curr (same line appears twice) → returned at most
//     once (deduplicated against the prev set, then deduplicated against
//     itself via the same membership test)
export function diffAdditions(prev: string[], curr: string[]): string[] {
  const prevSet = new Set(prev);
  const seen = new Set<string>();
  const additions: string[] = [];
  for (const line of curr) {
    if (prevSet.has(line) || seen.has(line)) continue;
    additions.push(line);
    seen.add(line);
  }
  return additions;
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
    const taskBody = a.notifyOnlyOnChange
      ? `${a.task}\n\nRetorne uma lista, um item por linha. Formato consistente, sem variação. Sem comentários, sem cabeçalho, sem rodapé.`
      : a.task;

    const res = await spawnExecutionAgent({
      task: `AUTOMATION "${a.name}": ${taskBody}`,
      integrations: a.integrations,
      conversationId: a.conversationId,
      name: a.notifyOnlyOnChange ? `watcher:${a.name}` : `auto:${a.name}`,
      modelOverride: a.notifyOnlyOnChange ? "claude-haiku-4-5-20251001" : undefined,
    });
    await convex.mutation(api.automations.updateRun, {
      runId,
      status: res.status === "completed" ? "completed" : "failed",
      result: res.result,
      agentId: res.agentId,
    });

    if (res.status === "completed" && res.result) {
      if (a.notifyOnlyOnChange) {
        const SNAPSHOT_CAP = 16 * 1024;
        const currLines = normalizeSnapshot(res.result);
        const prevLines = a.lastSnapshot ? normalizeSnapshot(a.lastSnapshot) : [];
        const baseline = a.lastSnapshot === undefined;
        const additions = baseline ? [] : diffAdditions(prevLines, currLines);

        // Always persist the new snapshot on a successful spawn (truncate to cap).
        const newSnapshot = currLines.join("\n").slice(0, SNAPSHOT_CAP);
        await convex.mutation(api.automations.updateSnapshot, {
          automationId: a.automationId,
          snapshot: newSnapshot,
        });

        if (!baseline && additions.length > 0 && a.notifyConversationId) {
          const body = `[${a.name}]\n${additions.map((line) => `Novo: ${line}`).join("\n")}`;
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
      } else if (a.notifyConversationId) {
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
    }

    broadcast("automation_completed", { automationId: a.automationId, runId });
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
    // fire-and-forget so one slow automation doesn't block others
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
