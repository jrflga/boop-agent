# Consumo Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cost/consumption monitoring feature with a "Consumo" tab in the debug UI, a `usage_report` MCP tool the dispatcher can call from Telegram, and a disabled-by-default weekly digest automation.

**Architecture:** All three surfaces (UI, dispatcher MCP tool, weekly automation) read the same set of Convex queries over the existing `usageRecords` table. Pure heuristic logic lives in `convex/lib/anomalies.ts` so it can be unit-tested with vitest without bringing up a Convex test environment. Frontend uses recharts.

**Tech Stack:** Convex (backend), React 19 + Tailwind v4 + recharts (debug UI), Claude Agent SDK (MCP tool), vitest (tests for pure logic), TypeScript everywhere.

**Spec:** `docs/superpowers/specs/2026-04-28-consumo-monitor-design.md`

---

## Task 1: Add deps and vitest setup

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install runtime + dev deps**

Run from repo root:
```bash
npm i recharts
npm i -D vitest
```

Expected: both packages added to `package.json`. `recharts` in `dependencies`, `vitest` in `devDependencies`.

- [ ] **Step 2: Add `test` script to package.json**

Edit the `"scripts"` block in `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
```

(Add these two lines after `"typecheck"`.)

- [ ] **Step 3: Create vitest config**

Create `vitest.config.ts` at repo root:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["convex/**/*.test.ts", "server/**/*.test.ts"],
    // Convex's generated files are noisy in coverage; we don't run coverage by default.
    passWithNoTests: false,
  },
});
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: vitest discovers no tests yet and exits non-zero with `No test files found`. That's expected — fix in Task 7.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore(consumo): add recharts and vitest"
```

---

## Task 2: Schema index + pricing helper

**Files:**
- Modify: `convex/schema.ts:113-116`
- Create: `convex/lib/pricing.ts`

(Pricing lives inside `convex/` because Convex queries import from it. Convex's bundler does not allow imports from outside the `convex/` directory in deployed functions. Server code imports from `convex/lib/pricing.js` too.)

- [ ] **Step 1: Add `by_created_at` index to usageRecords**

In `convex/schema.ts`, find the `usageRecords` table definition (around line 92) and add the new index. Replace:

```ts
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_source", ["source"]),
```

With:

```ts
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_source", ["source"])
    .index("by_created_at", ["createdAt"]),
```

- [ ] **Step 2: Push schema to dev Convex**

Run: `npx convex dev --once`
Expected: index builds successfully. No errors.

- [ ] **Step 3: Create `convex/lib/pricing.ts`**

```ts
// Anthropic Claude pricing in USD per million tokens. Update when prices change.
// Used to compute savedUsd estimates (cache read vs uncached input). costUsd
// itself comes from the SDK's msg.total_cost_usd, so this table is only for the
// "you saved $X by caching" calculation.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  // Sonnet family (claude-sonnet-4-6, claude-sonnet-4-6-YYYYMMDD)
  "claude-sonnet-4-6": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  // Opus family (claude-opus-4-7, claude-opus-4-7-YYYYMMDD)
  "claude-opus-4-7": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  // Haiku family (claude-haiku-4-5, claude-haiku-4-5-YYYYMMDD)
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
};

const DEFAULT_PRICE: ModelPrice = PRICES["claude-sonnet-4-6"];

export function priceFor(model: string): ModelPrice {
  // Direct hit
  if (PRICES[model]) return PRICES[model];
  // Prefix match: SDK appends -YYYYMMDD to date-stamped variants
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key];
  }
  return DEFAULT_PRICE;
}

/** Estimate the dollars saved by reading from cache vs paying full input rate. */
export function savedFromCacheRead(model: string, cacheReadTokens: number): number {
  const p = priceFor(model);
  const savedPerMTok = p.inputPerMTok - p.cacheReadPerMTok;
  return (cacheReadTokens * savedPerMTok) / 1_000_000;
}
```

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts convex/lib/pricing.ts
git commit -m "feat(consumo): add usageRecords by_created_at index and pricing helper"
```

---

## Task 3: Time-range utility + summary query + bySource query

**Files:**
- Create: `convex/lib/timeRange.ts`
- Create: `convex/usage.ts`

- [ ] **Step 1: Create the time-range utility**

`convex/lib/timeRange.ts`:

```ts
export type RangeKey = "today" | "7d" | "30d" | "all";

export const RANGE_VALUES: RangeKey[] = ["today", "7d", "30d", "all"];

/** Returns ms-since-epoch lower bound for `range`. `all` returns 0. */
export function rangeStart(range: RangeKey, now: number = Date.now()): number {
  const dayMs = 24 * 60 * 60 * 1000;
  switch (range) {
    case "today": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return now - 7 * dayMs;
    case "30d":
      return now - 30 * dayMs;
    case "all":
      return 0;
  }
}
```

- [ ] **Step 2: Create `convex/usage.ts` with the rangeV validator + summary + bySource queries**

```ts
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
```

- [ ] **Step 3: Verify**

Run: `npx convex dev --once`
Expected: no type errors. Functions registered.

- [ ] **Step 4: Manual smoke test**

In a fresh terminal:
```bash
npx convex run usage:summary '{"range":"7d"}'
npx convex run usage:bySource '{"range":"7d"}'
```
Expected: returns `{ costUsd, inputTokens, ... }` and an array. Values may be zero on a fresh DB; structure should match.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/timeRange.ts convex/usage.ts
git commit -m "feat(consumo): add usage.summary and usage.bySource queries"
```

---

## Task 4: byConversation + byDay queries

**Files:**
- Modify: `convex/usage.ts`

- [ ] **Step 1: Append `byConversation` and `byDay` to `convex/usage.ts`**

Add after the `bySource` export:

```ts
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
```

- [ ] **Step 2: Verify**

Run: `npx convex dev --once`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add convex/usage.ts
git commit -m "feat(consumo): add usage.byConversation and usage.byDay queries"
```

---

## Task 5: cachingStats + contextSizes queries

**Files:**
- Modify: `convex/usage.ts`

- [ ] **Step 1: Append `cachingStats` and `contextSizes` to `convex/usage.ts`**

First, add the import at the top:

```ts
import { savedFromCacheRead } from "./lib/pricing.js";
```

Then append:

```ts
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
```

- [ ] **Step 2: Verify**

Run: `npx convex dev --once`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add convex/usage.ts
git commit -m "feat(consumo): add cachingStats and contextSizes queries"
```

---

## Task 6: recentRecords paginated query

**Files:**
- Modify: `convex/usage.ts`

- [ ] **Step 1: Append paginated query**

Add to top of file:
```ts
import { paginationOptsValidator } from "convex/server";
```

Then append:

```ts
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
```

- [ ] **Step 2: Verify**

Run: `npx convex dev --once`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add convex/usage.ts
git commit -m "feat(consumo): add usage.recentRecords paginated query"
```

