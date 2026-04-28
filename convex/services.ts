import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("services").collect();
  },
});

export const get = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("services")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
  },
});

export const monthlyTotal = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("services").collect();
    return all.reduce((sum, s) => sum + s.monthlyCostUsd, 0);
  },
});

export const upsert = mutation({
  args: {
    key: v.string(),
    displayName: v.string(),
    monthlyCostUsd: v.number(),
    planName: v.optional(v.string()),
    planLimits: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("services")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        monthlyCostUsd: args.monthlyCostUsd,
        planName: args.planName,
        planLimits: args.planLimits,
        notes: args.notes,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("services", {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setUsageSnapshot = mutation({
  args: {
    key: v.string(),
    usageSnapshot: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("services")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (!existing) return null;
    await ctx.db.patch(existing._id, {
      usageSnapshot: args.usageSnapshot,
      lastFetchAt: Date.now(),
      updatedAt: Date.now(),
    });
    return existing._id;
  },
});

export const remove = mutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("services")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (!existing) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});
