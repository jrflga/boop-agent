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
