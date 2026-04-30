# Watcher Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add watchers — a `notifyOnlyOnChange` mode on existing automations that polls on the same shared cron loop, normalizes the spawn output as a line-list, diffs against the previous snapshot, and notifies only on additions.

**Architecture:** Watchers are not a new concept. They are a feature flag on `automations` (two optional columns: `notifyOnlyOnChange: boolean` and `lastSnapshot: string`). `runAutomation` branches when the flag is on: it appends format discipline to the task, pins the spawn to Haiku, computes additions via pure set-difference against `lastSnapshot`, and notifies only when additions is non-empty. `create_automation` gains one optional arg. List/toggle/delete are unchanged. First tick after creation is a silent baseline.

**Tech Stack:** TypeScript, Convex (backend + schema), `croner` (existing scheduler), `@anthropic-ai/claude-agent-sdk` (existing spawn path), `tsx` for the dev runtime.

**Spec:** GitHub issue [#6](https://github.com/jrflga/boop-agent/issues/6) — supersedes #4 (closed).

---

## Files to touch

| File | Change |
|---|---|
| `convex/schema.ts` | Add `notifyOnlyOnChange?: boolean` and `lastSnapshot?: string` to `automations`. |
| `convex/automations.ts` | Accept `notifyOnlyOnChange` in `create`. Add `updateSnapshot` mutation. |
| `server/execution-agent.ts` | Extend `SpawnOptions` and `spawnExecutionAgent` with optional `modelOverride`. |
| `server/automations.ts` | Add `normalizeSnapshot` and `diffAdditions` pure helpers. Branch in `runAutomation` for watcher mode. |
| `server/automation-tools.ts` | Add `notifyOnlyOnChange` arg to `create_automation`. Mark watchers `(watcher)` in `list_automations` output. |
| `server/interaction-agent.ts` | Teach dispatcher prompt to (a) set `notifyOnlyOnChange: true` when the user says "me avisa quando ABRIR/MUDAR/APARECER/CHEGAR", (b) propose the spec in chat first and call the tool only after the user confirms. |

No new tables. No new MCP tools. No new test runner (the codebase has none yet — see "Testing posture" below).

---

## Testing posture

The codebase has no test runner on `main` today. The PRD explicitly defers adding one ("Specify cases in plain language; if vitest lands later, this is a natural first test file"). This plan respects that:

- The two pure helpers (`normalizeSnapshot`, `diffAdditions`) get a doc-block above each function listing the cases they must satisfy. The block stays so it's executable later under any runner.
- No `*.test.ts` file is created in this plan.
- Verification at each step is via `pnpm typecheck` and a small ad-hoc REPL run (instructions inline at the relevant task).

If you (the executor) decide to add `vitest` while implementing this, do it as a separate prep task before Task 4 — do not graft it onto Task 4.

---

## Task 1: Schema — add watcher columns

**Files:**
- Modify: `convex/schema.ts:147-161`

- [ ] **Step 1: Add the two optional fields**

In the `automations` table block (currently `convex/schema.ts:147-161`), add `notifyOnlyOnChange` and `lastSnapshot` as optional fields. The block should read:

```ts
  automations: defineTable({
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    enabled: v.boolean(),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    notifyOnlyOnChange: v.optional(v.boolean()),
    lastSnapshot: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_automation_id", ["automationId"])
    .index("by_enabled", ["enabled"]),
```

Both fields are `v.optional` so existing rows remain valid without backfill.

- [ ] **Step 2: Push the schema and verify**

Run: `pnpm exec convex dev --once`
Expected: Convex pushes the schema cleanly. No "schema validation failed" error against existing rows.

If `convex dev --once` is not the right invocation in this repo, fall back to whatever the dev script does (`npm run dev:convex` runs `convex dev` in watch mode — kill it after you see the schema push succeed).

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(watchers): add notifyOnlyOnChange + lastSnapshot to automations table"
```

---

## Task 2: Convex mutations — accept the flag, add snapshot writer

**Files:**
- Modify: `convex/automations.ts:4-27` (the `create` mutation)
- Modify: `convex/automations.ts:81-99` (the `markRan` mutation — extend to take an optional snapshot, OR add a sibling mutation; this plan adds a sibling for clarity)

- [ ] **Step 1: Extend `create` to accept `notifyOnlyOnChange`**

In `convex/automations.ts`, replace the `create` mutation block at lines 4-27 with:

```ts
export const create = mutation({
  args: {
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    nextRunAt: v.optional(v.number()),
    notifyOnlyOnChange: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("automations", {
      ...args,
      enabled: true,
      createdAt: Date.now(),
    });
  },
});
```

The only change is the new optional arg in the `args` validator. The handler already spreads `args` into `db.insert`, so the field carries through automatically.

- [ ] **Step 2: Add `updateSnapshot` mutation**

Append a new mutation at the end of `convex/automations.ts` (after `recentRuns`):

```ts
export const updateSnapshot = mutation({
  args: { automationId: v.string(), snapshot: v.string() },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (!auto) return null;
    await ctx.db.patch(auto._id, { lastSnapshot: args.snapshot });
    return auto._id;
  },
});
```

This is a separate mutation rather than extending `markRan` because the snapshot only updates on the watcher branch, while `markRan` always runs. Keeping them separate keeps the call site self-documenting.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: zero errors. The generated `convex/_generated/api.d.ts` will pick up the new mutation on the next `convex dev` push, but `tsc --noEmit` only checks the source — it should pass even before the generated file is regenerated.

If you get errors about `api.automations.updateSnapshot` not existing, run `pnpm exec convex dev --once` to regenerate the API typings, then retry typecheck.

- [ ] **Step 4: Commit**

```bash
git add convex/automations.ts
git commit -m "feat(watchers): accept notifyOnlyOnChange in create + add updateSnapshot mutation"
```

---

## Task 3: spawnExecutionAgent — accept a model override

**Files:**
- Modify: `server/execution-agent.ts:87-92` (`SpawnOptions`)
- Modify: `server/execution-agent.ts:100-256` (the `spawnExecutionAgent` function — only the requestedModel resolution)

The watcher branch needs to pin Haiku without changing the global runtime model. The cleanest path is to extend `SpawnOptions` with an optional `modelOverride` and use it in place of `getRuntimeModel()` when present.

- [ ] **Step 1: Extend `SpawnOptions`**

In `server/execution-agent.ts:87-92`, replace:

```ts
export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
}
```

with:

```ts
export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  modelOverride?: string;
}
```

- [ ] **Step 2: Use the override when resolving the model**

In `server/execution-agent.ts:149`, replace:

```ts
  const requestedModel = await getRuntimeModel();
