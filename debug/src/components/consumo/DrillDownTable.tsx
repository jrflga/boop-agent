import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api.js";

interface Props {
  isDark: boolean;
  conversationId?: string;
}

const SOURCE_OPTIONS = [
  "all",
  "dispatcher",
  "execution",
  "extract",
  "consolidation-proposer",
  "consolidation-adversary",
  "consolidation-judge",
] as const;

type SourceOpt = (typeof SOURCE_OPTIONS)[number];

function fmt(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", { hour12: false });
}

export function DrillDownTable({ isDark, conversationId }: Props) {
  const [source, setSource] = useState<SourceOpt>("all");
  const { results, status, loadMore } = usePaginatedQuery(
    api.usage.recentRecords,
    {
      source: source === "all" ? undefined : source,
      conversationId,
    },
    { initialNumItems: 50 },
  );

  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const headCls = isDark ? "text-slate-500" : "text-slate-500";
  const rowCls = isDark
    ? "border-slate-800 hover:bg-slate-800/30"
    : "border-slate-100 hover:bg-slate-50";
  const cellCls = isDark ? "text-slate-300" : "text-slate-700";
  const selectCls = isDark
    ? "bg-slate-900 border-slate-700 text-slate-300"
    : "bg-white border-slate-300 text-slate-700";

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className="flex items-center justify-between mb-3">
        <div className={`text-sm font-semibold ${titleCls}`}>Drill-down</div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourceOpt)}
          className={`text-xs border rounded px-2 py-1 ${selectCls}`}
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-auto max-h-[420px]">
        <table className="w-full text-xs">
          <thead className={`text-[11px] uppercase tracking-wide ${headCls}`}>
            <tr>
              <th className="text-left p-1.5">timestamp</th>
              <th className="text-left p-1.5">source</th>
              <th className="text-left p-1.5">conv</th>
              <th className="text-right p-1.5">in/out</th>
              <th className="text-right p-1.5">cache r/w</th>
              <th className="text-right p-1.5">ctx</th>
              <th className="text-right p-1.5">cost</th>
              <th className="text-right p-1.5">ms</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r: any) => {
              const ctx = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
              return (
                <tr key={r._id} className={`border-t ${rowCls}`}>
                  <td className={`p-1.5 mono ${cellCls}`}>{fmtTime(r.createdAt)}</td>
                  <td className={`p-1.5 mono ${cellCls}`}>{r.source}</td>
                  <td className={`p-1.5 mono truncate max-w-[120px] ${cellCls}`}>
                    {r.conversationId ?? "—"}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>
                    {fmt(r.inputTokens)}/{fmt(r.outputTokens)}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>
                    {fmt(r.cacheReadTokens)}/{fmt(r.cacheCreationTokens)}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>{fmt(ctx)}</td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>
                    ${r.costUsd.toFixed(4)}
                  </td>
                  <td className={`p-1.5 mono text-right ${cellCls}`}>{r.durationMs}</td>
                </tr>
              );
            })}
            {results.length === 0 && (
              <tr>
                <td colSpan={8} className={`p-3 text-center ${headCls}`}>
                  Sem registros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {status === "CanLoadMore" && (
        <button
          onClick={() => loadMore(50)}
          className={`mt-2 w-full text-xs py-1.5 rounded border ${
            isDark
              ? "border-slate-700 text-slate-400 hover:bg-slate-800/40"
              : "border-slate-300 text-slate-600 hover:bg-slate-50"
          }`}
        >
          Carregar mais
        </button>
      )}
    </div>
  );
}
