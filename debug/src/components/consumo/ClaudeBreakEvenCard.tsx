interface AnthropicService {
  monthlyCostUsd: number;
  planName?: string;
}

interface MonthSummary {
  costUsd: number;
  callCount: number;
}

interface Props {
  anthropicService: AnthropicService | undefined;
  monthSummary: MonthSummary | undefined;
  isDark: boolean;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function ClaudeBreakEvenCard({ anthropicService, monthSummary, isDark }: Props) {
  if (!anthropicService || anthropicService.monthlyCostUsd === 0) return null;

  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const labelCls = isDark ? "text-slate-500" : "text-slate-500";
  const valueCls = isDark ? "text-slate-100" : "text-slate-900";

  const equivalent = monthSummary?.costUsd ?? 0;
  const sub = anthropicService.monthlyCostUsd;
  const utilizationPct = sub > 0 ? Math.min(100, Math.round((equivalent / sub) * 100)) : 0;
  const overage = equivalent - sub;
  const subWorthIt = equivalent >= sub;

  const barColor =
    utilizationPct >= 100
      ? "bg-emerald-500"
      : utilizationPct >= 50
        ? "bg-sky-500"
        : "bg-slate-500";

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className="flex items-baseline justify-between mb-3">
        <div className={`text-sm font-semibold ${titleCls}`}>
          Claude — sub vs API equivalente (mês corrente)
        </div>
        <div className={`text-xs mono ${labelCls}`}>
          plano: {anthropicService.planName ?? "—"}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-3">
        <div>
          <div className={`text-[11px] uppercase tracking-wide ${labelCls}`}>
            Sub paga
          </div>
          <div className={`text-xl font-bold mono ${valueCls}`}>{fmtUsd(sub)}</div>
        </div>
        <div>
          <div className={`text-[11px] uppercase tracking-wide ${labelCls}`}>
            Equivalente API
          </div>
          <div className={`text-xl font-bold mono ${valueCls}`}>
            {fmtUsd(equivalent)}
          </div>
        </div>
        <div>
          <div className={`text-[11px] uppercase tracking-wide ${labelCls}`}>
            {subWorthIt ? "Economia" : "Falta pra break-even"}
          </div>
          <div
            className={`text-xl font-bold mono ${
              subWorthIt
                ? isDark
                  ? "text-emerald-400"
                  : "text-emerald-600"
                : valueCls
            }`}
          >
            {fmtUsd(Math.abs(overage))}
          </div>
        </div>
      </div>
      <div className={`h-2 rounded ${isDark ? "bg-slate-800" : "bg-slate-200"} overflow-hidden`}>
        <div
          className={`h-full ${barColor}`}
          style={{ width: `${utilizationPct}%` }}
        />
      </div>
      <div className={`text-xs mt-1.5 ${labelCls}`}>
        {utilizationPct}% do valor da sub usado em equivalente API · {monthSummary?.callCount ?? 0} chamadas
      </div>
    </div>
  );
}
