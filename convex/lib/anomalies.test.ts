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
