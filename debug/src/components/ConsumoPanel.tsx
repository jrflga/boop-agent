import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { KpiCards } from "./consumo/KpiCards.js";
import { DailyCostChart } from "./consumo/DailyCostChart.js";
import { CachingPanel } from "./consumo/CachingPanel.js";
import { TopConversationsList } from "./consumo/TopConversationsList.js";
import { DrillDownTable } from "./consumo/DrillDownTable.js";
import { ConversationDrilldown } from "./consumo/ConversationDrilldown.js";
import { AnomalyBadge } from "./consumo/AnomalyBadge.js";

type Range = "today" | "7d" | "30d" | "all";

const RANGE_LABELS: Record<Range, string> = {
  today: "Hoje",
  "7d": "7d",
  "30d": "30d",
  all: "Tudo",
};

interface Props {
  isDark: boolean;
}

export function ConsumoPanel({ isDark }: Props) {
  const [range, setRange] = useState<Range>("7d");
  const [selectedConv, setSelectedConv] = useState<string | null>(null);

  const summary = useQuery(api.usage.summary, { range });
  const bySource = useQuery(api.usage.bySource, { range });
  const byDay = useQuery(api.usage.byDay, { range });
  const top = useQuery(api.usage.byConversation, { range, limit: 10 });
  const caching = useQuery(api.usage.cachingStats, { range });
  const anomalies = useQuery(api.usage.anomalies, { range });

  // Mark bySource as intentionally referenced to keep the warm cache without TS6133.
  void bySource;

  const tabBase = "px-3 py-1 text-xs rounded-md transition-colors mono";
  const tabActive = isDark
    ? "bg-slate-800 text-slate-100 font-semibold"
    : "bg-slate-200 text-slate-900 font-semibold";
  const tabIdle = isDark
    ? "text-slate-500 hover:text-slate-300"
    : "text-slate-500 hover:text-slate-700";

  if (selectedConv) {
    return (
      <ConversationDrilldown
        conversationId={selectedConv}
        isDark={isDark}
        onBack={() => setSelectedConv(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1">
          {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`${tabBase} ${range === r ? tabActive : tabIdle}`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="text-xs">
          {anomalies && anomalies.length > 0 && (
            <span className={isDark ? "text-rose-400" : "text-rose-600"}>
              🔴 {anomalies.length} alerta{anomalies.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <KpiCards summary={summary} top={top?.[0]} isDark={isDark} />

      {anomalies && anomalies.length > 0 && (
        <AnomalyBadge anomalies={anomalies} isDark={isDark} />
      )}

      <DailyCostChart data={byDay} isDark={isDark} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CachingPanel stats={caching} isDark={isDark} />
        <TopConversationsList
          data={top}
          isDark={isDark}
          onSelect={setSelectedConv}
        />
      </div>

      <DrillDownTable isDark={isDark} />
    </div>
  );
}
