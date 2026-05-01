import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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

// Returns all open tasks for the conversation. When `todayEndMs` is
// provided, future-dated rows (`due >= todayEndMs`) are filtered out so
// callers see only overdue + due-today + no-due. The TZ-sensitive
// boundary is computed in the host process (slice 2 surfaces it from
// the host runtime so Convex stays TZ-agnostic).
export const listOpen = query({
  args: {
    conversationId: v.string(),
    todayEndMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("tasks")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "open"),
      )
      .order("asc")
      .collect();
    if (args.todayEndMs === undefined) return all;
    const cutoff = args.todayEndMs;
    return all.filter((t) => t.due === undefined || t.due < cutoff);
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
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (!t) return null;
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
    description: v.optional(v.string()),
    due: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (!t) return null;
    const patch: { description?: string; due?: number } = {};
    if (args.description !== undefined) patch.description = args.description;
    if (args.due !== undefined) patch.due = args.due;
    if (Object.keys(patch).length === 0) return t._id;
    await ctx.db.patch(t._id, patch);
    return t._id;
  },
});
