import { PluggyClient } from "pluggy-sdk";

let cached: PluggyClient | null | undefined;

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
