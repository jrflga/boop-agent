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
