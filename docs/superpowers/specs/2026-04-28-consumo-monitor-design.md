# Consumo Monitor — Design Spec

**Date:** 2026-04-28
**Status:** Draft for review
**Owner:** João (jrflga)

## Goal

Add a cost/consumption monitoring feature to boop-agent so the user can:

1. See where money is going (overview).
2. Catch caching problems early (most boop runs lean heavily on prompt caching).
3. Spot anomalies before they become surprises.
4. Ask boop directly via Telegram ("how much did I spend this week?") instead of opening the dashboard.

The feature is a single, cohesive deliverable with three surfaces over the same data.

## Non-goals

- Multi-tenant cost attribution. boop is single-user.
- Historical cost recomputation when pricing changes. Reports use the `costUsd` already stored on each record.
- Full-text search across `usageRecords`. Drill-down is filter-based (source, conversation, time range).
- Custom alert rules editable from the UI. The four built-in heuristics are hardcoded; users can adjust thresholds in code.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  CONVEX (source of truth)                                     │
│  ├─ usageRecords (existing) + new index by_created_at         │
│  └─ NEW: convex/usage.ts                                      │
│       ├─ summary(range)                                       │
│       ├─ bySource(range)                                      │
│       ├─ byConversation(range, limit)                         │
│       ├─ byDay(range)                                         │
│       ├─ cachingStats(range)                                  │
│       ├─ contextSizes(conversationId, limit)                  │
│       ├─ recentRecords(cursor, limit, filter)                 │
│       └─ anomalies(range)                                     │
└──────────┬───────────────────────────────┬────────────────────┘
           │                               │
           ▼                               ▼
  ┌─────────────────────┐       ┌─────────────────────────────┐
  │  DEBUG UI            │       │  SERVER (interaction-agent) │
  │  ConsumoPanel.tsx    │       │  usage-report-tools.ts       │
  │  (recharts + Convex  │       │  MCP server "boop-usage"     │
  │   useQuery)          │       │  exposes: usage_report()     │
  └─────────────────────┘       └──────────┬──────────────────┘
                                           │
                                           ▼
                                 ┌─────────────────────────────┐
                                 │  AUTOMATION                  │
                                 │  "cost-digest"               │
                                 │  cron 0 9 * * 0              │
                                 │  enabled=false (default)     │
                                 │  registered on first boot    │
                                 └─────────────────────────────┘
```

All three consumers (debug UI, dispatcher MCP, automation) read the same Convex queries. No new tables, no rollup aggregations, no shadow state.

## Data model

**Existing:** `usageRecords` already has every field we need: `source`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `durationMs`, `conversationId`, `agentId`, `createdAt`.

**Change:** add a `by_created_at` index for time-range scans:

```ts
usageRecords: defineTable({...})
  .index("by_conversation", ["conversationId"])
  .index("by_agent", ["agentId"])
  .index("by_source", ["source"])
  .index("by_created_at", ["createdAt"])    // NEW
