import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

This is slice 1 — no due dates, no nags. Just description.`,
        {
          description: z
            .string()
            .describe("What the task is, in plain language, in the user's voice."),
        },
        async (args) => {
          const taskId = randomId("tk");
          await convex.mutation(api.tasks.create, {
            taskId,
            conversationId,
            description: args.description,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Created task ${taskId}: ${args.description}`,
              },
            ],
          };
        },
      ),

      tool(
        "list_tasks",
        `List all OPEN tasks for this conversation, with their IDs.

Returns numbered lines: "N. <description> (id=<taskId>)". When relaying to the user, OMIT the "(id=...)" parts — show only the number and description.`,
        {},
        async () => {
          const list = await convex.query(api.tasks.listOpen, { conversationId });
          if (list.length === 0) {
            return { content: [{ type: "text" as const, text: "No open tasks." }] };
          }
          const lines = list.map(
            (t, i) => `${i + 1}. ${t.description} (id=${t.taskId})`,
          );
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
    ],
  });
}
