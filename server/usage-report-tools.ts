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