```

No migration needed — Convex builds the index automatically on schema deploy.

## Convex queries (`convex/usage.ts`)

Each query takes a `range: "today" | "7d" | "30d" | "all"`. Time ranges are computed from `Date.now()`; the query uses `by_created_at` to scan only the relevant slice.

| Query | Args | Returns |
|---|---|---|
| `summary` | `{ range, source?, conversationId? }` | `{ costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, callCount, cacheHitRate }` |
| `bySource` | `{ range }` | `Array<{ source, costUsd, callCount, cacheHitRate, inputTokens, cacheReadTokens }>` |
| `byConversation` | `{ range, limit }` | `Array<{ conversationId, costUsd, callCount, lastActivityAt }>` desc by costUsd |
| `byDay` | `{ range }` | `Array<{ day: ISODate, costUsd, costBySource: { dispatcher, execution, extract, consolidation } }>` |
| `cachingStats` | `{ range }` | `{ perSource: Array<{ source, hitRate, savedUsd }>, totalSavedUsd, brokenCacheCount }` |
| `contextSizes` | `{ conversationId, limit }` | `Array<{ turnId, createdAt, contextTokens, costUsd, source }>` ordered asc by `createdAt` |
| `recentRecords` | `{ paginationOpts, source?, conversationId? }` | Convex paginated `{ page, isDone, continueCursor }` |
| `anomalies` | `{ range }` | `Array<{ kind, severity, message, ref? }>` |

**`cacheHitRate` formula:** `cacheReadTokens / (cacheReadTokens + inputTokens)`. (`inputTokens` here means *uncached* input, since the SDK already separates them.)

**`savedUsd` formula:** `cacheReadTokens × (priceInputPerToken - priceCacheReadPerToken)` for the row's model. Reuse the same model-price table that `server/usage.ts` uses for `costUsd` accounting (extract into a shared `server/pricing.ts` if not already shared).

**`anomalies` heuristics:**

The first heuristic uses fixed windows regardless of the caller's `range`; the others honor `range`. This keeps "cost spike" meaningful (it always compares this week to recent weeks, not whatever range happens to be on screen).

1. **Cost spike:** `sum(costUsd) over last 7 days > 2 × median(weekly costUsd of the 4 prior weeks, excluding current week)`. Skip if fewer than 2 prior weeks of data exist. → `severity: "high"`, `kind: "cost_spike"`.
2. **Low cache hit:** dispatcher `cacheHitRate(range) < 0.5` AND total dispatcher calls in range ≥ 10 (avoid noisy small samples) → `severity: "medium"`, `kind: "low_cache_hit"`.
3. **Broken cache:** within `range`, count dispatcher records where `cacheReadTokens = 0` AND the immediately-previous *dispatcher* record on the same `conversationId` was within 5 minutes. The current record is excluded from "previous". If count ≥ 5, flag → `severity: "medium"`, `kind: "broken_cache"`.
4. **Giant turn:** any single record in `range` with `inputTokens + cacheReadTokens > 100_000` → `severity: "low"`, `kind: "giant_turn"`, `ref: { recordId, agentId? }`.

Heuristics are pure functions over the queried data; they live in `convex/usage.ts` so the same logic powers UI badges, the MCP tool, and the digest.

## Debug UI — Consumo tab

### Files (new)

```
debug/src/components/
├─ ConsumoPanel.tsx                   # entry, owns range state + view mode (overview vs drilldown)
├─ consumo/
│  ├─ KpiCards.tsx
│  ├─ DailyCostChart.tsx              # recharts AreaChart, stacked by source
│  ├─ CachingPanel.tsx
│  ├─ TopConversationsList.tsx
│  ├─ DrillDownTable.tsx              # paginated via usePaginatedQuery
│  ├─ ConversationDrilldown.tsx       # per-conversation deep view
│  └─ AnomalyBadge.tsx                # reused in header + per-section
```

### Layout (overview mode)

```
┌──────────────────────────────────────────────────────────────┐
│ [Hoje] [7d] [30d] [Tudo]                       🔴 2 alertas  │
├──────────────────────────────────────────────────────────────┤
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────────┐         │
│ │ $X.XX  │ │ XX%    │ │ $0.XX  │ │ conv: ABC...   │         │
│ │ Custo  │ │ Cache  │ │ /turno │ │ $X.XX (top)    │         │
│ └────────┘ └────────┘ └────────┘ └────────────────┘         │
├──────────────────────────────────────────────────────────────┤
│ Daily cost (stacked area: dispatcher/execution/extract/cons.)│
├──────────────────────────────────────────────────────────────┤
│ Cache health                                                  │
│   dispatcher  ▓▓▓▓▓▓▓▓░░ 78%   saved $1.23                   │
│   execution   ▓▓▓▓▓░░░░░ 52%   saved $0.41                   │
│   ⚠️ 7 dispatcher turns with cache_read=0 within TTL window  │
├──────────────────────────────────────────────────────────────┤
│ Top expensive conversations                                   │
│   conv_abc123    $2.14   42 calls    →                        │
│   conv_def456    $0.88   18 calls    →                        │
├──────────────────────────────────────────────────────────────┤
│ ▾ Drill-down                                                  │
│   [filter: source ▾] [conversationId: ___]                    │
│   timestamp │ source │ conv │ in/out/cache │ ctx │ cost │ ms  │
└──────────────────────────────────────────────────────────────┘
```

### Layout (conversation drilldown mode)

Triggered by clicking a row in "Top expensive conversations" or a conversation in the drill-down table.

- Header: `conversationId`, total cost in range, "← back" button.
- Line chart: **context size per turn** (`inputTokens + cacheReadTokens + cacheCreationTokens`). Reference line at 200_000 (Sonnet ctx limit). Different colored points per source.
- Line chart: **cost per turn** (per-turn bar + cumulative line on dual axis).
- Table: every record for that conversation, paginated.

### Nav update

In `debug/src/App.tsx`:

- Add `"consumo"` to the `View` type union.
- Add `{ id: "consumo", label: "Consumo" }` to `NAV` after `dashboard`.
- Add icon (`MoneyBag02Icon` from `@hugeicons/core-free-icons`) to `NAV_ICONS`.
- Render `<ConsumoPanel isDark={isDark} />` when `view === "consumo"`.

### Empty / loading / error states

- **No data in range:** central message "Sem chamadas registradas no período". KPI cards show `—`.
- **Loading (`useQuery` returns undefined):** skeleton placeholders matching final layout shape.
- **Convex query throws:** the existing `ErrorBoundary` catches; supplement with a `try/retry` button via `useQuery` re-mount key.

### Theming

Components receive `isDark: boolean` (matches existing pattern). Recharts colors are passed explicitly via props; no auto-detection.

### Charting dependency

Add `recharts` to `package.json` `dependencies`. ~70KB minified, supports both Tailwind v4 and React 19. Used only inside `debug/src/`; bundled by Vite.

## Server — `usage_report` MCP tool

### File

`server/usage-report-tools.ts`, following the shape of `server/memory/tools.ts`.

### Schema

```ts
usage_report({
  range?: "today" | "7d" | "30d" | "all",      // default "7d"
  source?: "dispatcher" | "execution" | "extract" | "consolidation",
  conversationId?: string,
})
```

### Handler

```ts
async function handler({ range = "7d", source, conversationId }) {
  const [summary, bySource, top, anomalies] = await Promise.all([
    convex.query(api.usage.summary, { range, source, conversationId }),
    convex.query(api.usage.bySource, { range }),
    convex.query(api.usage.byConversation, { range, limit: 5 }),
    convex.query(api.usage.anomalies, { range }),
  ]);
  return JSON.stringify({ range, summary, bySource, top, anomalies }, null, 2);
}
```

`source` and `conversationId` filters apply only to `summary`; the other three give global context for the digest.

### Wiring

In `server/interaction-agent.ts`, add the new MCP server to the `mcpServers` map alongside `boop-memory`, `boop-spawn`, `boop-automations`, `boop-drafts`. Add `mcp__boop-usage__*` to `allowedTools`.

Append one paragraph to the dispatcher system prompt:

> When the user asks about cost, spending, token usage, or cache hit rate, use the `usage_report` tool. Default range is the last 7 days; pass `range: "today"` for today's totals, `"30d"` for monthly. Speak the report naturally; don't just dump JSON.

## Weekly digest automation

### Helper

`server/automations.ts` adds:

```ts
async function ensureCostDigestAutomation() {
  const existing = await convex.query(api.automations.getByName, { name: "cost-digest" });
  if (existing) return;

  await convex.mutation(api.automations.create, {
    automationId: randomId("auto"),
    name: "cost-digest",
    task: COST_DIGEST_TASK,
    integrations: [],
    schedule: "0 9 * * 0",
    enabled: false,
    notifyConversationId: defaultTelegramConversationId(),
  });
}
```

### Task prompt (constant)

```
Use a tool usage_report({range: "7d"}).

