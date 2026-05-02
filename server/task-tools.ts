import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

const TASK_LIST_LIMIT = 25;
const DEFAULT_TASK_TIME_ZONE = "America/Sao_Paulo";

type TaskMcpOptions = {
  userTimeZone?: string;
};

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveTaskTimeZone(explicit?: string): string {
  const timeZone = explicit ?? process.env.BOOP_USER_TIME_ZONE ?? DEFAULT_TASK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid task timezone: ${timeZone}`);
  }
  return timeZone;
}

function dateTimePartsInTimeZone(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`Missing ${type} for timezone ${timeZone}`);
    return Number(value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMsForTimeZone(timeZone: string, utcMs: number): number {
  const local = dateTimePartsInTimeZone(new Date(utcMs), timeZone);
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return localAsUtc - Math.trunc(utcMs / 1000) * 1000;
}

function wallTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let utcMs = wallAsUtc;
  for (let i = 0; i < 3; i++) {
    const next = wallAsUtc - offsetMsForTimeZone(timeZone, utcMs);
    if (next === utcMs) return next;
    utcMs = next;
  }
  return utcMs;
}

function nextCalendarDay(year: number, month: number, day: number) {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

// Convention: bare YYYY-MM-DD means local midnight in the user's timezone.
// YYYY-MM-DDTHH:MM without an offset is also interpreted in that timezone.
// Offset-bearing ISO datetimes are parsed as absolute instants.
function parseDueIso(iso: string, timeZone: string): number {
  const dateOnly = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return wallTimeToUtcMs(
      timeZone,
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    );
  }
  const localDateTime = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (localDateTime) {
    return wallTimeToUtcMs(
      timeZone,
      Number(localDateTime[1]),
      Number(localDateTime[2]),
      Number(localDateTime[3]),
      Number(localDateTime[4]),
      Number(localDateTime[5]),
      localDateTime[6] === undefined ? 0 : Number(localDateTime[6]),
      localDateTime[7] === undefined ? 0 : Number(localDateTime[7].padEnd(3, "0")),
    );
  }
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new Error(`Invalid due value: ${iso}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid due value: ${iso}`);
  }
  return ms;
}

function todayBoundsInTimeZone(
  timeZone: string,
  now: Date = new Date(),
): { start: number; end: number } {
  const today = dateTimePartsInTimeZone(now, timeZone);
  const tomorrow = nextCalendarDay(today.year, today.month, today.day);
  return {
    start: wallTimeToUtcMs(timeZone, today.year, today.month, today.day),
    end: wallTimeToUtcMs(timeZone, tomorrow.year, tomorrow.month, tomorrow.day),
  };
}

export function createTaskMcp(conversationId: string, opts: TaskMcpOptions = {}) {
  const userTimeZone = resolveTaskTimeZone(opts.userTimeZone);

  return createSdkMcpServer({
    name: "boop-tasks",
    version: "0.1.0",
    tools: [
      tool(
        "create_task",
        `Create a new task (TODO/reminder) for the user.

Call ONCE per semantically independent task. If the user dumps several distinct things in one message ("ligar pro dentista, mandar email pro Pedro, comprar passagem"), call this N times — once per task. If the items are parts of one logical action ("comprar pão, leite e ovos" — one shopping trip), call once with all items inline in the description.

Triggers from the user: "anota", "me lembra de", "coloca na lista", "registra", "não esquece de me lembrar", or "tenho que <fazer algo>" when phrased as a note for later. Do not use this for bare "preciso..." requests where the user is asking Boop to act now.

Optional \`due\`: ISO date or datetime in the user's timezone (${userTimeZone}). Use \`YYYY-MM-DD\` for a bare date ("até sexta", "amanhã") — that means "any time that day". Use \`YYYY-MM-DDTHH:MM\` (no zone) for an exact moment ("quinta às 14h"). Omit \`due\` when the user gave no deadline.`,
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
          const dueMs =
            args.due !== undefined ? parseDueIso(args.due, userTimeZone) : undefined;
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

Set \`includeFuture=true\` only when resolving an edit/close reference that may point to a future-dated task. Normal user "lista" requests should omit it so future tasks stay hidden.

Returns up to ${TASK_LIST_LIMIT} numbered lines: "N. <description> [(atrasada|futura)] (id=<taskId>)". When relaying to the user, OMIT the "(id=...)" parts — show only the number, description, and the "(atrasada)" marker when present.`,
        {
          includeFuture: z
            .boolean()
            .optional()
            .describe(
              "Set true only for resolving edit/close references that might target future-dated tasks. Omit or false for normal list requests.",
            ),
        },
        async (args) => {
          const includeFuture = args.includeFuture === true;
          const { start: todayStart, end: todayEnd } = todayBoundsInTimeZone(userTimeZone);
          const result = await convex.query(api.tasks.listOpen, {
            conversationId,
            limit: TASK_LIST_LIMIT,
            ...(includeFuture ? {} : { todayEndMs: todayEnd }),
          });
          const list = result.tasks;
          if (list.length === 0) {
            return { content: [{ type: "text" as const, text: "No open tasks." }] };
          }
          const overdue = list
            .filter((t) => t.due !== undefined && t.due < todayStart)
            .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
          const today = list
            .filter((t) => t.due !== undefined && t.due >= todayStart && t.due < todayEnd)
            .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
          const future = includeFuture
            ? list
                .filter((t) => t.due !== undefined && t.due >= todayEnd)
                .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))
            : [];
          const noDue = list
            .filter((t) => t.due === undefined)
            .sort((a, b) => a.createdAt - b.createdAt);
          const ordered = [...overdue, ...today, ...future, ...noDue];
          const lines = ordered.map((t, i) => {
            const isOverdue = t.due !== undefined && t.due < todayStart;
            const isFuture = t.due !== undefined && t.due >= todayEnd;
            const marker = isOverdue ? " (atrasada)" : isFuture ? " (futura)" : "";
            return `${i + 1}. ${t.description}${marker} (id=${t.taskId})`;
          });
          if (result.hasMore) {
            lines.push(`Showing first ${result.limit} open tasks; more are hidden.`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        },
      ),

      tool(
        "mark_done",
        `Mark a task as closed.

Resolve "feito a 1" / "feito o do dentista" / "esquece a 4" / "remove a 4" to a taskId by reading the most recent list_tasks output. If the target may be future-dated or is not visible in the normal list, call list_tasks with includeFuture=true first, then pass that taskId here. "Done" and "esquece"/"remove" both map to closed in v1 — there is no separate dismiss state.`,
        {
          taskId: z.string().describe("The taskId to close."),
        },
        async (args) => {
          const id = await convex.mutation(api.tasks.markClosed, {
            taskId: args.taskId,
            conversationId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: id
                  ? `Closed task ${args.taskId}.`
                  : `Task ${args.taskId} not found in this conversation.`,
              },
            ],
          };
        },
      ),

      tool(
        "update_task",
        `Edit a task's description and/or prazo.

Triggers: "renomeia a 1 pra X", "muda prazo da 2 pra sexta", "antecipa a 3 pra amanhã", "adia a 1 pra quinta às 14h".

Resolve the user's numeric or fuzzy reference to a taskId via the most recent list_tasks output (or by calling list_tasks with \`includeFuture=true\` first if the target may be future-dated). Pass at least one of \`description\` or \`due\`. \`due\` follows the same ISO convention as create_task: \`YYYY-MM-DD\` for date-only, \`YYYY-MM-DDTHH:MM\` for a precise moment in ${userTimeZone}.`,
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
          const dueMs =
            args.due !== undefined ? parseDueIso(args.due, userTimeZone) : undefined;
          const id = await convex.mutation(api.tasks.update, {
            taskId: args.taskId,
            conversationId,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(dueMs !== undefined ? { due: dueMs } : {}),
          });
          if (!id) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Task ${args.taskId} not found in this conversation.`,
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