---

## Task 7: Pure heuristics + vitest tests

**Files:**
- Create: `convex/lib/anomalies.ts`
- Create: `convex/lib/anomalies.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `convex/lib/anomalies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectAnomalies, type UsageRow } from "./anomalies.js";

const dayMs = 24 * 60 * 60 * 1000;
const now = new Date("2026-04-28T12:00:00Z").getTime();

function row(partial: Partial<UsageRow> = {}): UsageRow {
  return {
    _id: "r" + Math.random().toString(36).slice(2),
    source: "dispatcher",
    conversationId: "conv1",
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 4000,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    createdAt: now,
    ...partial,
  };
}

describe("detectAnomalies", () => {
  it("flags cost spike when 7d > 2x median of prior 4 weeks", () => {
    const rows: UsageRow[] = [];
    // 4 prior weeks at $0.10 each
    for (let w = 1; w <= 4; w++) {
      rows.push(row({ costUsd: 0.1, createdAt: now - w * 7 * dayMs - dayMs }));
    }
    // current week at $0.50 (5x median)
    rows.push(row({ costUsd: 0.5, createdAt: now - dayMs }));

    const result = detectAnomalies(rows, "7d", now);
    const spike = result.find((a) => a.kind === "cost_spike");
    expect(spike).toBeDefined();
    expect(spike?.severity).toBe("high");
  });

  it("does not flag cost spike when fewer than 2 prior weeks of data", () => {
    const rows: UsageRow[] = [
      row({ costUsd: 0.5, createdAt: now - dayMs }),
      row({ costUsd: 0.1, createdAt: now - 8 * dayMs }),
    ];
    const result = detectAnomalies(rows, "7d", now);
    expect(result.find((a) => a.kind === "cost_spike")).toBeUndefined();
  });

  it("flags low cache hit when dispatcher rate < 0.5 with >= 10 calls", () => {
    const rows: UsageRow[] = [];
    for (let i = 0; i < 12; i++) {
      rows.push(
        row({
          source: "dispatcher",
          inputTokens: 1000,
          cacheReadTokens: 100, // hit rate ~9%
          createdAt: now - i * 60_000,
        }),
      );
    }
    const result = detectAnomalies(rows, "7d", now);
    const low = result.find((a) => a.kind === "low_cache_hit");
    expect(low).toBeDefined();
    expect(low?.severity).toBe("medium");
  });

  it("does not flag low cache hit with fewer than 10 calls", () => {
    const rows: UsageRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(row({ inputTokens: 1000, cacheReadTokens: 0 }));
    }
    const result = detectAnomalies(rows, "7d", now);
    expect(result.find((a) => a.kind === "low_cache_hit")).toBeUndefined();
  });

  it("flags broken cache when >= 5 dispatcher turns lose cache within TTL", () => {
    const rows: UsageRow[] = [];
    // First turn (always cold), then 6 quick turns with cacheReadTokens=0
    rows.push(
      row({
        cacheReadTokens: 5000,
        inputTokens: 100,
        createdAt: now - 60_000 * 7,
      }),
    );
    for (let i = 6; i >= 1; i--) {
      rows.push(
        row({
          cacheReadTokens: 0,
          inputTokens: 5000,
          createdAt: now - 60_000 * i, // 1 min apart, all within 5min TTL
        }),
      );
    }
    const result = detectAnomalies(rows, "7d", now);
    const broken = result.find((a) => a.kind === "broken_cache");
    expect(broken).toBeDefined();
  });

  it("flags giant turn when input + cacheRead > 100k", () => {
    const rows: UsageRow[] = [
      row({ inputTokens: 60_000, cacheReadTokens: 50_000, _id: "BIG" }),
    ];
    const result = detectAnomalies(rows, "7d", now);
    const big = result.find((a) => a.kind === "giant_turn");
    expect(big).toBeDefined();
    expect(big?.ref).toEqual({ recordId: "BIG", agentId: undefined });
  });

  it("returns empty array on empty input", () => {
    expect(detectAnomalies([], "7d", now)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npm test`
Expected: errors because `convex/lib/anomalies.ts` does not exist.

- [ ] **Step 3: Implement the heuristics**

Create `convex/lib/anomalies.ts`:

```ts
import { rangeStart, type RangeKey } from "./timeRange.js";

export interface UsageRow {
  _id: string;
  source: string;
  conversationId?: string;
  agentId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  createdAt: number;
}

export type AnomalyKind =
  | "cost_spike"
  | "low_cache_hit"
  | "broken_cache"
  | "giant_turn";

export interface Anomaly {
  kind: AnomalyKind;
  severity: "low" | "medium" | "high";
  message: string;
  ref?: { recordId?: string; agentId?: string };
}

const dayMs = 24 * 60 * 60 * 1000;
const weekMs = 7 * dayMs;
const fiveMinMs = 5 * 60 * 1000;
const GIANT_TURN_THRESHOLD = 100_000;
const LOW_CACHE_HIT_MIN_CALLS = 10;
const LOW_CACHE_HIT_THRESHOLD = 0.5;
const BROKEN_CACHE_MIN_OCCURRENCES = 5;
const COST_SPIKE_MULTIPLIER = 2;

/**
 * Detect anomalies over the given rows. Cost-spike heuristic uses fixed 7d/4w
 * windows independent of `range`; the others honor `range` (which is encoded
 * in which rows the caller provides).
 *
 * `rows` should already be filtered to the caller's `range` (we recompute
 * cost spike from full history we receive — caller passes everything inside
 * a 5-week window for this heuristic to function).
 */
export function detectAnomalies(
  rows: UsageRow[],
  range: RangeKey,
  now: number = Date.now(),
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // 1. Cost spike: this week vs median of prior 4 weeks
  const weekBoundary = now - weekMs;
  const fourWeeksAgo = now - 5 * weekMs;
  const thisWeek = rows
    .filter((r) => r.createdAt >= weekBoundary && r.createdAt < now)
    .reduce((s, r) => s + r.costUsd, 0);
  const priorByWeek: number[] = [0, 0, 0, 0];
  for (const r of rows) {
    if (r.createdAt < fourWeeksAgo || r.createdAt >= weekBoundary) continue;
    const w = Math.floor((weekBoundary - r.createdAt) / weekMs);
    if (w >= 0 && w < 4) priorByWeek[w] += r.costUsd;
  }
  const priorWithData = priorByWeek.filter((w) => w > 0);
  if (priorWithData.length >= 2) {
    const median = medianOf(priorWithData);
    if (median > 0 && thisWeek > COST_SPIKE_MULTIPLIER * median) {
      anomalies.push({
        kind: "cost_spike",
        severity: "high",
        message: `Esta semana: $${thisWeek.toFixed(2)} vs mediana das semanas anteriores: $${median.toFixed(2)}`,
      });
    }
  }

  // 2. Low cache hit on dispatcher in `range`
  const rangeStartMs = rangeStart(range, now);
  const dispatcherInRange = rows.filter(
    (r) => r.source === "dispatcher" && r.createdAt >= rangeStartMs,
  );
  if (dispatcherInRange.length >= LOW_CACHE_HIT_MIN_CALLS) {
    const cacheRead = dispatcherInRange.reduce((s, r) => s + r.cacheReadTokens, 0);
    const input = dispatcherInRange.reduce((s, r) => s + r.inputTokens, 0);
    const denom = cacheRead + input;
    const rate = denom > 0 ? cacheRead / denom : 0;
    if (rate < LOW_CACHE_HIT_THRESHOLD) {
      anomalies.push({
        kind: "low_cache_hit",
        severity: "medium",
        message: `Dispatcher cache hit ${(rate * 100).toFixed(0)}% (alvo >= 70%)`,
      });
    }
  }

  // 3. Broken cache on dispatcher in `range`
  const dispatcherSorted = dispatcherInRange
    .filter((r) => r.conversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const lastByConv = new Map<string, number>();
  let broken = 0;
  for (const r of dispatcherSorted) {
    const prev = lastByConv.get(r.conversationId!);
    if (prev !== undefined && r.createdAt - prev <= fiveMinMs && r.cacheReadTokens === 0) {
      broken += 1;
    }
    lastByConv.set(r.conversationId!, r.createdAt);
  }
  if (broken >= BROKEN_CACHE_MIN_OCCURRENCES) {
    anomalies.push({
      kind: "broken_cache",
      severity: "medium",
      message: `${broken} turnos do dispatcher perderam cache dentro do TTL de 5 min`,
    });
  }

  // 4. Giant turn(s) in range
  for (const r of rows) {
    if (r.createdAt < rangeStartMs) continue;
    if (r.inputTokens + r.cacheReadTokens > GIANT_TURN_THRESHOLD) {
      const totalK = ((r.inputTokens + r.cacheReadTokens) / 1000).toFixed(0);
      anomalies.push({
        kind: "giant_turn",
        severity: "low",
        message: `Chamada ${r.source} com ${totalK}k tokens de contexto`,
        ref: { recordId: r._id, agentId: r.agentId },
      });
    }
  }

  return anomalies;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/anomalies.ts convex/lib/anomalies.test.ts
git commit -m "feat(consumo): add anomaly heuristics with vitest tests"
```

---

## Task 8: anomalies Convex query

**Files:**
- Modify: `convex/usage.ts`

- [ ] **Step 1: Append anomalies query**

Add import to top of `convex/usage.ts`:

```ts
import { detectAnomalies } from "./lib/anomalies.js";
```

Then append:

```ts
export const anomalies = query({
  args: { range: rangeV },
  handler: async (ctx, args) => {
    // Always pull a 5-week window; cost_spike needs prior weeks regardless
    // of the caller's `range`.
    const fiveWeeksAgo = Date.now() - 5 * 7 * 24 * 60 * 60 * 1000;
    const start = Math.min(rangeStart(args.range), fiveWeeksAgo);
    const rows = await ctx.db
      .query("usageRecords")
      .withIndex("by_created_at", (q: any) => q.gte("createdAt", start))
      .order("desc")
      .take(SCAN_CAP);
    return detectAnomalies(rows as any, args.range);
  },
});
```

- [ ] **Step 2: Verify**

Run: `npx convex dev --once`
Expected: no type errors.

- [ ] **Step 3: Smoke test**

```bash
npx convex run usage:anomalies '{"range":"7d"}'
```
Expected: returns `[]` on empty/healthy data.

- [ ] **Step 4: Commit**

```bash
git add convex/usage.ts
git commit -m "feat(consumo): add usage.anomalies query"
```

---

## Task 9: automations.getByName

**Files:**
- Modify: `convex/automations.ts`

- [ ] **Step 1: Append getByName query**

In `convex/automations.ts`, find the existing `get` export (around line 45) and add right after it:

```ts
export const getByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("automations")
      .filter((q) => q.eq(q.field("name"), args.name))
      .first();
  },
});
```

- [ ] **Step 2: Verify**

Run: `npx convex dev --once`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add convex/automations.ts
git commit -m "feat(consumo): add automations.getByName query"
```

---

## Task 10: usage_report MCP tool

**Files:**
- Create: `server/usage-report-tools.ts`
- Create: `server/usage-report-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/usage-report-tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildUsageReport } from "./usage-report-tools.js";

describe("buildUsageReport", () => {
  it("calls Convex queries with the right args and assembles the report", async () => {
    const mockSummary = {
      costUsd: 1.23,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 4000,
      cacheCreationTokens: 200,
      callCount: 10,
      cacheHitRate: 0.8,
    };
    const mockBySource = [{ source: "dispatcher", costUsd: 1.0, callCount: 8, cacheHitRate: 0.85 }];
    const mockTop = [{ conversationId: "conv1", costUsd: 0.9, callCount: 5, lastActivityAt: 1 }];
    const mockAnomalies: any[] = [];

    const fakeConvex = {
      query: vi.fn(async (fn: any, args: any) => {
        const fnName = fn?._name ?? fn?.toString?.() ?? "";
        if (fnName.includes("summary")) return mockSummary;
        if (fnName.includes("bySource")) return mockBySource;
        if (fnName.includes("byConversation")) return mockTop;
        if (fnName.includes("anomalies")) return mockAnomalies;
        return null;
      }),
    };

    const report = await buildUsageReport(fakeConvex as any, {
      range: "7d",
      source: undefined,
      conversationId: undefined,
    });

    expect(report).toMatchObject({
      range: "7d",
      summary: mockSummary,
      bySource: mockBySource,
      top: mockTop,
      anomalies: mockAnomalies,
    });
    expect(fakeConvex.query).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

Run: `npm test`
Expected: error — `server/usage-report-tools.ts` not found.

- [ ] **Step 3: Implement the MCP server**

Create `server/usage-report-tools.ts`:

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import type { ConvexClient } from "convex/browser";

const RANGE_VALUES = ["today", "7d", "30d", "all"] as const;
const SOURCE_VALUES = [
  "dispatcher",
  "execution",
  "extract",
  "consolidation-proposer",
  "consolidation-adversary",
  "consolidation-judge",
] as const;

interface ReportArgs {
  range: (typeof RANGE_VALUES)[number];
  source?: (typeof SOURCE_VALUES)[number];
  conversationId?: string;
}

/**
 * Pure function: takes a Convex client (or any object with a compatible
 * `.query` method) and produces the report object. Extracted so we can
 * unit-test without spinning up the SDK runtime.
 */
export async function buildUsageReport(
  convex: Pick<ConvexClient, "query">,
  args: ReportArgs,
) {
  const [summary, bySource, top, anomalies] = await Promise.all([
    convex.query(api.usage.summary, {
      range: args.range,
      source: args.source,
      conversationId: args.conversationId,
    }),
    convex.query(api.usage.bySource, { range: args.range }),
    convex.query(api.usage.byConversation, { range: args.range, limit: 5 }),
    convex.query(api.usage.anomalies, { range: args.range }),
  ]);
  return { range: args.range, summary, bySource, top, anomalies };
}

export function createUsageReportMcp(convex: Pick<ConvexClient, "query">) {
  return createSdkMcpServer({
    name: "boop-usage",
    version: "0.1.0",
    tools: [
      tool(
        "usage_report",
        `Retorna um relatório estruturado de consumo de LLM (custo, tokens, cache hit, top conversas, anomalias). Use quando o usuário perguntar sobre custos, gastos, uso de tokens, cache, ou consumo. Range default é 7d. Pass conversationId pra filtrar uma conversa específica.`,
        {
          range: z.enum(RANGE_VALUES).default("7d").describe("Janela de tempo"),
          source: z
            .enum(SOURCE_VALUES)
            .optional()
            .describe("Filtrar por origem (dispatcher, execution, etc.)"),
          conversationId: z
            .string()
            .optional()
            .describe("Filtrar por conversationId"),
        },
        async (args: ReportArgs) => {
          const report = await buildUsageReport(convex, args);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(report, null, 2) },
            ],
          };
        },
      ),
    ],
  });
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test`
Expected: all tests pass (anomalies tests + the new buildUsageReport test).

- [ ] **Step 5: Commit**

```bash
git add server/usage-report-tools.ts server/usage-report-tools.test.ts
git commit -m "feat(consumo): add usage_report MCP tool"
```

---

## Task 11: Wire boop-usage MCP into interaction-agent

**Files:**
- Modify: `server/interaction-agent.ts`

- [ ] **Step 1: Add import**

In `server/interaction-agent.ts`, after the existing imports (around line 14), add:

```ts
import { createUsageReportMcp } from "./usage-report-tools.js";
```

- [ ] **Step 2: Construct the MCP server inside `handleUserMessage`**

After the line that creates `selfServer = createSelfMcp();` (around line 157), add:

```ts
  const usageServer = createUsageReportMcp(convex);
```

- [ ] **Step 3: Register in `mcpServers` map**

Find the `mcpServers: { ... }` block (around line 266) and add `"boop-usage": usageServer,` to it. Final shape:

```ts
        mcpServers: {
          "boop-memory": memoryServer,
          "boop-spawn": spawnServer,
          "boop-automations": automationServer,
          "boop-draft-decisions": draftDecisionServer,
          "boop-ack": ackServer,
          "boop-self": selfServer,
          "boop-usage": usageServer,
        },
```

- [ ] **Step 4: Add to `allowedTools`**

In the same `query()` call, add to the `allowedTools` array:

```ts
          "mcp__boop-usage__usage_report",
```

- [ ] **Step 5: Update dispatcher system prompt**

Find the section "Self-inspection (no spawn needed, answer instantly):" in `INTERACTION_SYSTEM` (around line 117) and add a new paragraph right after that block:

```ts
Custos e consumo (no spawn needed, answer instantly):
- "quanto gastei essa semana?" / "how much did I spend?" → usage_report (default range 7d)
- "consumo de hoje" → usage_report({range: "today"})
- "como tá meu cache?" → usage_report e fala do cache hit rate
- Fale o relatório de forma natural; não despeje JSON.
```

Also add `"usage_report"` to the "Your only tools" list (line ~50): change

```ts
- get_config / set_model / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)
```

to:

```ts
- get_config / set_model / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)
- usage_report (cost / token consumption reports)
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add server/interaction-agent.ts
git commit -m "feat(consumo): wire boop-usage MCP into interaction-agent"
```

---

## Task 12: cost-digest automation registration helper

**Files:**
- Create: `server/cost-digest.ts`

- [ ] **Step 1: Create the helper**

`server/cost-digest.ts`:

```ts
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { nextRunFor } from "./automations.js";

const COST_DIGEST_NAME = "cost-digest";

const COST_DIGEST_TASK = `Use a tool usage_report({range: "7d"}).

Produza um resumo curto (5-8 linhas) em português:
- Custo total da semana
- Cache hit rate por source (destaque se algum < 50%)
- Top 3 conversas mais caras
- Anomalias detectadas (se houver)

Se houver anomalia com severity "high", prefixe a mensagem com "ALERTAS:".
Tom: relatório seco, sem saudação, sem floreio. Não use em-dashes.`;

const COST_DIGEST_SCHEDULE = "0 9 * * 0"; // Sunday 9am

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Idempotent: ensures a "cost-digest" automation row exists. Always created
 * disabled by default; the user enables via Telegram (toggle_automation).
 */
export async function ensureCostDigestAutomation(
  defaultNotifyConversationId?: string,
): Promise<void> {
  const existing = await convex.query(api.automations.getByName, {
    name: COST_DIGEST_NAME,
  });
  if (existing) return;

  const automationId = randomId("auto");
  const nextRunAt = nextRunFor(COST_DIGEST_SCHEDULE) ?? undefined;

  await convex.mutation(api.automations.create, {
    automationId,
    name: COST_DIGEST_NAME,
    task: COST_DIGEST_TASK,
    integrations: [],
    schedule: COST_DIGEST_SCHEDULE,
    notifyConversationId: defaultNotifyConversationId,
    nextRunAt,
  });

  // The default `create` mutation marks new rows enabled=true. We want the
  // digest disabled by default so the user opts in explicitly.
  await convex.mutation(api.automations.setEnabled, {
    automationId,
    enabled: false,
  });
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add server/cost-digest.ts
git commit -m "feat(consumo): add ensureCostDigestAutomation helper"
```

---

## Task 13: Wire ensure helper on boot

**Files:**
- Modify: `server/automations.ts`

- [ ] **Step 1: Find `startAutomationLoop` and call the helper**

Open `server/automations.ts`. Find the export `startAutomationLoop` (search for `export function startAutomationLoop` or similar). Inside its body, before the existing polling-loop setup, add:

```ts
  // Idempotent: registers (disabled) on first boot, no-ops thereafter.
  ensureCostDigestAutomation().catch((err) =>
    console.error("[automations] ensureCostDigestAutomation failed", err),
  );
```

And add the import at the top of the file:

```ts
import { ensureCostDigestAutomation } from "./cost-digest.js";
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Smoke test by booting the server**

In a separate terminal:
```bash
npm run dev:server
```
Watch the logs. Expected: no error mentioning `ensureCostDigestAutomation`. Then check Convex:

```bash
npx convex run automations:getByName '{"name":"cost-digest"}'
```
Expected: returns an automation row with `enabled: false`, `schedule: "0 9 * * 0"`. Run again — same row, no duplicate.

- [ ] **Step 4: Commit**

```bash
git add server/automations.ts
git commit -m "feat(consumo): register cost-digest automation on boot"
```

---

## Task 14: AnomalyBadge component

**Files:**
- Create: `debug/src/components/consumo/AnomalyBadge.tsx`

- [ ] **Step 1: Create the component**

```tsx
interface Anomaly {
  kind: "cost_spike" | "low_cache_hit" | "broken_cache" | "giant_turn";
  severity: "low" | "medium" | "high";
  message: string;
}

interface Props {
  anomalies: Anomaly[];
  isDark: boolean;
}

const SEVERITY_COLOR: Record<string, { dark: string; light: string }> = {
  high: { dark: "bg-rose-900/40 text-rose-300 border-rose-700/50", light: "bg-rose-100 text-rose-700 border-rose-300" },
  medium: { dark: "bg-amber-900/40 text-amber-300 border-amber-700/50", light: "bg-amber-100 text-amber-700 border-amber-300" },
  low: { dark: "bg-slate-800 text-slate-400 border-slate-700", light: "bg-slate-100 text-slate-600 border-slate-300" },
};

export function AnomalyBadge({ anomalies, isDark }: Props) {
  if (anomalies.length === 0) return null;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const a of anomalies) counts[a.severity] += 1;

  return (
    <div className="flex flex-col gap-1.5">
      {anomalies.map((a, i) => {
        const c = SEVERITY_COLOR[a.severity];
        const cls = isDark ? c.dark : c.light;
        return (
          <div
            key={i}
            className={`text-xs px-2.5 py-1.5 rounded border ${cls}`}
            title={a.kind}
          >
            {a.message}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/consumo/AnomalyBadge.tsx
git commit -m "feat(consumo): add AnomalyBadge component"
```

---

## Task 15: KpiCards component

**Files:**
- Create: `debug/src/components/consumo/KpiCards.tsx`

- [ ] **Step 1: Create the component**

```tsx
interface Summary {
  costUsd: number;
  callCount: number;
  cacheHitRate: number;
}

interface TopConversation {
  conversationId: string;
  costUsd: number;
  callCount: number;
}

interface Props {
  summary: Summary | undefined;
  top: TopConversation | undefined;
  isDark: boolean;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function shortConv(id: string): string {
  if (id.startsWith("telegram:")) return id.slice(9);
  return id.length > 12 ? id.slice(0, 12) + "..." : id;
}

export function KpiCards({ summary, top, isDark }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const labelCls = isDark ? "text-slate-500" : "text-slate-500";
  const valueCls = isDark ? "text-slate-100" : "text-slate-900";

  const cards = [
    {
      label: "Custo total",
      value: summary ? fmtUsd(summary.costUsd) : "—",
      sub: summary ? `${summary.callCount} chamadas` : "carregando...",
    },
    {
      label: "Cache hit",
      value: summary ? fmtPct(summary.cacheHitRate) : "—",
      sub: "input tokens cacheados",
    },
    {
      label: "$ / chamada",
      value:
        summary && summary.callCount > 0
          ? fmtUsd(summary.costUsd / summary.callCount)
          : "—",
      sub: "média no período",
    },
    {
      label: "Top conversa",
      value: top ? fmtUsd(top.costUsd) : "—",
      sub: top ? shortConv(top.conversationId) : "sem dados",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className={`border rounded-lg p-4 ${cardCls}`}
        >
          <div className={`text-[11px] uppercase tracking-wide ${labelCls}`}>
            {c.label}
          </div>
          <div className={`text-2xl font-bold mono mt-1 ${valueCls}`}>
            {c.value}
          </div>
          <div className={`text-xs ${labelCls} mt-1`}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/consumo/KpiCards.tsx
git commit -m "feat(consumo): add KpiCards component"
```

---

## Task 16: DailyCostChart component

**Files:**
- Create: `debug/src/components/consumo/DailyCostChart.tsx`

- [ ] **Step 1: Create the component**

```tsx
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface DayPoint {
  day: string;
  costUsd: number;
  costBySource: {
    dispatcher: number;
    execution: number;
    extract: number;
    consolidation: number;
  };
}

interface Props {
  data: DayPoint[] | undefined;
  isDark: boolean;
}

const COLORS = {
  dispatcher: "#3b82f6", // blue
  execution: "#10b981", // emerald
  extract: "#a855f7", // purple
  consolidation: "#f59e0b", // amber
};

export function DailyCostChart({ data, isDark }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";

  const chartData = (data ?? []).map((d) => ({
    day: d.day.slice(5), // MM-DD
    dispatcher: d.costBySource.dispatcher,
    execution: d.costBySource.execution,
    extract: d.costBySource.extract,
    consolidation: d.costBySource.consolidation,
  }));

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className={`text-sm font-semibold mb-3 ${titleCls}`}>Custo diário</div>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <AreaChart data={chartData}>
            <CartesianGrid stroke={isDark ? "#1e293b" : "#e2e8f0"} strokeDasharray="3 3" />
            <XAxis dataKey="day" stroke={isDark ? "#64748b" : "#94a3b8"} fontSize={11} />
            <YAxis
              stroke={isDark ? "#64748b" : "#94a3b8"}
              fontSize={11}
              tickFormatter={(v) => `$${v.toFixed(2)}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? "#0f172a" : "#fff",
                border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(v: number) => `$${v.toFixed(4)}`}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="dispatcher" stackId="1" stroke={COLORS.dispatcher} fill={COLORS.dispatcher} />
            <Area type="monotone" dataKey="execution" stackId="1" stroke={COLORS.execution} fill={COLORS.execution} />
            <Area type="monotone" dataKey="extract" stackId="1" stroke={COLORS.extract} fill={COLORS.extract} />
            <Area type="monotone" dataKey="consolidation" stackId="1" stroke={COLORS.consolidation} fill={COLORS.consolidation} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/consumo/DailyCostChart.tsx
git commit -m "feat(consumo): add DailyCostChart component"
```

---

## Task 17: CachingPanel component

**Files:**
- Create: `debug/src/components/consumo/CachingPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
interface SourceStat {
  source: string;
  hitRate: number;
  savedUsd: number;
}

interface CachingStats {
  perSource: SourceStat[];
  totalSavedUsd: number;
  brokenCacheCount: number;
}

interface Props {
  stats: CachingStats | undefined;
  isDark: boolean;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

export function CachingPanel({ stats, isDark }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const labelCls = isDark ? "text-slate-400" : "text-slate-600";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";

  if (!stats) {
    return (
      <div className={`border rounded-lg p-4 ${cardCls}`}>
        <div className={`text-sm font-semibold ${titleCls}`}>Cache health</div>
        <div className={`text-xs mt-2 ${labelCls}`}>carregando...</div>
      </div>
    );
  }

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className="flex items-baseline justify-between mb-3">
        <div className={`text-sm font-semibold ${titleCls}`}>Cache health</div>
        <div className={`text-xs mono ${labelCls}`}>
          economizou ${stats.totalSavedUsd.toFixed(2)}
        </div>
      </div>
      <div className="space-y-2">
        {stats.perSource.length === 0 && (
          <div className={`text-xs ${labelCls}`}>Sem dados de cache no período.</div>
        )}
        {stats.perSource.map((s) => {
          const widthPct = Math.round(s.hitRate * 100);
          const barColor =
            s.hitRate >= 0.7
              ? "bg-emerald-500"
              : s.hitRate >= 0.5
                ? "bg-amber-500"
                : "bg-rose-500";
          return (
            <div key={s.source} className="grid grid-cols-[120px_1fr_80px] items-center gap-2 text-xs">
              <span className={`mono ${labelCls}`}>{s.source}</span>
              <div className={`h-2 rounded ${isDark ? "bg-slate-800" : "bg-slate-200"}`}>
                <div className={`h-full rounded ${barColor}`} style={{ width: `${widthPct}%` }} />
              </div>
              <span className={`mono ${labelCls} text-right`}>
                {fmtPct(s.hitRate)} · ${s.savedUsd.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
      {stats.brokenCacheCount > 0 && (
        <div
          className={`mt-3 text-xs px-2 py-1.5 rounded ${
            isDark
              ? "bg-amber-900/30 text-amber-300 border border-amber-700/40"
              : "bg-amber-50 text-amber-800 border border-amber-200"
          }`}
        >
          ⚠️ {stats.brokenCacheCount} turnos do dispatcher com cache_read=0 dentro do TTL
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/consumo/CachingPanel.tsx
git commit -m "feat(consumo): add CachingPanel component"
```

---

## Task 18: TopConversationsList component

**Files:**
- Create: `debug/src/components/consumo/TopConversationsList.tsx`

- [ ] **Step 1: Create the component**

```tsx
interface Conversation {
  conversationId: string;
  costUsd: number;
  callCount: number;
  lastActivityAt: number;
}

interface Props {
  data: Conversation[] | undefined;
  isDark: boolean;
  onSelect: (conversationId: string) => void;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtAge(ms: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor((Date.now() - ms) / dayMs);
  if (days === 0) return "hoje";
  if (days === 1) return "ontem";
  return `${days}d atrás`;
}

export function TopConversationsList({ data, isDark, onSelect }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const rowCls = isDark
    ? "hover:bg-slate-800/40 border-slate-800"
    : "hover:bg-slate-50 border-slate-200";
  const labelCls = isDark ? "text-slate-400" : "text-slate-600";

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className={`text-sm font-semibold mb-2 ${titleCls}`}>Conversas mais caras</div>
      {!data && <div className={`text-xs ${labelCls}`}>carregando...</div>}
      {data && data.length === 0 && (
        <div className={`text-xs ${labelCls}`}>Nenhuma conversa no período.</div>
      )}
      {data && data.length > 0 && (
        <div className="divide-y">
          {data.map((c) => (
            <button
              key={c.conversationId}
              onClick={() => onSelect(c.conversationId)}
              className={`w-full grid grid-cols-[1fr_auto_auto] items-center gap-3 py-2 px-2 text-left text-xs border-b ${rowCls}`}
            >
              <span className={`mono truncate ${labelCls}`}>
                {c.conversationId}
              </span>
              <span className={`mono ${labelCls}`}>
                {c.callCount} chamadas
              </span>
              <span className={`mono font-semibold ${isDark ? "text-slate-200" : "text-slate-800"}`}>
                {fmtUsd(c.costUsd)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/consumo/TopConversationsList.tsx
git commit -m "feat(consumo): add TopConversationsList component"
```

---

## Task 19: DrillDownTable component

**Files:**
- Create: `debug/src/components/consumo/DrillDownTable.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api.js";

interface Props {
  isDark: boolean;
  conversationId?: string;
}

const SOURCE_OPTIONS = [
  "all",
  "dispatcher",
  "execution",
  "extract",
  "consolidation-proposer",
  "consolidation-adversary",
  "consolidation-judge",
] as const;

type SourceOpt = (typeof SOURCE_OPTIONS)[number];

function fmt(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", { hour12: false });
}

export function DrillDownTable({ isDark, conversationId }: Props) {
  const [source, setSource] = useState<SourceOpt>("all");
  const { results, status, loadMore } = usePaginatedQuery(
    api.usage.recentRecords,
    {
      source: source === "all" ? undefined : source,
      conversationId,
    },
    { initialNumItems: 50 },
  );

  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const headCls = isDark ? "text-slate-500" : "text-slate-500";
  const rowCls = isDark
    ? "border-slate-800 hover:bg-slate-800/30"
    : "border-slate-100 hover:bg-slate-50";
  const cellCls = isDark ? "text-slate-300" : "text-slate-700";
  const selectCls = isDark
    ? "bg-slate-900 border-slate-700 text-slate-300"
    : "bg-white border-slate-300 text-slate-700";

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className="flex items-center justify-between mb-3">
        <div className={`text-sm font-semibold ${titleCls}`}>Drill-down</div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourceOpt)}
          className={`text-xs border rounded px-2 py-1 ${selectCls}`}
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-auto max-h-[420px]">
        <table className="w-full text-xs">
          <thead className={`text-[11px] uppercase tracking-wide ${headCls}`}>
            <tr>
              <th className="text-left p-1.5">timestamp</th>
              <th className="text-left p-1.5">source</th>
              <th className="text-left p-1.5">conv</th>
              <th className="text-right p-1.5">in/out</th>
              <th className="text-right p-1.5">cache r/w</th>
              <th className="text-right p-1.5">ctx</th>
              <th className="text-right p-1.5">cost</th>
              <th className="text-right p-1.5">ms</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r: any) => {
              const ctx = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
              return (
                <tr key={r._id} className={`border-t ${rowCls}`}>
                  <td className={`p-1.5 mono ${cellCls}`}>{fmtTime(r.createdAt)}</td>
                  <td className={`p-1.5 mono ${cellCls}`}>{r.source}</td>
                  <td className={`p-1.5 mono truncate max-w-[120px] ${cellCls}`}>
                    {r.conversationId ?? "—"}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>
                    {fmt(r.inputTokens)}/{fmt(r.outputTokens)}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>
                    {fmt(r.cacheReadTokens)}/{fmt(r.cacheCreationTokens)}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>{fmt(ctx)}</td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>
                    ${r.costUsd.toFixed(4)}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>{r.durationMs}</td>
                </tr>
              );
            })}
            {results.length === 0 && (
              <tr>
                <td colSpan={8} className={`p-3 text-center ${headCls}`}>
                  Sem registros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {status === "CanLoadMore" && (
        <button
          onClick={() => loadMore(50)}
          className={`mt-2 w-full text-xs py-1.5 rounded border ${
            isDark
              ? "border-slate-700 text-slate-400 hover:bg-slate-800/40"
              : "border-slate-300 text-slate-600 hover:bg-slate-50"
          }`}
        >
          Carregar mais
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/consumo/DrillDownTable.tsx
git commit -m "feat(consumo): add DrillDownTable component"
```

---

## Task 20: ConversationDrilldown component

**Files:**
- Create: `debug/src/components/consumo/ConversationDrilldown.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useQuery } from "convex/react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { api } from "../../../../convex/_generated/api.js";
import { DrillDownTable } from "./DrillDownTable.js";

interface Props {
  conversationId: string;
  isDark: boolean;
  onBack: () => void;
}

const SONNET_CTX_LIMIT = 200_000;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour12: false });
}

export function ConversationDrilldown({ conversationId, isDark, onBack }: Props) {
  const points = useQuery(api.usage.contextSizes, {
    conversationId,
    limit: 200,
  });

  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const labelCls = isDark ? "text-slate-500" : "text-slate-500";

  let cumulative = 0;
  const chartData = (points ?? []).map((p: any) => {
    cumulative += p.costUsd;
    return {
      time: fmtTime(p.createdAt),
      contextTokens: p.contextTokens,
      costUsd: p.costUsd,
      cumulativeUsd: cumulative,
    };
  });

  const totalCost = chartData.length ? chartData[chartData.length - 1].cumulativeUsd : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className={`text-xs px-2.5 py-1 rounded border ${
            isDark
              ? "border-slate-700 text-slate-400 hover:bg-slate-800/40"
              : "border-slate-300 text-slate-600 hover:bg-slate-50"
          }`}
        >
          ← voltar
        </button>
        <span className={`mono text-sm ${titleCls}`}>{conversationId}</span>
        <span className={`mono text-xs ${labelCls}`}>
          total ${totalCost.toFixed(2)} · {chartData.length} chamadas
        </span>
      </div>

      <div className={`border rounded-lg p-4 ${cardCls}`}>
        <div className={`text-sm font-semibold mb-2 ${titleCls}`}>
          Tamanho do contexto por turno
        </div>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke={isDark ? "#1e293b" : "#e2e8f0"} strokeDasharray="3 3" />
              <XAxis dataKey="time" stroke={isDark ? "#64748b" : "#94a3b8"} fontSize={11} />
              <YAxis
                stroke={isDark ? "#64748b" : "#94a3b8"}
                fontSize={11}
                tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? "#0f172a" : "#fff",
                  border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(v: number) => `${v.toLocaleString()} tokens`}
              />
              <ReferenceLine
                y={SONNET_CTX_LIMIT}
                stroke="#f43f5e"
                strokeDasharray="4 4"
                label={{ value: "limite Sonnet (200k)", fill: "#f43f5e", fontSize: 10 }}
              />
              <Line type="monotone" dataKey="contextTokens" stroke="#3b82f6" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className={`border rounded-lg p-4 ${cardCls}`}>
        <div className={`text-sm font-semibold mb-2 ${titleCls}`}>
          Custo cumulativo
        </div>
        <div style={{ width: "100%", height: 180 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke={isDark ? "#1e293b" : "#e2e8f0"} strokeDasharray="3 3" />
              <XAxis dataKey="time" stroke={isDark ? "#64748b" : "#94a3b8"} fontSize={11} />
              <YAxis
                stroke={isDark ? "#64748b" : "#94a3b8"}
                fontSize={11}
                tickFormatter={(v) => `$${v.toFixed(2)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? "#0f172a" : "#fff",
                  border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(v: number) => `$${v.toFixed(4)}`}
              />
              <Line type="monotone" dataKey="cumulativeUsd" stroke="#10b981" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <DrillDownTable isDark={isDark} conversationId={conversationId} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/consumo/ConversationDrilldown.tsx
git commit -m "feat(consumo): add ConversationDrilldown component"
```

---

## Task 21: ConsumoPanel orchestrator

**Files:**
- Create: `debug/src/components/ConsumoPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { KpiCards } from "./consumo/KpiCards.js";
import { DailyCostChart } from "./consumo/DailyCostChart.js";
import { CachingPanel } from "./consumo/CachingPanel.js";
import { TopConversationsList } from "./consumo/TopConversationsList.js";
import { DrillDownTable } from "./consumo/DrillDownTable.js";
import { ConversationDrilldown } from "./consumo/ConversationDrilldown.js";
import { AnomalyBadge } from "./consumo/AnomalyBadge.js";

type Range = "today" | "7d" | "30d" | "all";

const RANGE_LABELS: Record<Range, string> = {
  today: "Hoje",
  "7d": "7d",
  "30d": "30d",
  all: "Tudo",
};

interface Props {
  isDark: boolean;
}

export function ConsumoPanel({ isDark }: Props) {
  const [range, setRange] = useState<Range>("7d");
  const [selectedConv, setSelectedConv] = useState<string | null>(null);

  const summary = useQuery(api.usage.summary, { range });
  const bySource = useQuery(api.usage.bySource, { range });
  const byDay = useQuery(api.usage.byDay, { range });
  const top = useQuery(api.usage.byConversation, { range, limit: 10 });
  const caching = useQuery(api.usage.cachingStats, { range });
  const anomalies = useQuery(api.usage.anomalies, { range });

  const tabBase = "px-3 py-1 text-xs rounded-md transition-colors mono";
  const tabActive = isDark
    ? "bg-slate-800 text-slate-100 font-semibold"
    : "bg-slate-200 text-slate-900 font-semibold";
  const tabIdle = isDark
    ? "text-slate-500 hover:text-slate-300"
    : "text-slate-500 hover:text-slate-700";

  if (selectedConv) {
    return (
      <ConversationDrilldown
        conversationId={selectedConv}
        isDark={isDark}
        onBack={() => setSelectedConv(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1">
          {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`${tabBase} ${range === r ? tabActive : tabIdle}`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="text-xs">
          {anomalies && anomalies.length > 0 && (
            <span className={isDark ? "text-rose-400" : "text-rose-600"}>
              🔴 {anomalies.length} alerta{anomalies.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <KpiCards summary={summary} top={top?.[0]} isDark={isDark} />

      {anomalies && anomalies.length > 0 && (
        <AnomalyBadge anomalies={anomalies} isDark={isDark} />
      )}

      <DailyCostChart data={byDay} isDark={isDark} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CachingPanel stats={caching} isDark={isDark} />
        <TopConversationsList
          data={top}
          isDark={isDark}
          onSelect={setSelectedConv}
        />
      </div>

      <DrillDownTable isDark={isDark} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add debug/src/components/ConsumoPanel.tsx
git commit -m "feat(consumo): add ConsumoPanel orchestrator"
```

---

## Task 22: Wire Consumo into App.tsx nav

**Files:**
- Modify: `debug/src/App.tsx`

- [ ] **Step 1: Import the new panel and icon**

In `debug/src/App.tsx`, find the import block of icons (around line 4) and add `MoneyBag02Icon`:

```ts
import {
  MachineRobotIcon,
  AiBrain02Icon,
  WorkflowCircle03Icon,
  Activity01Icon,
  Link04Icon,
  DashboardSquare01Icon,
  ArrowShrink02Icon,
  MoneyBag02Icon,
} from "@hugeicons/core-free-icons";
```

If `MoneyBag02Icon` is not exported by `@hugeicons/core-free-icons` in the installed version, substitute another money-related icon (e.g. `BankIcon`, `Coins01Icon`, `CreditCardIcon`). Verify by checking `node_modules/@hugeicons/core-free-icons/index.d.ts`.

Add the panel import below the other component imports:

```ts
import { ConsumoPanel } from "./components/ConsumoPanel.js";
```

- [ ] **Step 2: Update the View type union**

Change:

```ts
type View =
  | "dashboard"
  | "agents"
  | "automations"
  | "memory"
  | "events"
  | "consolidation"
  | "connections";
```

To:

```ts
type View =
  | "dashboard"
  | "consumo"
  | "agents"
  | "automations"
  | "memory"
  | "events"
  | "consolidation"
  | "connections";
```

- [ ] **Step 3: Add to NAV_ICONS map**

Change:

```ts
const NAV_ICONS: Record<View, any> = {
  dashboard: DashboardSquare01Icon,
  agents: MachineRobotIcon,
  automations: WorkflowCircle03Icon,
  memory: AiBrain02Icon,
  events: Activity01Icon,
  consolidation: ArrowShrink02Icon,
  connections: Link04Icon,
};
```

To:

```ts
const NAV_ICONS: Record<View, any> = {
  dashboard: DashboardSquare01Icon,
  consumo: MoneyBag02Icon,
  agents: MachineRobotIcon,
  automations: WorkflowCircle03Icon,
  memory: AiBrain02Icon,
  events: Activity01Icon,
  consolidation: ArrowShrink02Icon,
  connections: Link04Icon,
};
```

- [ ] **Step 4: Add to NAV array**

Change:

```ts
const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "agents", label: "Agents" },
  ...
];
```

To:

```ts
const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "consumo", label: "Consumo" },
  { id: "agents", label: "Agents" },
  ...
];
```

- [ ] **Step 5: Render the panel**

In the main render block, find the ladder of `view === "..."` checks (around line 220) and add:

```tsx
            {view === "consumo" && <ConsumoPanel isDark={isDark} />}
```

right after the dashboard line.

- [ ] **Step 6: Verify**

Run: `npm run build:debug`
Expected: vite build succeeds, no type errors.

Then `npm run dev:debug` and open `http://localhost:5173`. Click the "Consumo" tab. Expected: the tab loads. With no data, KPI cards show `—`, charts are empty but render, and "Sem registros" appears in the drill-down.

- [ ] **Step 7: Commit**

```bash
git add debug/src/App.tsx
git commit -m "feat(consumo): wire ConsumoPanel into debug UI nav"
```

---

## Task 23: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Boot the full stack**

```bash
npm run dev:parallel
```
Expected: server, convex, and debug UI all start without errors.

- [ ] **Step 2: Generate some traffic**

Send a few Telegram messages to your boop bot, including:
- a casual question (dispatcher only)
- a research question that triggers `spawn_agent` (execution agent)
- a question about cost: "boop, quanto gastei essa semana?"
Expected: the cost question gets answered using `usage_report` (you should see a `tool: usage_report` line in the dispatcher logs).

- [ ] **Step 3: Verify the Consumo tab**

Open `http://localhost:5173`. Click "Consumo".
- KPI cards show non-zero values.
- Daily chart shows today's cost stacked by source.
- Cache health shows dispatcher hit rate (likely > 70% after a few turns).
- Top conversations list contains your Telegram conversation.

- [ ] **Step 4: Verify drill-down**

Click your conversation in the top list. Expected: drilldown view opens with the context-size chart and cumulative cost chart populated. Click "← voltar". Returns to overview.

- [ ] **Step 5: Verify the cost-digest automation**

In the debug UI, go to "Automations". Expected: a row named `cost-digest` is visible with `enabled: false`. Toggle it on (don't wait for Sunday — instead, manually trigger via Telegram: "rodar o cost digest agora"). The dispatcher should call `usage_report` and respond with a digest.

- [ ] **Step 6: Verify anomaly detection (optional)**

If you have enough data to trigger an anomaly (e.g., a single chunky agent spawn), confirm the badge appears at the top of the Consumo tab.

- [ ] **Step 7: Run typecheck and tests**

```bash
npm run typecheck
npm test
```
Expected: 0 type errors. All vitest tests pass.

- [ ] **Step 8: Final commit (if any cleanup)**

If verification surfaced small fixes, commit them. Otherwise nothing to do.

---

## Done

Recap of what shipped:
- `usageRecords.by_created_at` index
- `convex/lib/timeRange.ts`, `convex/lib/anomalies.ts` (+ tests), `convex/lib/pricing.ts`
- `convex/usage.ts` with 8 queries
- `convex/automations.ts` extended with `getByName`
- `server/usage-report-tools.ts` MCP server (+ test)
- `server/cost-digest.ts` automation registration helper
- `server/interaction-agent.ts` wired with `boop-usage` MCP and updated system prompt
- `server/automations.ts` boots the helper
- 8 new components in `debug/src/components/consumo/` plus `ConsumoPanel.tsx` orchestrator
- `debug/src/App.tsx` updated with new nav entry
- recharts + vitest deps

Followups (out of scope for this plan):
- Announce-on-tool-use feature (separate spec)
- Daily rollup table if `usageRecords` exceeds the SCAN_CAP regularly
- Per-tool cost attribution
