interface Summary {
  costUsd: number;
  callCount: number;
  cacheHitRate: number;
}

interface TopConversation {
  conversationId: string;
  costUsd: number;
  callCount: number;
}

interface Props {
  summary: Summary | undefined;
  top: TopConversation | undefined;
  isDark: boolean;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function shortConv(id: string): string {
  if (id.startsWith("telegram:")) return id.slice(9);
  return id.length > 12 ? id.slice(0, 12) + "..." : id;
}

export function KpiCards({ summary, top, isDark }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const labelCls = isDark ? "text-slate-500" : "text-slate-500";
  const valueCls = isDark ? "text-slate-100" : "text-slate-900";

  const cards = [
    {
      label: "Custo total",
      value: summary ? fmtUsd(summary.costUsd) : "—",
      sub: summary ? `${summary.callCount} chamadas` : "carregando...",
    },
    {
      label: "Cache hit",
      value: summary ? fmtPct(summary.cacheHitRate) : "—",
      sub: "input tokens cacheados",
    },
    {
      label: "$ / chamada",
      value:
        summary && summary.callCount > 0
          ? fmtUsd(summary.costUsd / summary.callCount)
          : "—",
      sub: "média no período",
    },
    {
      label: "Top conversa",
      value: top ? fmtUsd(top.costUsd) : "—",
      sub: top ? shortConv(top.conversationId) : "sem dados",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className={`border rounded-lg p-4 ${cardCls}`}
        >
          <div className={`text-[11px] uppercase tracking-wide ${labelCls}`}>
            {c.label}
          </div>
          <div className={`text-2xl font-bold mono mt-1 ${valueCls}`}>
            {c.value}
          </div>
          <div className={`text-xs ${labelCls} mt-1`}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
