import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const claim = mutation({
  args: {
    provider: v.string(),
    handle: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookDedup")
      .withIndex("by_provider_handle", (q) =>
        q.eq("provider", args.provider).eq("handle", args.handle),
      )
      .unique();
    if (existing) return { claimed: false };
    await ctx.db.insert("webhookDedup", {
      provider: args.provider,
      handle: args.handle,
      claimedAt: Date.now(),
    });
    return { claimed: true };
  },
});
