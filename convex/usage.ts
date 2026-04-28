import { query } from "./_generated/server.js";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { rangeStart, type RangeKey } from "./lib/timeRange.js";
import { savedFromCacheRead } from "./lib/pricing.js";

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

export const byConversation = query({
  args: { range: rangeV, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await scanRange(ctx, args.range);
    const limit = args.limit ?? 10;
    const buckets = new Map<
      string,
      { conversationId: string; costUsd: number; callCount: number; lastActivityAt: number }
    >();
    for (const r of rows) {
      if (!r.conversationId) continue;
      const b = buckets.get(r.conversationId) ?? {
        conversationId: r.conversationId,
        costUsd: 0,
        callCount: 0,
        lastActivityAt: 0,
      };
      b.costUsd += r.costUsd;
      b.callCount += 1;
      if (r.createdAt > b.lastActivityAt) b.lastActivityAt = r.createdAt;
      buckets.set(r.conversationId, b);
    }
    return [...buckets.values()]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, limit);
  },
});

export const byDay = query({
  args: { range: rangeV },
  handler: async (ctx, args) => {
    const rows = await scanRange(ctx, args.range);
    const days = new Map<
      string,
      {
        day: string;
        costUsd: number;
        costBySource: {
          dispatcher: number;
          execution: number;
          extract: number;
          consolidation: number;
        };
      }
    >();
    for (const r of rows) {
      const d = new Date(r.createdAt);
      d.setUTCHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      const bucket = days.get(key) ?? {
        day: key,
        costUsd: 0,
        costBySource: { dispatcher: 0, execution: 0, extract: 0, consolidation: 0 },
      };
      bucket.costUsd += r.costUsd;
      const srcKey: keyof typeof bucket.costBySource = r.source.startsWith("consolidation")
        ? "consolidation"
        : (r.source as "dispatcher" | "execution" | "extract");
      bucket.costBySource[srcKey] += r.costUsd;
      days.set(key, bucket);
    }
    return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  },
});

export const cachingStats = query({
  args: { range: rangeV },
  handler: async (ctx, args) => {
    const rows = await scanRange(ctx, args.range);
    const buckets = new Map<
      string,
      {
        source: string;
        cacheReadTokens: number;
        inputTokens: number;
        savedUsd: number;
      }
    >();
    let totalSavedUsd = 0;
    for (const r of rows) {
      const b = buckets.get(r.source) ?? {
        source: r.source,
        cacheReadTokens: 0,
        inputTokens: 0,
        savedUsd: 0,
      };
      b.cacheReadTokens += r.cacheReadTokens;
      b.inputTokens += r.inputTokens;
      const saved = savedFromCacheRead(r.model, r.cacheReadTokens);
      b.savedUsd += saved;
      totalSavedUsd += saved;
      buckets.set(r.source, b);
    }

    // Broken-cache count: dispatcher records with cacheReadTokens=0 whose
    // immediately-previous dispatcher record on the same conversation was
    // within 5 minutes.
    const dispatcherRows = rows
      .filter((r: any) => r.source === "dispatcher" && r.conversationId)
      .sort((a: any, b: any) => a.createdAt - b.createdAt);
    const lastByConv = new Map<string, { createdAt: number }>();
    let brokenCacheCount = 0;
    for (const r of dispatcherRows) {
      const prev = lastByConv.get(r.conversationId!);
      if (
        prev &&
        r.createdAt - prev.createdAt <= 5 * 60 * 1000 &&
        r.cacheReadTokens === 0
      ) {
        brokenCacheCount += 1;
      }
      lastByConv.set(r.conversationId!, { createdAt: r.createdAt });
    }

    return {
      perSource: [...buckets.values()].map((b) => ({
        source: b.source,
        hitRate:
          b.cacheReadTokens + b.inputTokens > 0
            ? b.cacheReadTokens / (b.cacheReadTokens + b.inputTokens)
            : 0,
        savedUsd: b.savedUsd,
      })),
      totalSavedUsd,
      brokenCacheCount,
    };
  },
});

export const contextSizes = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const rows = await ctx.db
      .query("usageRecords")
      .withIndex("by_conversation", (q: any) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .take(limit);
    return rows.map((r: any) => ({
      turnId: r.turnId,
      createdAt: r.createdAt,
      contextTokens: r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens,
      costUsd: r.costUsd,
      source: r.source,
    }));
  },
});

export const recentRecords = query({
  args: {
    paginationOpts: paginationOptsValidator,
    source: sourceFilterV,
    conversationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("usageRecords")
      .withIndex("by_created_at")
      .order("desc")
      .paginate(args.paginationOpts);
    if (!args.source && !args.conversationId) return result;
    return {
      ...result,
      page: result.page.filter((r: any) => {
        if (args.source && r.source !== args.source) return false;
        if (args.conversationId && r.conversationId !== args.conversationId)
          return false;
        return true;
      }),
    };
  },
});
