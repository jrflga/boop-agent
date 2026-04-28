import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { nextRunFor } from "./automations.js";

const COST_DIGEST_NAME = "cost-digest";

const COST_DIGEST_TASK = `Use a tool usage_report({range: "7d"}).

Produza um resumo curto (5-8 linhas) em português:
- Custo total da semana
- Cache hit rate por source (destaque se algum < 50%)
- Top 3 conversas mais caras
- Anomalias detectadas (se houver)

Se houver anomalia com severity "high", prefixe a mensagem com "ALERTAS:".
Tom: relatório seco, sem saudação, sem floreio. Não use em-dashes.`;

const COST_DIGEST_SCHEDULE = "0 9 * * 0"; // Sunday 9am

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Idempotent: ensures a "cost-digest" automation row exists. Always created
 * disabled by default; the user enables via Telegram (toggle_automation).
 */
export async function ensureCostDigestAutomation(
  defaultNotifyConversationId?: string,
): Promise<void> {
  const existing = await convex.query(api.automations.getByName, {
    name: COST_DIGEST_NAME,
  });
  if (existing) return;

  const automationId = randomId("auto");
  const nextRunAt = nextRunFor(COST_DIGEST_SCHEDULE) ?? undefined;

  await convex.mutation(api.automations.create, {
    automationId,
    name: COST_DIGEST_NAME,
    task: COST_DIGEST_TASK,
    integrations: [],
    schedule: COST_DIGEST_SCHEDULE,
    notifyConversationId: defaultNotifyConversationId,
    nextRunAt,
  });

  // The default `create` mutation marks new rows enabled=true. We want the
  // digest disabled by default so the user opts in explicitly.
  await convex.mutation(api.automations.setEnabled, {
    automationId,
    enabled: false,
  });
}
