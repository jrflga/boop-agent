import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    taskId: v.string(),
    conversationId: v.string(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("tasks", {
      ...args,
      status: "open",
      createdAt: Date.now(),
    });
  },
});

export const listOpen = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "open"),
      )
      .order("asc")
      .collect();
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
