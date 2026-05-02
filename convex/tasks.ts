import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const DEFAULT_OPEN_TASK_LIMIT = 25;
const MAX_OPEN_TASK_LIMIT = 50;
const MIN_DUE_MS = 0;

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_OPEN_TASK_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_OPEN_TASK_LIMIT);
}

export const create = mutation({
  args: {
    taskId: v.string(),
    conversationId: v.string(),
    description: v.string(),
    due: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("tasks", {
      taskId: args.taskId,
      conversationId: args.conversationId,
      description: args.description,
      status: "open",
      ...(args.due !== undefined ? { due: args.due } : {}),
      createdAt: Date.now(),
    });
  },
});

// Returns open tasks for the conversation. When `todayEndMs` is provided,
// future-dated rows (`due >= todayEndMs`) are filtered out so callers see
// only overdue + due-today + no-due. The TZ-sensitive boundary is computed
// by the MCP server with the configured user timezone.
export const listOpen = query({
  args: {
    conversationId: v.string(),
    todayEndMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = boundedLimit(args.limit);

    if (args.todayEndMs === undefined) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversationId", args.conversationId).eq("status", "open"),
        )
        .order("asc")
        .take(limit + 1);
      return {
        tasks: tasks.slice(0, limit),
        hasMore: tasks.length > limit,
        limit,
      };
    }

    const dueTasks = await ctx.db
      .query("tasks")
      .withIndex("by_conversation_status_due", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("status", "open")
          .gte("due", MIN_DUE_MS)
          .lt("due", args.todayEndMs!),
      )
      .order("asc")
      .take(limit + 1);

    const remaining = Math.max(limit + 1 - dueTasks.length, 0);
    const noDueTasks =
      remaining === 0
        ? []
        : await ctx.db
            .query("tasks")
            .withIndex("by_conversation_status_due", (q) =>
              q
                .eq("conversationId", args.conversationId)
                .eq("status", "open")
                .eq("due", undefined),
            )
            .order("asc")
            .take(remaining);

    const tasks = [...dueTasks, ...noDueTasks];
    return {
      tasks: tasks.slice(0, limit),
      hasMore: tasks.length > limit,
      limit,
    };
  },
});

export const get = query({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
  },
});

export const markClosed = mutation({
  args: { taskId: v.string(), conversationId: v.string() },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (!t || t.conversationId !== args.conversationId) return null;
    if (t.status === "closed") return t._id;
    await ctx.db.patch(t._id, {
      status: "closed",
      closedAt: Date.now(),
    });
    return t._id;
  },
});

export const update = mutation({
  args: {
    taskId: v.string(),
    conversationId: v.string(),
    description: v.optional(v.string()),
    due: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (!t || t.conversationId !== args.conversationId) return null;
    const patch: { description?: string; due?: number } = {};
    if (args.description !== undefined) patch.description = args.description;
    if (args.due !== undefined) patch.due = args.due;
    if (Object.keys(patch).length === 0) return t._id;
    await ctx.db.patch(t._id, patch);
    return t._id;
  },
});
