interface SourceStat {
  source: string;
  hitRate: number;
  savedUsd: number;
}

interface CachingStats {
  perSource: SourceStat[];
  totalSavedUsd: number;
  brokenCacheCount: number;
}

interface Props {
  stats: CachingStats | undefined;
  isDark: boolean;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

export function CachingPanel({ stats, isDark }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const labelCls = isDark ? "text-slate-400" : "text-slate-600";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";

  if (!stats) {
    return (
      <div className={`border rounded-lg p-4 ${cardCls}`}>
        <div className={`text-sm font-semibold ${titleCls}`}>Cache health</div>
        <div className={`text-xs mt-2 ${labelCls}`}>carregando...</div>
      </div>
    );
  }

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className="flex items-baseline justify-between mb-3">
        <div className={`text-sm font-semibold ${titleCls}`}>Cache health</div>
        <div className={`text-xs mono ${labelCls}`}>
          economizou ${stats.totalSavedUsd.toFixed(2)}
        </div>
      </div>
      <div className="space-y-2">
        {stats.perSource.length === 0 && (
          <div className={`text-xs ${labelCls}`}>Sem dados de cache no período.</div>
        )}
        {stats.perSource.map((s) => {
          const widthPct = Math.round(s.hitRate * 100);
          const barColor =
            s.hitRate >= 0.7
              ? "bg-emerald-500"
              : s.hitRate >= 0.5
                ? "bg-amber-500"
                : "bg-rose-500";
          return (
            <div key={s.source} className="grid grid-cols-[120px_1fr_80px] items-center gap-2 text-xs">
              <span className={`mono ${labelCls}`}>{s.source}</span>
              <div className={`h-2 rounded ${isDark ? "bg-slate-800" : "bg-slate-200"}`}>
                <div className={`h-full rounded ${barColor}`} style={{ width: `${widthPct}%` }} />
              </div>
              <span className={`mono ${labelCls} text-right`}>
                {fmtPct(s.hitRate)} · ${s.savedUsd.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
      {stats.brokenCacheCount > 0 && (
        <div
          className={`mt-3 text-xs px-2 py-1.5 rounded ${
            isDark
              ? "bg-amber-900/30 text-amber-300 border border-amber-700/40"
              : "bg-amber-50 text-amber-800 border border-amber-200"
          }`}
        >
          ⚠️ {stats.brokenCacheCount} turnos do dispatcher com cache_read=0 dentro do TTL
        </div>
      )}
    </div>
  );
}
