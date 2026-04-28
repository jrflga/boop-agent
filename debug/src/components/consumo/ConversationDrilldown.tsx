import { useQuery } from "convex/react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { api } from "../../../../convex/_generated/api.js";
import { DrillDownTable } from "./DrillDownTable.js";

interface Props {
  conversationId: string;
  isDark: boolean;
  onBack: () => void;
}

const SONNET_CTX_LIMIT = 200_000;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour12: false });
}

export function ConversationDrilldown({ conversationId, isDark, onBack }: Props) {
  const points = useQuery(api.usage.contextSizes, {
    conversationId,
    limit: 200,
  });

  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const labelCls = isDark ? "text-slate-500" : "text-slate-500";

  let cumulative = 0;
  const chartData = (points ?? []).map((p: any) => {
    cumulative += p.costUsd;
    return {
      time: fmtTime(p.createdAt),
      contextTokens: p.contextTokens,
      costUsd: p.costUsd,
      cumulativeUsd: cumulative,
    };
  });

  const totalCost = chartData.length ? chartData[chartData.length - 1].cumulativeUsd : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className={`text-xs px-2.5 py-1 rounded border ${
            isDark
              ? "border-slate-700 text-slate-400 hover:bg-slate-800/40"
              : "border-slate-300 text-slate-600 hover:bg-slate-50"
          }`}
        >
          ← voltar
        </button>
        <span className={`mono text-sm ${titleCls}`}>{conversationId}</span>
        <span className={`mono text-xs ${labelCls}`}>
          total ${totalCost.toFixed(2)} · {chartData.length} chamadas
        </span>
      </div>

      <div className={`border rounded-lg p-4 ${cardCls}`}>
        <div className={`text-sm font-semibold mb-2 ${titleCls}`}>
          Tamanho do contexto por turno
        </div>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke={isDark ? "#1e293b" : "#e2e8f0"} strokeDasharray="3 3" />
              <XAxis dataKey="time" stroke={isDark ? "#64748b" : "#94a3b8"} fontSize={11} />
              <YAxis
                stroke={isDark ? "#64748b" : "#94a3b8"}
                fontSize={11}
                tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? "#0f172a" : "#fff",
                  border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(v: any) => `${Number(v).toLocaleString()} tokens`}
              />
              <ReferenceLine
                y={SONNET_CTX_LIMIT}
                stroke="#f43f5e"
                strokeDasharray="4 4"
                label={{ value: "limite Sonnet (200k)", fill: "#f43f5e", fontSize: 10 }}
              />
              <Line type="monotone" dataKey="contextTokens" stroke="#3b82f6" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className={`border rounded-lg p-4 ${cardCls}`}>
        <div className={`text-sm font-semibold mb-2 ${titleCls}`}>
          Custo cumulativo
        </div>
        <div style={{ width: "100%", height: 180 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke={isDark ? "#1e293b" : "#e2e8f0"} strokeDasharray="3 3" />
              <XAxis dataKey="time" stroke={isDark ? "#64748b" : "#94a3b8"} fontSize={11} />
              <YAxis
                stroke={isDark ? "#64748b" : "#94a3b8"}
                fontSize={11}
                tickFormatter={(v) => `$${v.toFixed(2)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? "#0f172a" : "#fff",
                  border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(v: any) => `$${Number(v).toFixed(4)}`}
              />
              <Line type="monotone" dataKey="cumulativeUsd" stroke="#10b981" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <DrillDownTable isDark={isDark} conversationId={conversationId} />
    </div>
  );
}