```

with:

```ts
  const requestedModel = opts.modelOverride ?? (await getRuntimeModel());
```

Nothing else in the function changes. The `query()` options at line 155 already reads `requestedModel`, and the usage logging at lines 244/318 already records whatever model the spawn actually used.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: zero errors. The two existing call sites (`server/automations.ts`, `server/interaction-agent.ts`, `server/draft-tools.ts`, and the `retryAgent` self-call) all pass through `SpawnOptions` and are unaffected by adding an optional field.

- [ ] **Step 4: Commit**

```bash
git add server/execution-agent.ts
git commit -m "feat(watchers): accept optional modelOverride in spawnExecutionAgent"
```

---

## Task 4: Pure helpers — `normalizeSnapshot` and `diffAdditions`

**Files:**
- Modify: `server/automations.ts` (add two helpers near the top, after `nextRunFor`)

These helpers are the only piece of this feature that has interesting branching, so they deserve to be isolated and documented. They are pure: no I/O, no DB, no LLM, no `Date.now()`. Caller does normalization once and passes the resulting `string[]` to the diff.

- [ ] **Step 1: Add `normalizeSnapshot`**

Insert after the `validateSchedule` function in `server/automations.ts` (currently around line 29):

```ts
// Normalize a raw spawn result into a clean line list:
//   - trim leading/trailing whitespace per line
//   - drop empty lines (after trimming)
// Cases the caller relies on:
//   - multi-line input with mixed whitespace and empty interleaved lines → all
//     non-empty lines, trimmed, in original order
//   - single-line input → one-element array
//   - fully empty / whitespace-only input → empty array
export function normalizeSnapshot(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
```

- [ ] **Step 2: Add `diffAdditions`**

Immediately after `normalizeSnapshot`:

```ts
// Pure set-difference: lines in `curr` that are not in `prev`.
// Cases:
//   - empty prev → returns all of curr (caller must skip notification on the
//     baseline first tick by checking lastSnapshot === undefined, not by
//     looking at the diff)
//   - identical prev/curr → empty array
//   - one new line → one-element array
//   - complete replacement → all of curr
//   - duplicate lines in curr (same line appears twice) → returned at most
//     once (deduplicated against the prev set, then deduplicated against
//     itself via the same membership test)
export function diffAdditions(prev: string[], curr: string[]): string[] {
  const prevSet = new Set(prev);
  const seen = new Set<string>();
  const additions: string[] = [];
  for (const line of curr) {
    if (prevSet.has(line) || seen.has(line)) continue;
    additions.push(line);
    seen.add(line);
  }
  return additions;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: zero errors.

- [ ] **Step 4: Smoke test the helpers in a REPL**

Run from the repo root:

```bash
pnpm exec tsx -e "
import { normalizeSnapshot, diffAdditions } from './server/automations.ts';
const prev = normalizeSnapshot('Flamengo x Vasco\n\n  Flamengo x Botafogo  \n');
const curr = normalizeSnapshot('Flamengo x Vasco\nFlamengo x Botafogo\nFluminense x Atletico\n');
console.log('prev:', prev);
console.log('curr:', curr);
console.log('additions:', diffAdditions(prev, curr));
"
```

Expected output:
```
prev: [ 'Flamengo x Vasco', 'Flamengo x Botafogo' ]
curr: [ 'Flamengo x Vasco', 'Flamengo x Botafogo', 'Fluminense x Atletico' ]
additions: [ 'Fluminense x Atletico' ]
```

If the path `./server/automations.ts` does not resolve from `tsx -e`, save the snippet to a scratch file under `/tmp` and run it from there. Do NOT add the scratch file to the repo (CLAUDE.md pre-commit rule).

- [ ] **Step 5: Commit**

```bash
git add server/automations.ts
git commit -m "feat(watchers): add pure normalizeSnapshot + diffAdditions helpers"
```

---

## Task 5: Branch `runAutomation` for watcher mode

**Files:**
- Modify: `server/automations.ts:31-90` (`runAutomation`)
- Modify: `server/automations.ts:92-108` (`tickAutomations` — only the call shape)

Two structural changes:

1. The shared call site at `tickAutomations` must pass the new fields (`notifyOnlyOnChange`, `lastSnapshot`, `automationId`) into `runAutomation`. They already exist on the row returned by `api.automations.list`.
2. `runAutomation` gets a watcher branch around the existing notify path.

- [ ] **Step 1: Add the watcher fields to the runAutomation argument shape**

Replace the function signature of `runAutomation` (currently at `server/automations.ts:31-39`):

```ts
async function runAutomation(a: {
  automationId: string;
  name: string;
  task: string;
  integrations: string[];
  schedule: string;
  conversationId?: string;
  notifyConversationId?: string;
  notifyOnlyOnChange?: boolean;
  lastSnapshot?: string;
}): Promise<void> {
```

- [ ] **Step 2: Wrap the spawn task and pin Haiku when watching**

Inside `runAutomation`, just before `const res = await spawnExecutionAgent(...)` (currently `server/automations.ts:48`), build the task string and model based on the watcher flag. Replace the existing spawn call:

```ts
    const res = await spawnExecutionAgent({
      task: `AUTOMATION "${a.name}": ${a.task}`,
      integrations: a.integrations,
      conversationId: a.conversationId,
      name: `auto:${a.name}`,
    });
```

with:

```ts
    const taskBody = a.notifyOnlyOnChange
      ? `${a.task}\n\nRetorne uma lista, um item por linha. Formato consistente, sem variação. Sem comentários, sem cabeçalho, sem rodapé.`
      : a.task;

    const res = await spawnExecutionAgent({
      task: `AUTOMATION "${a.name}": ${taskBody}`,
      integrations: a.integrations,
      conversationId: a.conversationId,
      name: a.notifyOnlyOnChange ? `watcher:${a.name}` : `auto:${a.name}`,
      modelOverride: a.notifyOnlyOnChange ? "claude-haiku-4-5-20251001" : undefined,
    });
```

The Haiku model id matches `runtime-config.ts:15`. We pin it here to keep watcher cost shape predictable regardless of the global runtime model.

- [ ] **Step 3: Replace the notify block with a watcher-aware version**

Currently the notify block at `server/automations.ts:61-72` reads:

```ts
    if (a.notifyConversationId && res.result) {
      if (a.notifyConversationId.startsWith("telegram:")) {
        const chatId = a.notifyConversationId.slice("telegram:".length);
        const preamble = `[${a.name}]\n\n`;
        await sendTelegramMessage(chatId, preamble + res.result);
      }
      await convex.mutation(api.messages.send, {
        conversationId: a.notifyConversationId,
        role: "assistant",
        content: `[${a.name}]\n\n${res.result}`,
      });
    }
```

Replace it with a function that splits on the watcher flag. The watcher path computes the diff, persists the snapshot only on success, and notifies only on additions. The non-watcher path is unchanged.

```ts
    if (res.status === "completed" && res.result) {
      if (a.notifyOnlyOnChange) {
        const SNAPSHOT_CAP = 16 * 1024;
        const currLines = normalizeSnapshot(res.result);
        const prevLines = a.lastSnapshot ? normalizeSnapshot(a.lastSnapshot) : [];
        const baseline = a.lastSnapshot === undefined;
        const additions = baseline ? [] : diffAdditions(prevLines, currLines);

        // Always persist the new snapshot on a successful spawn (truncate to cap).
        const newSnapshot = currLines.join("\n").slice(0, SNAPSHOT_CAP);
        await convex.mutation(api.automations.updateSnapshot, {
          automationId: a.automationId,
          snapshot: newSnapshot,
        });

        if (!baseline && additions.length > 0 && a.notifyConversationId) {
          const body = `[${a.name}]\n${additions.map((line) => `Novo: ${line}`).join("\n")}`;
          if (a.notifyConversationId.startsWith("telegram:")) {
            const chatId = a.notifyConversationId.slice("telegram:".length);
            await sendTelegramMessage(chatId, body);
          }
          await convex.mutation(api.messages.send, {
            conversationId: a.notifyConversationId,
            role: "assistant",
            content: body,
          });
        }
      } else if (a.notifyConversationId) {
        if (a.notifyConversationId.startsWith("telegram:")) {
          const chatId = a.notifyConversationId.slice("telegram:".length);
          const preamble = `[${a.name}]\n\n`;
          await sendTelegramMessage(chatId, preamble + res.result);
        }
        await convex.mutation(api.messages.send, {
          conversationId: a.notifyConversationId,
          role: "assistant",
          content: `[${a.name}]\n\n${res.result}`,
        });
      }
    }
```

Notes for the implementer:
- The outer guard becomes `res.status === "completed" && res.result` (was `a.notifyConversationId && res.result`). The status check is what makes the watcher branch correctly skip snapshot updates on spawn failure — `runAutomation`'s existing try/catch only catches throws from the SDK; a `status === "failed"` result still flows through. The PRD requires "On spawn failure: do NOT update `lastSnapshot`, do NOT notify."
- Baseline detection (`a.lastSnapshot === undefined`) cannot use `prevLines.length === 0` because a watcher whose previous snapshot was empty (e.g. zero open tickets) is NOT a baseline — the next tick that returns an item must fire.
- The `notifyOnlyOnChange === true` path skips the user notification when the conversation id is missing, but always tries to update the snapshot. Without that, a watcher with `notify: false` would never become baseline-armed.

- [ ] **Step 4: Update the call site in `tickAutomations`**

Currently at `server/automations.ts:96-107`:

```ts
  for (const a of due) {
    runAutomation({
      automationId: a.automationId,
      name: a.name,
      task: a.task,
      integrations: a.integrations,
      schedule: a.schedule,
      conversationId: a.conversationId,
      notifyConversationId: a.notifyConversationId,
    }).catch((err) => console.error("[automations] run error", err));
  }
```

Replace with:

```ts
  for (const a of due) {
    runAutomation({
      automationId: a.automationId,
      name: a.name,
      task: a.task,
      integrations: a.integrations,
      schedule: a.schedule,
      conversationId: a.conversationId,
      notifyConversationId: a.notifyConversationId,
      notifyOnlyOnChange: a.notifyOnlyOnChange,
      lastSnapshot: a.lastSnapshot,
    }).catch((err) => console.error("[automations] run error", err));
  }
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: zero errors. If `api.automations.updateSnapshot` is not yet visible to TypeScript, run `pnpm exec convex dev --once` first to regenerate the API typings.

- [ ] **Step 6: Commit**

```bash
git add server/automations.ts
git commit -m "feat(watchers): branch runAutomation on notifyOnlyOnChange with diff-based notify"
```

---

## Task 6: MCP — accept `notifyOnlyOnChange` in `create_automation`, mark watchers in list

**Files:**
- Modify: `server/automation-tools.ts:19-84` (the `create_automation` tool)
- Modify: `server/automation-tools.ts:86-104` (the `list_automations` tool)

- [ ] **Step 1: Add `notifyOnlyOnChange` arg to `create_automation`**

Replace the schema/handler block at `server/automation-tools.ts:31-83` so it accepts and forwards the new arg. The full updated tool definition:

```ts
      tool(
        "create_automation",
        `Schedule a recurring task. The agent will run the task on the schedule and reply with the result.

Cron expressions (5 fields: min hour day-of-month month day-of-week). Examples:
  "0 8 * * *"      — every day at 8am
  "*/15 * * * *"   — every 15 minutes
  "0 9 * * 1-5"    — weekdays at 9am
  "0 18 * * 0"     — Sundays at 6pm

Use this for anything the user says "every [time]" or "remind me" about.
Set notifyOnlyOnChange=true when the user wants a watcher: "me avisa quando
ABRIR / quando MUDAR / quando APARECER / quando CHEGAR algo novo". The agent
will only ping when the result differs from the previous run.
Integrations available: ${integrationHint}`,
        {
          name: z.string().describe("Short label, e.g. 'morning email digest'."),
          schedule: z.string().describe("Cron expression (5 fields)."),
          task: z
            .string()
            .describe("Specific task for the sub-agent — what to look up, draft, or summarize."),
          integrations: z
            .array(z.string())
            .optional()
            .default([])
            .describe(
              "Integration names the sub-agent needs for this task. Pass [] for reminder-only automations that don't need external tools.",
            ),
          notify: z
            .boolean()
            .optional()
            .default(true)
            .describe("If true, send the result to this conversation when it runs."),
          notifyOnlyOnChange: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Watcher mode: only notify when the result is different from the previous run. First tick after creation is silent (baseline). Use for 'avisa quando abrir/mudar/aparecer'.",
            ),
        },
        async (args) => {
          const validation = validateSchedule(args.schedule);
          if (!validation.valid) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Invalid cron expression: ${validation.error}`,
                },
              ],
            };
          }
          const automationId = randomId("auto");
          const nextRunAt = nextRunFor(args.schedule) ?? undefined;
          await convex.mutation(api.automations.create, {
            automationId,
            name: args.name,
            task: args.task,
            integrations: args.integrations,
            schedule: args.schedule,
            conversationId,
            notifyConversationId: args.notify ? conversationId : undefined,
            nextRunAt,
            notifyOnlyOnChange: args.notifyOnlyOnChange,
          });
          const nextStr = nextRunAt ? new Date(nextRunAt).toLocaleString() : "unknown";
          const kind = args.notifyOnlyOnChange ? "watcher" : "automation";
          return {
            content: [
              {
                type: "text" as const,
                text: `Created ${kind} ${automationId} "${args.name}" — next run: ${nextStr}.`,
              },
            ],
          };
        },
      ),
```

- [ ] **Step 2: Mark watchers in `list_automations` output**

Replace the `list_automations` tool block at `server/automation-tools.ts:86-104`:

```ts
      tool(
        "list_automations",
        "List all automations for this conversation.",
        { enabledOnly: z.boolean().optional().default(false) },
        async (args) => {
          const all = await convex.query(api.automations.list, {
            enabledOnly: args.enabledOnly,
          });
          const mine = all.filter((a) => a.conversationId === conversationId);
          if (mine.length === 0) {
            return { content: [{ type: "text" as const, text: "No automations." }] };
          }
          const lines = mine.map((a) => {
            const marker = a.notifyOnlyOnChange ? " (watcher)" : "";
            return `• [${a.automationId}] ${a.enabled ? "●" : "○"}${marker} "${a.name}" — ${a.schedule} — ${a.task}`;
          });
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        },
      ),
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add server/automation-tools.ts
git commit -m "feat(watchers): expose notifyOnlyOnChange in create_automation + mark watchers in list"
```

---

## Task 7: Dispatcher prompt — propose-then-confirm + watcher cue

**Files:**
- Modify: `server/interaction-agent.ts:16-116` (the `INTERACTION_SYSTEM` constant — specifically the "Automations" block at lines 85-89)

The dispatcher already has rules about automations. We add: (a) a watcher cue, (b) a confirmation flow that asks the user before calling `create_automation`.

- [ ] **Step 1: Replace the Automations block**

In `server/interaction-agent.ts`, find the block currently at lines 85-89:

```text
Automations:
- When the user asks for anything recurring ("every morning", "each week", "remind me", "check X daily"), use create_automation — don't just promise to do it later.
- Pick a cron expression (5 fields) and a specific task for the sub-agent.
- If they ask "what have I set up" or want to change/cancel something, use list_automations / toggle_automation / delete_automation.
```

Replace with:

```text
Automations and watchers:
- When the user asks for anything recurring ("every morning", "each week", "remind me", "check X daily"), use create_automation — don't just promise to do it later.
- When the user asks to be notified about CHANGE ("me avisa quando abrir", "me avisa quando mudar", "me avisa quando aparecer", "me avisa quando chegar X novo"), that is a WATCHER. Pass notifyOnlyOnChange: true to create_automation. The first tick after creation is silent (baseline) and subsequent ticks only ping on additions formatted as "Novo: <line>".
- BEFORE calling create_automation, propose the spec back to the user in chat in one short sentence and wait for confirmation. Example: "Vou criar um watcher pra ingressos do Flamengo a cada 30min, te aviso quando abrir venda. Ok?". Only call the tool after the user confirms (next turn).
- Pick a cron expression (5 fields) and a specific task for the sub-agent. For watchers, the task should describe WHAT TO RETURN as a list (one item per line) — the runtime appends format discipline.
- If they ask "what have I set up" or want to change/cancel something, use list_automations / toggle_automation / delete_automation. Watchers show up with a "(watcher)" marker.
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add server/interaction-agent.ts
git commit -m "feat(watchers): teach dispatcher the watcher cue + propose-then-confirm flow"
```

---

## Task 8: End-to-end smoke test

This is a manual exercise — there is no automated harness to slot it into. Skip if the executor is a subagent without a live Convex deploy and Telegram bot.

- [ ] **Step 1: Start the stack**

```bash
pnpm dev
```

Expected: Convex dev pushes the schema, `tsx watch server/index.ts` boots, debug UI runs on Vite. No errors about missing fields on `automations`.

- [ ] **Step 2: Create a watcher via chat**

In Telegram (or the debug chat surface), say:

```
me avisa quando abrir uma issue nova com label "bug" no jrflga/boop-agent, checa a cada 5min
```

Expected dispatcher behavior:
1. Replies in chat proposing the watcher ("Vou criar um watcher pra issues bug a cada 5min, ok?") and DOES NOT call the tool.

Reply "ok" / "sim" / "pode".

Expected:
2. Dispatcher calls `create_automation` with `notifyOnlyOnChange: true`.
3. First tick fires within 5 minutes, runs the spawn, stores the snapshot, and DOES NOT send a Telegram message (silent baseline).

- [ ] **Step 3: Verify the row in Convex dashboard**

Open the Convex dashboard for the dev deployment, table `automations`. Find your new row.

Expected: `notifyOnlyOnChange === true`, `lastSnapshot` is a non-empty string after the first tick completes (allow up to ~60s after the cron fires).

- [ ] **Step 4: Verify subsequent unchanged tick is silent**

Wait for the second cron tick (5 minutes after the first).

Expected: the run shows up in the `automationRuns` table as `completed`, `lastSnapshot` is unchanged or near-identical, and NO new Telegram message is delivered.

- [ ] **Step 5: Force an addition and verify the Novo line**

Either: open a new test issue with the matching label, OR (faster) edit `lastSnapshot` in the Convex dashboard to drop one of its lines, simulating "a new line appeared on the next tick".

Expected: next tick delivers a Telegram message in the format:

```
[<watcher name>]
Novo: <line>
```

- [ ] **Step 6: Disable the watcher**

Say in chat: `desliga o watcher de issues`.

Expected: dispatcher calls `toggle_automation` with `enabled: false`. `list_automations` now shows it with `○` and the `(watcher)` marker.

- [ ] **Step 7: Commit smoke notes**

If you discovered any issue during the smoke test that needed a code fix, commit those fixes here. Otherwise nothing to commit; close the loop with:

```bash
git status   # should be clean
```

---

## Self-review notes

The plan was reviewed against issue #6 with this checklist:

- **Schema:** ✅ Task 1 adds both fields exactly as the PRD's "Storage" section specifies.
- **Runtime branch:** ✅ Task 5 covers task wrapping, Haiku pin, snapshot persistence on success, no update on failure, baseline silence, addition-only notification, telegram + messages dual write.
- **MCP surface:** ✅ Task 6 adds the optional arg, marks watchers in list, leaves toggle/delete unchanged.
- **Confirmation flow:** ✅ Task 7 changes only the dispatcher prompt — no drafts table, as the PRD specified.
- **Pure helpers:** ✅ Task 4 inlines them in `automations.ts`, no separate file (PRD: "Separate `watcher-diff.ts` module" is explicitly out of scope).
- **Out-of-scope items:** Verified none of the tasks add removal notifications, per-line dedup, drafts table, auto-disable, sentinel strings, or threshold policies.
- **Temperature 0:** Not implemented. The Claude Agent SDK does not expose temperature through `query()` options (verified against `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.d.ts`). The PRD's stability concern is mitigated by (a) pinning Haiku, (b) appending the format discipline directive to the task, and (c) set-difference diffing being insensitive to ordering. If LLM nondeterminism produces flapping additions in practice, the follow-up is `extraArgs: { temperature: "0" }` once the underlying CLI supports it, NOT a v1 blocker.

---

## Execution checkpoints

If executing inline (one session), pause after each of these for review:
1. After Task 2 — schema and Convex mutations only. Nothing user-visible yet.
2. After Task 5 — runtime branch in place but no UX changes. Existing automations should still work identically.
3. After Task 7 — feature complete. Smoke test next.
