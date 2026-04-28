import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface DayPoint {
  day: string;
  costUsd: number;
  costBySource: {
    dispatcher: number;
    execution: number;
    extract: number;
    consolidation: number;
  };
}

interface Props {
  data: DayPoint[] | undefined;
  isDark: boolean;
}

const COLORS = {
  dispatcher: "#3b82f6", // blue
  execution: "#10b981", // emerald
  extract: "#a855f7", // purple
  consolidation: "#f59e0b", // amber
};

export function DailyCostChart({ data, isDark }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";

  const chartData = (data ?? []).map((d) => ({
    day: d.day.slice(5), // MM-DD
    dispatcher: d.costBySource.dispatcher,
    execution: d.costBySource.execution,
    extract: d.costBySource.extract,
    consolidation: d.costBySource.consolidation,
  }));

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className={`text-sm font-semibold mb-3 ${titleCls}`}>Custo diário</div>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <AreaChart data={chartData}>
            <CartesianGrid stroke={isDark ? "#1e293b" : "#e2e8f0"} strokeDasharray="3 3" />
            <XAxis dataKey="day" stroke={isDark ? "#64748b" : "#94a3b8"} fontSize={11} />
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
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="dispatcher" stackId="1" stroke={COLORS.dispatcher} fill={COLORS.dispatcher} />
            <Area type="monotone" dataKey="execution" stackId="1" stroke={COLORS.execution} fill={COLORS.execution} />
            <Area type="monotone" dataKey="extract" stackId="1" stroke={COLORS.extract} fill={COLORS.extract} />
            <Area type="monotone" dataKey="consolidation" stackId="1" stroke={COLORS.consolidation} fill={COLORS.consolidation} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
