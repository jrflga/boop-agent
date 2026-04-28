import { query } from "./_generated/server.js";
import { v } from "convex/values";
import { rangeStart, type RangeKey } from "./lib/timeRange.js";

const rangeV = v.union(
  v.literal("today"),
  v.literal("7d"),
  v.literal("30d"),
  v.literal("all"),
);

const sourceFilterV = v.optional(
  v.union(
    v.literal("dispatcher"),
    v.literal("execution"),
    v.literal("extract"),
    v.literal("consolidation-proposer"),
    v.literal("consolidation-adversary"),
    v.literal("consolidation-judge"),
  ),
);

// Cap the scan to keep queries bounded as usageRecords grows. Convex's
// hard collect() limit is 16,384.
const SCAN_CAP = 10_000;

async function scanRange(
  ctx: { db: any },
  range: RangeKey,
  filter?: { source?: string; conversationId?: string },
) {
  const start = rangeStart(range);
  const all = await ctx.db
    .query("usageRecords")
    .withIndex("by_created_at", (q: any) => q.gte("createdAt", start))
    .order("desc")
    .take(SCAN_CAP);
  if (!filter) return all;
  return all.filter((r: any) => {
    if (filter.source && r.source !== filter.source) return false;
    if (filter.conversationId && r.conversationId !== filter.conversationId) return false;
    return true;
  });
}

export const summary = query({
  args: {
    range: rangeV,
    source: sourceFilterV,
    conversationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await scanRange(ctx, args.range, {
      source: args.source,
      conversationId: args.conversationId,
    });
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    for (const r of rows) {
      costUsd += r.costUsd;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      cacheReadTokens += r.cacheReadTokens;
      cacheCreationTokens += r.cacheCreationTokens;
    }
    const cachedReadable = cacheReadTokens + inputTokens;
    const cacheHitRate = cachedReadable > 0 ? cacheReadTokens / cachedReadable : 0;
    return {
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      callCount: rows.length,
      cacheHitRate,
    };
  },
});

export const bySource = query({
  args: { range: rangeV },
  handler: async (ctx, args) => {
    const rows = await scanRange(ctx, args.range);
    const buckets = new Map<
      string,
      {
        source: string;
        costUsd: number;
        callCount: number;
        inputTokens: number;
        cacheReadTokens: number;
      }
    >();
    for (const r of rows) {
      const b = buckets.get(r.source) ?? {
        source: r.source,
        costUsd: 0,
        callCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
      };
      b.costUsd += r.costUsd;
      b.callCount += 1;
      b.inputTokens += r.inputTokens;
      b.cacheReadTokens += r.cacheReadTokens;
      buckets.set(r.source, b);
    }
    return [...buckets.values()].map((b) => ({
      source: b.source,
      costUsd: b.costUsd,
      callCount: b.callCount,
      cacheHitRate:
        b.cacheReadTokens + b.inputTokens > 0
          ? b.cacheReadTokens / (b.cacheReadTokens + b.inputTokens)
          : 0,
    }));
  },
});
