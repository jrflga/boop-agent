import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api.js";

interface Service {
  _id: string;
  key: string;
  displayName: string;
  monthlyCostUsd: number;
  planName?: string;
  planLimits?: string;
  lastFetchAt?: number;
  usageSnapshot?: string;
  notes?: string;
}

interface Props {
  isDark: boolean;
  /** Origin of the boop server, e.g. "http://localhost:3456" or "/api" for vite proxy. */
  serverOrigin: string;
  /** Admin token for the boop server (used to call /services routes). */
  adminToken: string;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtAge(ms?: number): string {
  if (!ms) return "nunca";
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s atrás`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m atrás`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h atrás`;
  return `${Math.floor(hr / 24)}d atrás`;
}

export function ServicesPanel({ isDark, serverOrigin, adminToken }: Props) {
  const services = useQuery(api.services.list, {});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cardCls = isDark
    ? "border-slate-800 bg-slate-900/40"
    : "border-slate-200 bg-white";
  const titleCls = isDark ? "text-slate-300" : "text-slate-700";
  const labelCls = isDark ? "text-slate-500" : "text-slate-500";
  const subCls = isDark ? "text-slate-400" : "text-slate-600";
  const buttonCls = isDark
    ? "border-slate-700 text-slate-400 hover:bg-slate-800/40"
    : "border-slate-300 text-slate-600 hover:bg-slate-50";

  async function refresh(key: string) {
    setRefreshing(key);
    setError(null);
    try {
      const r = await fetch(`${serverOrigin}/services/${key}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
    } catch (err) {
      setError(`${key}: ${(err as Error).message}`);
    } finally {
      setRefreshing(null);
    }
  }

  return (
    <div className={`border rounded-lg p-4 ${cardCls}`}>
      <div className="flex items-center justify-between mb-3">
        <div className={`text-sm font-semibold ${titleCls}`}>Serviços</div>
      </div>
      {!services && <div className={`text-xs ${labelCls}`}>carregando...</div>}
      {services && services.length === 0 && (
        <div className={`text-xs ${labelCls}`}>Nenhum serviço cadastrado.</div>
      )}
      {error && (
        <div
          className={`mb-2 text-xs px-2 py-1 rounded border ${
            isDark
              ? "border-rose-700/50 bg-rose-900/30 text-rose-300"
              : "border-rose-300 bg-rose-50 text-rose-700"
          }`}
        >
          {error}
        </div>
      )}
      {services && services.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {services.map((s: Service) => (
            <ServiceCard
              key={s.key}
              service={s}
              isDark={isDark}
              cardCls={cardCls}
              titleCls={titleCls}
              labelCls={labelCls}
              subCls={subCls}
              buttonCls={buttonCls}
              onRefresh={() => refresh(s.key)}
              onEdit={() => setEditingKey(s.key)}
              refreshing={refreshing === s.key}
            />
          ))}
        </div>
      )}
      {editingKey && services && (
        <EditModal
          service={services.find((s: Service) => s.key === editingKey)!}
          isDark={isDark}
          serverOrigin={serverOrigin}
          adminToken={adminToken}
          onClose={() => setEditingKey(null)}
        />
      )}
    </div>
  );
}

