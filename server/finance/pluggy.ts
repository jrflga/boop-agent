import { PluggyClient } from "pluggy-sdk";

let cached: PluggyClient | null | undefined;

// Pluggy can only reach a publicly resolvable HTTPS URL. Either set
// `PLUGGY_WEBHOOK_URL` directly or expose the server through `PUBLIC_URL`
// — anything else returns null so callers can decide whether to skip
// webhook setup or surface a clear error.
export function resolvePluggyWebhookUrl(): string | null {
  const explicit = process.env.PLUGGY_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const publicUrl = process.env.PUBLIC_URL?.trim();
  if (publicUrl && /^https:\/\//i.test(publicUrl) && !publicUrl.includes("localhost")) {
    return `${publicUrl.replace(/\/$/, "")}/webhooks/pluggy`;
  }
  return null;
}

export function getPluggyWebhookSecret(): string | null {
  const secret = process.env.PLUGGY_WEBHOOK_SECRET?.trim();
  return secret && secret.length > 0 ? secret : null;
}

// Returns the singleton Pluggy client, or `null` when credentials are not
// configured. Callers should null-check and surface a clear "Pluggy not
// configured" message instead of throwing — Banking BR is opt-in per fork.
export function getPluggyClient(): PluggyClient | null {
  if (cached !== undefined) return cached;
  const clientId = process.env.PLUGGY_CLIENT_ID?.trim();
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    cached = null;
    return cached;
  }
  cached = new PluggyClient({ clientId, clientSecret });
  return cached;
}

export async function createPluggyConnectToken(opts: {
  itemId?: string;
  clientUserId?: string;
  webhookUrl?: string;
}): Promise<{ accessToken: string }> {
  const client = getPluggyClient();
  if (!client) {
    throw new Error("Pluggy is not configured. Set PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET.");
  }
  const webhookUrl = opts.webhookUrl?.trim() || resolvePluggyWebhookUrl() || undefined;
  return client.createConnectToken(opts.itemId, {
    clientUserId: opts.clientUserId?.trim() || undefined,
    webhookUrl,
    avoidDuplicates: true,
  });
}

// Registers a single webhook subscribed to "all" events at our public URL,
// pinned with the configured shared secret. Idempotent: if a webhook for
// the same URL already exists it's updated (in case the secret rotated),
// otherwise a new one is created.
//
// Boot-time best-effort: returns a status object instead of throwing so a
// missing PUBLIC_URL or transient Pluggy outage doesn't crash the server.
export async function ensurePluggyWebhook(): Promise<
  | { status: "skipped"; reason: string }
  | { status: "registered"; id: string; url: string }
  | { status: "updated"; id: string; url: string }
  | { status: "error"; error: string }
> {
  const client = getPluggyClient();
  if (!client) return { status: "skipped", reason: "Pluggy not configured" };
  const url = resolvePluggyWebhookUrl();
  if (!url) {
    return {
      status: "skipped",
      reason: "PUBLIC_URL is not a public HTTPS URL; set PLUGGY_WEBHOOK_URL",
    };
  }
  const secret = getPluggyWebhookSecret();
  const headers: Record<string, string> | undefined = secret
    ? { "X-Webhook-Secret": secret }
    : undefined;

  try {
    const existing = await client.fetchWebhooks();
    const match = (existing.results ?? []).find(
      (w) => w.url === url && w.disabledAt === null,
    );
    if (match) {
      // Always re-push the secret in case it was rotated; createWebhook +
      // updateWebhook accept null to clear headers, which is fine when
      // the secret is now unset.
      await client.updateWebhook(match.id, { headers: headers ?? null });
      return { status: "updated", id: match.id, url };
    }
    const created = await client.createWebhook("all", url, headers);
    return { status: "registered", id: created.id, url };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
