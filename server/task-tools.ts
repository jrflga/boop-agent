import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Convention: bare YYYY-MM-DD means "midnight in host TZ" (date-only).
// Anything with a time component (and optional offset) is parsed by the
// platform — V8 interprets `YYYY-MM-DDTHH:MM` (no offset) as host-local
// time. Dispatcher emits one of these shapes; everything else throws.
function parseDueIso(iso: string): number {
  const dateOnly = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
    ).getTime();
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid due value: ${iso}`);
  }
  return ms;
}

function todayBoundsHostTz(now: Date = new Date()): { start: number; end: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { start, end: start + 86_400_000 };
}

export function createTaskMcp(conversationId: string) {
  return createSdkMcpServer({
    name: "boop-tasks",
    version: "0.1.0",
    tools: [
      tool(
        "create_task",
        `Create a new task (TODO/reminder) for the user.

Call ONCE per semantically independent task. If the user dumps several distinct things in one message ("ligar pro dentista, mandar email pro Pedro, comprar passagem"), call this N times — once per task. If the items are parts of one logical action ("comprar pão, leite e ovos" — one shopping trip), call once with all items inline in the description.

Triggers from the user: "anota", "me lembra", "tenho que", "preciso", "registra", "não esquece de me lembrar".

Optional \`due\`: ISO date or datetime in host time. Use \`YYYY-MM-DD\` for a bare date ("até sexta", "amanhã") — that means "any time that day". Use \`YYYY-MM-DDTHH:MM\` (no zone) for an exact moment ("quinta às 14h"). Omit \`due\` when the user gave no deadline.`,
        {
          description: z
            .string()
            .describe("What the task is, in plain language, in the user's voice."),
          due: z
            .string()
            .optional()
            .describe(
              "ISO date (YYYY-MM-DD) for date-only, or ISO datetime (YYYY-MM-DDTHH:MM) for an exact moment. Omit when no deadline was given.",
            ),
        },
        async (args) => {
          const taskId = randomId("tk");
          const dueMs = args.due !== undefined ? parseDueIso(args.due) : undefined;
          await convex.mutation(api.tasks.create, {
            taskId,
            conversationId,
            description: args.description,
            ...(dueMs !== undefined ? { due: dueMs } : {}),
          });
          const dueNote =
            dueMs !== undefined ? ` (due=${new Date(dueMs).toISOString()})` : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `Created task ${taskId}: ${args.description}${dueNote}`,
              },
            ],
          };
        },
      ),

      tool(
        "list_tasks",
        `List OPEN tasks for this conversation, filtered to overdue + due-today + no-due. Future-dated tasks are hidden until the day arrives.

Order: overdue first (oldest due first), then due-today (chronological), then no-due (creation order). Overdue rows are marked "(atrasada)".

Returns numbered lines: "N. <description> [(atrasada)] (id=<taskId>)". When relaying to the user, OMIT the "(id=...)" parts — show only the number, description, and the "(atrasada)" marker when present.`,
        {},
        async () => {
          const { start: todayStart, end: todayEnd } = todayBoundsHostTz();
          const list = await convex.query(api.tasks.listOpen, {
            conversationId,
            todayEndMs: todayEnd,
          });
          if (list.length === 0) {
            return { content: [{ type: "text" as const, text: "No open tasks." }] };
          }
          const overdue = list
            .filter((t) => t.due !== undefined && t.due < todayStart)
            .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
          const today = list
            .filter((t) => t.due !== undefined && t.due >= todayStart && t.due < todayEnd)
            .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
          const noDue = list
            .filter((t) => t.due === undefined)
            .sort((a, b) => a.createdAt - b.createdAt);
          const ordered = [...overdue, ...today, ...noDue];
          const lines = ordered.map((t, i) => {
            const isOverdue = t.due !== undefined && t.due < todayStart;
            const marker = isOverdue ? " (atrasada)" : "";
            return `${i + 1}. ${t.description}${marker} (id=${t.taskId})`;
          });
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        },
      ),

      tool(
        "mark_done",
        `Mark a task as closed.

Resolve "feito a 1" / "feito o do dentista" / "esquece a 4" / "remove a 4" to a taskId by reading the most recent list_tasks output (or calling list_tasks first), then pass that taskId here. "Done" and "esquece"/"remove" both map to closed in v1 — there is no separate dismiss state.`,
        {
          taskId: z.string().describe("The taskId to close."),
        },
        async (args) => {
          const id = await convex.mutation(api.tasks.markClosed, { taskId: args.taskId });
          return {
            content: [
              {
                type: "text" as const,
                text: id ? `Closed task ${args.taskId}.` : `Task ${args.taskId} not found.`,
              },
            ],
          };
        },
      ),

      tool(
        "update_task",
        `Edit a task's description and/or prazo.

Triggers: "renomeia a 1 pra X", "muda prazo da 2 pra sexta", "antecipa a 3 pra amanhã", "adia a 1 pra quinta às 14h".

Resolve the user's numeric or fuzzy reference to a taskId via the most recent list_tasks output (or by calling list_tasks first). Pass at least one of \`description\` or \`due\`. \`due\` follows the same ISO convention as create_task: \`YYYY-MM-DD\` for date-only, \`YYYY-MM-DDTHH:MM\` for a precise moment.`,
        {
          taskId: z.string().describe("The taskId to update."),
          description: z
            .string()
            .optional()
            .describe("New description; omit to leave the description unchanged."),
          due: z
            .string()
            .optional()
            .describe(
              "New ISO date or datetime; omit to leave the prazo unchanged.",
            ),
        },
        async (args) => {
          if (args.description === undefined && args.due === undefined) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Nothing to update — provide description and/or due.",
                },
              ],
            };
          }
          const dueMs = args.due !== undefined ? parseDueIso(args.due) : undefined;
          const id = await convex.mutation(api.tasks.update, {
            taskId: args.taskId,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(dueMs !== undefined ? { due: dueMs } : {}),
          });
          if (!id) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Task ${args.taskId} not found.`,
                },
              ],
            };
          }
          const changed: string[] = [];
          if (args.description !== undefined)
            changed.push(`description="${args.description}"`);
          if (dueMs !== undefined)
            changed.push(`due=${new Date(dueMs).toISOString()}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `Updated task ${args.taskId}: ${changed.join(", ")}`,
              },
            ],
          };
        },
      ),
    ],
  });
}