Produza um resumo curto (5-8 linhas):
- Custo total da semana
- Cache hit rate por source (destaque se algum < 50%)
- Top 3 conversas mais caras
- Anomalias detectadas (se houver)

Se houver anomalia com severity "high", prefixe a mensagem com "ALERTAS:".
Tom: relatório seco, sem saudação, sem floreio. Português.
```

### Lifecycle

`ensureCostDigestAutomation()` is called once during `startAutomationLoop()` boot. It is idempotent — second boot finds the existing automation and exits.

User enables/disables via Telegram (`toggle_automation` is already in the dispatcher's toolset).

### New Convex helpers needed for this

- `api.automations.getByName(name)` — small new query.

## Pricing helper

`server/pricing.ts` (new file, or move pricing constants out of wherever they live now): exports `priceFor(model)` returning `{ inputPerToken, outputPerToken, cacheReadPerToken, cacheWritePerToken }`. Used by both `usage.ts` Convex queries (for `savedUsd`) and any place that recomputes cost.

If pricing is currently inlined in `server/usage.ts`, extract it; if it's already separate, just import.

## Testing

- **Convex queries** (`convex/usage.test.ts`): seed ~20 `usageRecords` with varied source/timestamp/cache; assert each query returns the right shape and values. Critical: anomaly heuristics — assert each kind triggers when its threshold is hit and stays silent below threshold.
- **MCP tool** (`server/usage-report-tools.test.ts`): mock `convex.query`, call the handler, assert response is valid JSON with the expected fields.
- **UI:** manual verification via `npm run dev:debug`. No automated UI tests for this feature.

## Edge cases

- **`costUsd === 0` in old records:** display as-is. Don't recompute (pricing changes over time).
- **Range "all" with many records:** all aggregations run server-side in Convex; client only receives summarized arrays. `byDay` produces at most ~365 points.
- **Broken-cache false positives:** when checking the previous turn for a dispatcher record, only consider previous records where `source === "dispatcher"` on the same conversation.
- **Empty automation result:** if no records in 7d, the digest still runs but says "Sem atividade essa semana".
- **No default Telegram conversation:** if `defaultTelegramConversationId()` is undefined, log a warning and create the automation with `notifyConversationId: undefined`. User can edit later.

## Out of scope (explicit)

- A historic cost graph older than 30 days in the UI (use "all" range; no chart, just summary).
- Per-tool cost attribution (we know `agentId` and `source`, but not which tool call inside an agent burned what).
- Cost forecasting.
- Slack / email digests. Telegram only.

## Rollout

1. Schema migration (add index) — automatic on `convex deploy`.
2. New Convex functions ship — additive, no breaking changes.
3. New MCP tool wired into dispatcher — additive.
4. Automation registered as disabled — invisible to user until they enable it.
5. New "Consumo" tab — new nav item, doesn't affect existing tabs.

Zero breaking changes; can be reverted by deleting the new files and removing the schema index, the nav item, and the MCP server entry.