function ServiceCard({
  service,
  isDark,
  cardCls,
  titleCls,
  labelCls,
  subCls,
  buttonCls,
  onRefresh,
  onEdit,
  refreshing,
}: {
  service: Service;
  isDark: boolean;
  cardCls: string;
  titleCls: string;
  labelCls: string;
  subCls: string;
  buttonCls: string;
  onRefresh: () => void;
  onEdit: () => void;
  refreshing: boolean;
}) {
  void isDark;
  const usage = service.usageSnapshot ? safeJson(service.usageSnapshot) : null;
  const isComposio = service.key === "composio";
  const canAutoFetch = isComposio;

  return (
    <div className={`border rounded-md p-3 ${cardCls}`}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className={`text-sm font-semibold ${titleCls} truncate`}>
          {service.displayName}
        </div>
        <div className={`text-sm font-bold mono ${titleCls}`}>
          {fmtUsd(service.monthlyCostUsd)}
        </div>
      </div>
      <div className={`text-xs ${labelCls} mb-2`}>
        {service.planName ?? "sem plano"} · /mês
      </div>

      {usage && isComposio && (
        <div className={`text-xs ${subCls} space-y-0.5 mb-2`}>
          <div>
            <span className="mono">{usage.connectedAccountsCount}</span> contas conectadas
          </div>
          <div>
            <span className="mono">{usage.toolExecutionsThisMonth}</span> execuções esse mês
          </div>
          {usage.toolkitsUsedThisMonth?.length > 0 && (
            <div className={`mono ${labelCls} truncate`}>
              {usage.toolkitsUsedThisMonth.join(", ")}
            </div>
          )}
        </div>
      )}

      {service.notes && (
        <div className={`text-xs italic ${labelCls} mb-2`}>{service.notes}</div>
      )}

      <div className={`text-[10px] ${labelCls} mb-2`}>
        última sync: {fmtAge(service.lastFetchAt)}
      </div>

      <div className="flex gap-1.5">
        <button
          onClick={onEdit}
          className={`flex-1 text-xs py-1 rounded border ${buttonCls}`}
        >
          editar
        </button>
        {canAutoFetch && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className={`flex-1 text-xs py-1 rounded border ${buttonCls} ${refreshing ? "opacity-50" : ""}`}
          >
            {refreshing ? "..." : "atualizar"}
          </button>
        )}
      </div>
    </div>
  );
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function EditModal({
  service,
  isDark,
  serverOrigin,
  adminToken,
  onClose,
}: {
  service: Service;
  isDark: boolean;
  serverOrigin: string;
  adminToken: string;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState(service.displayName);
  const [monthlyCost, setMonthlyCost] = useState(String(service.monthlyCostUsd));
  const [planName, setPlanName] = useState(service.planName ?? "");
  const [notes, setNotes] = useState(service.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overlayCls = "fixed inset-0 bg-black/50 flex items-center justify-center z-50";
  const dialogCls = isDark
    ? "bg-slate-900 border border-slate-700 text-slate-200"
    : "bg-white border border-slate-300 text-slate-800";
  const inputCls = isDark
    ? "bg-slate-800 border-slate-700 text-slate-200"
    : "bg-white border-slate-300 text-slate-800";
  const buttonCls = isDark
    ? "border-slate-700 text-slate-300 hover:bg-slate-800"
    : "border-slate-300 text-slate-700 hover:bg-slate-50";
  const primaryCls = isDark
    ? "bg-emerald-600 hover:bg-emerald-500 text-white"
    : "bg-emerald-500 hover:bg-emerald-400 text-white";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${serverOrigin}/services/${service.key}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          displayName,
          monthlyCostUsd: Number(monthlyCost),
          planName: planName || undefined,
          notes: notes || undefined,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={overlayCls} onClick={onClose}>
      <div
        className={`p-5 rounded-lg w-[420px] max-w-[90vw] ${dialogCls}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">
          Editar: {service.displayName}
        </div>
        <div className="space-y-2.5 text-xs">
          <Field label="Nome">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={`w-full px-2 py-1 border rounded ${inputCls}`}
            />
          </Field>
          <Field label="Custo mensal (USD)">
            <input
              type="number"
              step="0.01"
              value={monthlyCost}
              onChange={(e) => setMonthlyCost(e.target.value)}
              className={`w-full px-2 py-1 border rounded ${inputCls}`}
            />
          </Field>
          <Field label="Plano">
            <input
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              placeholder="ex: Max5x, Pro, Free"
              className={`w-full px-2 py-1 border rounded ${inputCls}`}
            />
          </Field>
          <Field label="Notas">
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`w-full px-2 py-1 border rounded ${inputCls}`}
            />
          </Field>
        </div>
        {error && (
          <div className="mt-2 text-xs text-rose-500">{error}</div>
        )}
        <div className="mt-4 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className={`px-3 py-1 text-xs rounded border ${buttonCls}`}
          >
            cancelar
          </button>
          <button
            onClick={save}
            disabled={saving}
            className={`px-3 py-1 text-xs rounded ${primaryCls} ${saving ? "opacity-50" : ""}`}
          >
            {saving ? "salvando..." : "salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1">{label}</div>
      {children}
    </label>
  );
}
