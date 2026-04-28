import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { getComposio, boopUserId } from "../composio.js";

export interface ComposioUsageSnapshot {
  connectedAccountsCount: number;
  toolExecutionsThisMonth: number;
  toolkitsUsedThisMonth: string[];
  // Free-form notes for the UI
  fetchedAt: number;
}

/**
 * Pulls a usage snapshot for Composio. Counts:
 * - Connected accounts (via Composio SDK)
 * - Tool executions in the current month from our agentLogs (every mcp__<toolkit>__*
 *   tool_use call gets logged)
 * - Distinct toolkits used this month
 */
export async function fetchComposioUsage(): Promise<ComposioUsageSnapshot> {
  const composio = getComposio();
  let connectedAccountsCount = 0;
  if (composio) {
    try {
      const resp = await composio.connectedAccounts.list({ userIds: [boopUserId()] });
      const items = (resp as { items?: unknown[] }).items ?? [];
      connectedAccountsCount = items.length;
    } catch (err) {
      console.warn("[composio-usage] connectedAccounts.list failed", err);
    }
  }

  // Tool executions this month from agentLogs
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const logs = await convex.query(api.agents.recentLogs, {
    sinceMs: monthStart.getTime(),
    limit: 10_000,
  });

  let toolExecutionsThisMonth = 0;
  const toolkits = new Set<string>();
  for (const log of logs as Array<{ logType: string; toolName?: string }>) {
    if (log.logType !== "tool_use" || !log.toolName) continue;
    // Composio tool names are wrapped: mcp__<toolkit-slug>__<TOOL_NAME>
    const m = log.toolName.match(/^mcp__([a-z0-9_-]+)__/i);
    if (!m) continue;
    const toolkit = m[1];
    // Skip our internal mcp servers (boop-*)
    if (toolkit.startsWith("boop-")) continue;
    toolExecutionsThisMonth += 1;
    toolkits.add(toolkit);
  }

  return {
    connectedAccountsCount,
    toolExecutionsThisMonth,
    toolkitsUsedThisMonth: [...toolkits].sort(),
    fetchedAt: Date.now(),
  };
}
