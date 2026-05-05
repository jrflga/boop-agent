import { useCallback, useEffect, useState } from "react";
import { PluggyConnect } from "react-pluggy-connect";
import { apiFetch } from "../lib/adminAuth.js";

type ItemRow = {
  itemId: string;
  alias: string;
  connectorId: number | null;
  status: string;
  lastSyncAt: string | null;
  createdAt: string;
};

function formatDate(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function PluggySection({ isDark }: { isDark: boolean }) {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [clientUserId, setClientUserId] = useState("boop-default");
  const [itemId, setItemId] = useState("");
  const [connectToken, setConnectToken] = useState("");
  const [showWidget, setShowWidget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

  const cardBg = isDark ? "bg-slate-900/50 border-slate-800" : "bg-white border-slate-200";
  const muted = isDark ? "text-slate-500" : "text-slate-400";

  const fetchItems = useCallback(async () => {
    try {
      const r = await apiFetch("/api/finance/items");
      const json = (await r.json()) as { items: ItemRow[] };
      setItems(json.items ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchItems();
    apiFetch("/api/finance/config")
      .then((r) => r.json())
      .then((j: { webhookUrl: string | null }) => setWebhookUrl(j.webhookUrl))
      .catch(() => setWebhookUrl(null));
  }, [fetchItems]);

  const openConnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch("/api/finance/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientUserId: clientUserId.trim() || undefined,
          itemId: itemId.trim() || undefined,
        }),
      });
      const json = (await r.json().catch(() => ({}))) as {
        accessToken?: string;
        error?: string;
      };
      if (!r.ok || !json.accessToken) {
        throw new Error(json.error ?? r.statusText);
      }
      setConnectToken(json.accessToken);
      setShowWidget(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [clientUserId, itemId]);

  const registerItem = useCallback(
    async (nextItemId: string) => {
      const alias = clientUserId.trim() || nextItemId;
      const r = await apiFetch("/api/finance/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: nextItemId, alias }),
      });
      if (!r.ok) {
        const json = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? r.statusText);
      }
      await fetchItems();
    },
    [clientUserId, fetchItems],
  );

  return (
    <section>
      <SectionHeader
        title="Pluggy connect"
        count={items.length}
        isDark={isDark}
        hint="Server-side Connect Token + public webhook"
      />

      <div className={`rounded-xl border px-4 py-4 ${cardBg}`}>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs">
            <span className={muted}>clientUserId / alias</span>
            <input
              value={clientUserId}
              onChange={(e) => setClientUserId(e.target.value)}
              className={`rounded-lg border px-3 py-2 text-sm bg-transparent outline-none ${
                isDark
                  ? "border-slate-700 text-slate-100 placeholder:text-slate-600"
                  : "border-slate-300 text-slate-900 placeholder:text-slate-400"
              }`}
              placeholder="boop-default"
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className={muted}>Update existing itemId</span>
            <input
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              className={`rounded-lg border px-3 py-2 text-sm bg-transparent outline-none ${
                isDark
                  ? "border-slate-700 text-slate-100 placeholder:text-slate-600"
                  : "border-slate-300 text-slate-900 placeholder:text-slate-400"
              }`}
              placeholder="optional itemId to update"
            />
          </label>
        </div>

        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button
            onClick={openConnect}
            disabled={busy}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              busy ? "bg-slate-600 text-slate-300" : "bg-sky-600 hover:bg-sky-500 text-white"
            }`}
          >
            {busy ? "Preparing…" : "Open Pluggy Connect"}
          </button>
          <div className={`text-[11px] mono ${muted}`}>
            webhook:{" "}
            <span className={isDark ? "text-slate-300" : "text-slate-700"}>
              {webhookUrl ?? "(set PUBLIC_URL or PLUGGY_WEBHOOK_URL)"}
            </span>
          </div>
        </div>

        {error && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
              isDark ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-rose-200 bg-rose-50 text-rose-900"
            }`}
          >
            {error}
          </div>
        )}

        {showWidget && connectToken && (
          <div className={`mt-4 rounded-xl border p-3 ${isDark ? "border-slate-800" : "border-slate-200"}`}>
            <PluggyConnect
              connectToken={connectToken}
              includeSandbox={false}
              language="pt"
              theme={isDark ? "dark" : "light"}
              updateItem={itemId.trim() || undefined}
              onSuccess={async (data) => {
                const nextItemId = data?.item?.id;
                if (!nextItemId) return;
                try {
                  await registerItem(nextItemId);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
              onError={(err) => {
                setError(err.message);
              }}
              onClose={() => {
                setShowWidget(false);
                setConnectToken("");
              }}
            />
          </div>
        )}

        <div className="mt-4">
          <div className={`text-xs font-medium ${isDark ? "text-slate-200" : "text-slate-800"}`}>
            Registered items
          </div>
          {!loaded ? (
            <div className={`mt-2 h-10 rounded-lg border ${cardBg} shimmer`} />
          ) : items.length === 0 ? (
            <div className={`mt-2 text-xs ${muted}`}>No items yet. Open the widget to connect one.</div>
          ) : (
            <div className="mt-2 space-y-2">
              {items.map((item) => (
                <div
                  key={item.itemId}
                  className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-xs ${
                    isDark ? "border-slate-800 bg-slate-950/40" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <span className="mono">{item.alias}</span>
                  <span className={muted}>{item.status}</span>
                  <span className={muted}>connector {item.connectorId ?? "?"}</span>
                  <span className={muted}>last sync {formatDate(item.lastSyncAt)}</span>
                  <span className={`ml-auto mono ${muted}`}>{item.itemId}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SectionHeader({
  title,
  count,
  isDark,
  hint,
}: {
  title: string;
  count: number;
  isDark: boolean;
  hint?: string;
}) {
  return (
    <div className={`flex items-center justify-between px-2 py-2.5 border-b ${isDark ? "border-slate-800" : "border-slate-200"}`}>
      <div>
        <div className={`text-xs font-semibold uppercase tracking-wider ${isDark ? "text-slate-500" : "text-slate-400"}`}>
          {title}
        </div>
        {hint && <div className={`text-[11px] mt-0.5 ${isDark ? "text-slate-600" : "text-slate-500"}`}>{hint}</div>}
      </div>
      <span className={`text-xs mono ${isDark ? "text-slate-500" : "text-slate-400"}`}>{count}</span>
    </div>
  );
}
