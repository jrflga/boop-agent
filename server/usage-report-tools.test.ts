import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
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
      query: vi.fn(async (fn: any, _args: any) => {
        const fnName = getFunctionName(fn);
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
