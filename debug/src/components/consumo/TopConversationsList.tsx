interface Conversation {
  conversationId: string;
  costUsd: number;
  callCount: number;
  lastActivityAt: number;
}

interface Props {
  data: Conversation[] | undefined;
  isDark: boolean;
  onSelect: (conversationId: string) => void;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtAge(ms: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor((Date.now() - ms) / dayMs);
  if (days === 0) return "hoje";
  if (days === 1) return "ontem";
  return `${days}d atrás`;
}

export function TopConversationsList({ data, isDark, onSelect }: Props) {
  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const rowCls = isDark
    ? "hover:bg-slate-800/40 border-slate-800"
    : "hover:bg-slate-50 border-slate-200";
  const labelCls = isDark ? "text-slate-400" : "text-slate-600";

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className={`text-sm font-semibold mb-2 ${titleCls}`}>Conversas mais caras</div>
      {!data && <div className={`text-xs ${labelCls}`}>carregando...</div>}
      {data && data.length === 0 && (
        <div className={`text-xs ${labelCls}`}>Nenhuma conversa no período.</div>
      )}
      {data && data.length > 0 && (
        <div className="divide-y">
          {data.map((c) => (
            <button
              key={c.conversationId}
              onClick={() => onSelect(c.conversationId)}
              className={`w-full grid grid-cols-[1fr_auto_auto] items-center gap-3 py-2 px-2 text-left text-xs border-b ${rowCls}`}
            >
              <span className={`mono truncate ${labelCls}`}>
                {c.conversationId}
              </span>
              <span className={`mono ${labelCls}`}>
                {c.callCount} chamadas
              </span>
              <span className={`mono font-semibold ${isDark ? "text-slate-200" : "text-slate-800"}`}>
                {fmtUsd(c.costUsd)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
