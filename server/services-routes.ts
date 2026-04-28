import { Router } from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { fetchComposioUsage } from "./usage-fetchers/composio.js";

export function createServicesRouter() {
  const r = Router();

  // GET /services — list all services
  r.get("/", async (_req, res) => {
    try {
      const services = await convex.query(api.services.list, {});
      const totalMonthly = await convex.query(api.services.monthlyTotal, {});
      res.json({ services, totalMonthlyUsd: totalMonthly });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /services/:key — upsert
  r.put("/:key", async (req, res) => {
    try {
      const { displayName, monthlyCostUsd, planName, planLimits, notes } = req.body ?? {};
      if (!displayName || typeof monthlyCostUsd !== "number") {
        return res.status(400).json({ error: "displayName and monthlyCostUsd required" });
      }
      const id = await convex.mutation(api.services.upsert, {
        key: req.params.key,
        displayName,
        monthlyCostUsd,
        planName,
        planLimits: planLimits ? JSON.stringify(planLimits) : undefined,
        notes,
      });
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /services/:key
  r.delete("/:key", async (req, res) => {
    try {
      const ok = await convex.mutation(api.services.remove, { key: req.params.key });
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /services/:key/refresh — re-pull usage from the appropriate fetcher
  r.post("/:key/refresh", async (req, res) => {
    try {
      const key = req.params.key;
      let snapshot: unknown;
      if (key === "composio") {
        snapshot = await fetchComposioUsage();
      } else {
        return res.status(400).json({
          error: `No automated fetcher for service '${key}'. Edit usage manually.`,
        });
      }
      await convex.mutation(api.services.setUsageSnapshot, {
        key,
        usageSnapshot: JSON.stringify(snapshot),
      });
      res.json({ snapshot });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return r;
}

const ANTHROPIC_SEED = {
  key: "anthropic",
  displayName: "Anthropic Claude",
  monthlyCostUsd: 100,
  planName: "Max5x",
};

const COMPOSIO_SEED = {
  key: "composio",
  displayName: "Composio",
  monthlyCostUsd: 0,
  planName: undefined,
  notes: "Atualize com seu plano. Cliquem 'atualizar' pra puxar uso.",
};

const CONVEX_SEED = {
  key: "convex",
  displayName: "Convex",
  monthlyCostUsd: 0,
  planName: undefined,
  notes: "Atualize com seu plano. Uso é manual por enquanto.",
};

/**
 * Idempotent: ensures the three default service entries exist on first boot.
 * No-ops if any already exist (only inserts the missing ones).
 */
export async function ensureSeedServices(): Promise<void> {
  for (const seed of [ANTHROPIC_SEED, COMPOSIO_SEED, CONVEX_SEED]) {
    const existing = await convex.query(api.services.get, { key: seed.key });
    if (existing) continue;
    await convex.mutation(api.services.upsert, seed);
  }
}
