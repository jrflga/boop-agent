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
 */
export function detectAnomalies(
  rows: UsageRow[],
  range: RangeKey,
  now: number = Date.now(),
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // 1. Cost spike: this week vs median of prior 4 weeks. "Has data" means the
  // week had at least one row, not that costUsd > 0 — a quiet $0 week is real
  // signal, and excluding it would inflate the median and hide spikes.
  const weekBoundary = now - weekMs;
  const fourWeeksAgo = now - 5 * weekMs;
  const thisWeek = rows
    .filter((r) => r.createdAt >= weekBoundary && r.createdAt < now)
    .reduce((s, r) => s + r.costUsd, 0);
  const priorByWeek: number[] = [0, 0, 0, 0];
  const priorHasRows: boolean[] = [false, false, false, false];
  for (const r of rows) {
    if (r.createdAt < fourWeeksAgo || r.createdAt >= weekBoundary) continue;
    const w = Math.floor((weekBoundary - r.createdAt) / weekMs);
    if (w >= 0 && w < 4) {
      priorByWeek[w] += r.costUsd;
      priorHasRows[w] = true;
    }
  }
  const priorWithData = priorByWeek.filter((_, i) => priorHasRows[i]);
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
        message: `Dispatcher cache hit ${(rate * 100).toFixed(0)}% (abaixo do alvo de 50%)`,
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
