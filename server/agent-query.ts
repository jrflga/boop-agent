import { query } from "@anthropic-ai/claude-agent-sdk";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CLAUDE_DEBUG_DIR = path.join(homedir(), ".claude", "debug");
const DEFAULT_DEBUG_TAIL_LINES = 30;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Pulls the tail of the most recently mtime'd `~/.claude/debug/*.txt` whose
// mtime is at or after `sinceMs`. The Claude Code SDK writes per-invocation
// debug logs there but does not surface them via the parent process's stderr,
// so when a subprocess exits non-zero we have no other window into why.
async function readLatestSdkDebugTail(
  sinceMs: number,
  lines: number = DEFAULT_DEBUG_TAIL_LINES,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(CLAUDE_DEBUG_DIR);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".txt")) continue;
    const full = path.join(CLAUDE_DEBUG_DIR, name);
    try {
      const s = await stat(full);
      if (!s.isFile() || s.mtimeMs < sinceMs) continue;
      if (!best || s.mtimeMs > best.mtime) {
        best = { path: full, mtime: s.mtimeMs };
      }
    } catch {
      // ignore stat failures
    }
  }
  if (!best) return null;
  try {
    const text = await readFile(best.path, "utf-8");
    const tail = text.split("\n").slice(-lines).join("\n");
    return `${path.basename(best.path)}\n${tail}`;
  } catch {
    return null;
  }
}

type QueryArgs = Parameters<typeof query>[0];

interface QueryWithRetryOpts {
  label: string;
  maxAttempts?: number;
  backoffMs?: number;
}

// Wraps the SDK's `query()` async iterator with:
//   1. A bounded retry on "Claude Code process exited" errors that arrive
//      before any message has been streamed to the caller (mid-stream retry
//      is unsafe because tool calls may have already produced side effects).
//   2. A best-effort dump of the latest SDK debug-log tail whenever we give
//      up, so the failure cause shows up in pm2 logs instead of just an
//      opaque "exited with code N".
//
// The SDK uses a `for await` pattern, so this is exposed as an async
// generator that the caller can drop in place of `query(...)`.
export async function* queryWithRetry(
  args: QueryArgs,
  opts: QueryWithRetryOpts,
) {
  const max = opts.maxAttempts ?? 2;
  const backoff = opts.backoffMs ?? 1000;

  for (let attempt = 1; attempt <= max; attempt++) {
    let yielded = 0;
    const startMs = Date.now();
    try {
      for await (const msg of query(args)) {
        yielded++;
        yield msg;
      }
      if (attempt > 1) {
        console.warn(`[${opts.label}] recovered on attempt ${attempt}`);
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isExitErr = /Claude Code process (exited|terminated)/.test(message);

      const giveUp = !isExitErr || yielded > 0 || attempt >= max;
      if (giveUp) {
        const tail = await readLatestSdkDebugTail(startMs).catch(() => null);
        if (tail) {
          console.error(`[${opts.label}] Claude Code debug log tail:\n${tail}`);
        }
        throw err;
      }

      const wait = backoff * attempt;
      console.warn(
        `[${opts.label}] attempt ${attempt} failed (${message}); retrying in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
}
