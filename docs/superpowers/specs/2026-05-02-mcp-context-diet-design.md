# MCP Context Diet — Design

**Date:** 2026-05-02
**Status:** approved (pending implementation plan)
**Author:** João Alves (with Claude)

## Background

Mario Zechner argues in [What if you don't need MCP?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) that popular MCP servers eat large amounts of context for tool descriptions agents already know how to use. Concrete numbers from the post: Playwright MCP loads 21 tools at 13.7k tokens (6.8% of Claude's context). The proposed alternative is short bash/node CLI scripts referenced via short READMEs (around 200 tokens) that the agent loads on demand.

A complementary approach, [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), keeps MCP infrastructure but proxies it through a single tool with lazy schema loading.

This spec applies both ideas to two surfaces:

1. **Claude Code (the user's CLI agent)**, where MCPs and plugins consume the global context window.
2. **boop-agent runtime**, where each spawned execution agent receives a Composio toolkit's full tool set (often 25 plus per toolkit), even when the task only needs two or three.

## Goals

- Cut idle context cost in Claude Code by removing MCPs the user does not actively use.
- Give boop's execution agents a smaller, curated tool surface per spawn, with telemetry to spot bloat.
- Document a level 3 path (Mario-style CLI scripts replacing Playwright entirely, plus boop-side budget enforcement) without implementing it now.

## Non-goals

- Replacing the entire MCP ecosystem.
- Building Mario's 4 browser scripts in this round (documented for a future round).
- Touching Composio's curated toolkit list beyond adding optional `defaultTools` filters.
- Multi-tenant or multi-user changes anywhere.

## Out of scope (level 3, documented only)

- `~/agent-tools/browser/` with `start.js`, `nav.js`, `eval.js`, `screenshot.js`.
- Boop interaction-agent enforcing a per-spawn `maxTools` budget driven by telemetry.

---

## Section 1 — Claude Code (Part A)

### A1. Create `~/agent-tools/` infrastructure

New directory at the user's home to host CLI tooling that the agent loads via `@README.md` references rather than via permanently loaded MCP descriptors.

```
~/agent-tools/
  README.md                              # one-paragraph index
  docs/
    agent-tools-philosophy.md            # when to add a CLI script vs an MCP
    playwright-replacement.md            # level 3 plan (doc only)
    boop-tool-budget.md                  # level 3 plan for boop (doc only)
```

The top-level `README.md` should be 50 to 100 tokens and list each subdirectory with a one-line purpose. The agent loads it only when the user types `@~/agent-tools/README.md` (or `/add-dir ~/agent-tools`).

`agent-tools-philosophy.md` codifies the rule: a CLI script is preferred when (a) the model already knows the underlying API or command, (b) outputs can be saved to files, and (c) composition with other shell tools is natural. An MCP is preferred when the integration requires hosted auth, streaming, or a stable contract that the host cannot reproduce locally.

### A2. Remove unused MCPs from Claude Code (user scope)

Confirmed currently active via `claude mcp list`:

- `claude.ai Gmail` — needs auth, kept on claude.ai web only.
- `claude.ai Google Calendar` — same.
- `claude.ai Google Drive` — same.
- `pencil` — connected, not used in current workflow.
- `plugin:playwright:playwright` — connected, attacked directly by Mario as the worst offender.

Remove the three `claude.ai` connectors and `pencil` via `claude mcp remove <name> -s user` (scope confirmed during implementation). Disable the Playwright plugin by setting `enabledPlugins["playwright@claude-plugins-official"]: false` in `~/.claude/settings.json`. The plugin remains installed and can be re-enabled by flipping the flag.

After this step the active MCP/tool count in Claude Code drops to zero. When the user needs browser automation, the level 3 plan (Section 3, D1) applies. When the user needs Pencil, they re-enable the MCP for that session.

### A3. (intentionally empty)

Originally proposed a project-level Playwright disable for boop, then made redundant by removing it globally in A2.

---

## Section 2 — Boop runtime (Part B)

### B1. Tool-count telemetry per spawn

In `server/composio.ts:buildComposioIntegrationModule`, immediately after `const tools = await session.tools();` (currently around line 585), log:

```
[composio] <slug>: <count> tools loaded — <comma-separated tool names>
```

The log line lands in the server's stdout and is captured by the existing debug pipeline. No Convex schema change. No new dashboard work in this round.

This gives the user a baseline distribution of tool counts per toolkit and per spawn before deciding which `defaultTools` filters to write.

### B2. Optional `defaultTools` filter per toolkit

Extend the `CURATED_TOOLKITS` entries in `server/composio.ts` so each entry may declare an optional `defaultTools?: string[]`. The shape:

```ts
{ slug: "gmail",  label: "Gmail",  defaultTools: ["GMAIL_SEND_EMAIL", "GMAIL_LIST_MESSAGES", "GMAIL_GET_MESSAGE"] }
```

In `buildComposioIntegrationModule`, after `session.tools()`, apply the filter:

```ts
const curated = CURATED_TOOLKITS.find((t) => t.slug === slug);
const tools = curated?.defaultTools
  ? rawTools.filter((t) => curated.defaultTools!.includes(t.name))
  : rawTools;
```

When `defaultTools` is omitted (the default for every toolkit at first), behavior is unchanged. Initial curation in this round: only fill `defaultTools` for the 2 or 3 toolkits that the B1 telemetry shows are heaviest. The exact list is decided during implementation, not in the spec.

`composio.create()` is left untouched. The filter happens in JS after the SDK call. This avoids depending on a Composio API surface we have not validated.

### B3. Brief documentation in `INTEGRATIONS.md`

Add a short "Tool curation" section near the existing curated-list paragraph. It explains:

- Why curation matters (each tool description costs context per spawn).
- How to find tool slugs (`listToolsForToolkit(slug)` already exists).
- When to set `defaultTools` (start with the heaviest toolkits surfaced by B1 logs).
- The escape hatch (set `defaultTools: undefined` to fall back to the full set).

---

## Section 3 — Documentation only (Level 3)

### D1. `~/agent-tools/docs/playwright-replacement.md`

A standalone design for replacing the Playwright plugin with Mario's pattern. Covers:

- The four scripts (`start.js`, `nav.js`, `eval.js`, `screenshot.js`) under `~/agent-tools/browser/`.
- Profile copying behavior so the agent's Chrome session does not collide with the user's daily browser.
- A short README under `~/agent-tools/browser/` (target around 200 tokens) describing usage.
- Migration steps: build, smoke test on a real workflow, then keep Playwright disabled permanently.

This document is written but no script is built in this round.

### D2. `boop-agent/docs/agents/tool-budget.md`

A standalone design for budget enforcement on top of B1's telemetry. Covers:

- Sampling strategy: collect tool-count distributions per toolkit over a chosen window.
- Choosing a budget N per toolkit (95th percentile vs. p50).
- How the dispatcher (interaction-agent) would pass an optional `maxTools` argument to `spawn_agent`.
- How `buildComposioIntegrationModule` would consume `maxTools` to truncate or to fail loud when `defaultTools.length > maxTools`.

This document is written but no enforcement code is built in this round.

---

## Files touched

**Created:**

- `~/agent-tools/README.md`
- `~/agent-tools/docs/agent-tools-philosophy.md`
- `~/agent-tools/docs/playwright-replacement.md` (D1)
- `boop-agent/docs/agents/tool-budget.md` (D2)

**Modified:**

- `~/.claude/settings.json` (disable Playwright plugin)
- `boop-agent/server/composio.ts` (B1 logging, B2 filter, `CURATED_TOOLKITS` shape)
- `boop-agent/INTEGRATIONS.md` (B3 section)

**Removed via CLI (no file change):**

- claude.ai Gmail, Calendar, Drive, and pencil MCPs from Claude Code user scope.

## Verification

- `claude mcp list` shows zero active MCPs after Section 1.
- Spawning a boop execution agent against a connected Composio toolkit emits a `[composio] <slug>: N tools` line.
- For any toolkit with `defaultTools`, the logged count equals the curated list length.
- `pnpm tsc -p tsconfig.json` (or whatever the repo uses) passes.
- Manual: send a Telegram turn that triggers a Gmail spawn after curation, confirm the sub-agent still completes the task with the curated tool set.

## Risks and rollbacks

- **Pencil or Playwright needed during implementation.** Roll back the single relevant change (`claude mcp add` or flip the plugin flag back to `true`).
- **Composio toolkit's curated `defaultTools` excludes a tool the agent actually needs.** B1 logging makes the regression visible; fix is to extend the array or set it to `undefined`.
- **Filter applied to a tool object shape we did not anticipate.** Mitigation: keep the filter behind a defensive check (`if (curated?.defaultTools && rawTools.length)`), and run the verification turn before merging.
