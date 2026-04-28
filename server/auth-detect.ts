import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthMethod = "api" | "subscription" | "unknown";

let cached: AuthMethod | undefined;

/**
 * Detect how the Claude Agent SDK is authenticating, so usageRecords can be
 * tagged accordingly. The SDK itself doesn't expose this directly, so we
 * infer from environment + filesystem.
 *
 * Priority:
 * 1. ANTHROPIC_API_KEY env var → "api" (pay-per-token)
 * 2. CLAUDE_CODE_OAUTH_TOKEN env var OR ~/.claude/.credentials.json → "subscription"
 * 3. otherwise → "unknown"
 *
 * Result is cached process-wide; the auth doesn't change without a restart.
 */
export function detectAuthMethod(): AuthMethod {
  if (cached) return cached;
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    cached = "api";
    return cached;
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    cached = "subscription";
    return cached;
  }
  // Claude Code CLI stores OAuth creds at ~/.claude/.credentials.json on macOS/Linux
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) {
    cached = "subscription";
    return cached;
  }
  cached = "unknown";
  return cached;
}

/** Reset the memoized result (testing only). */
export function resetAuthMethodCache(): void {
  cached = undefined;
}
