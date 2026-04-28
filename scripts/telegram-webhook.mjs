#!/usr/bin/env node
// Registers the Telegram webhook for the current public URL.
//
// Usage:
//   node scripts/telegram-webhook.mjs <public-webhook-url>

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");

function readEnv() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node scripts/telegram-webhook.mjs <public-webhook-url>");
    process.exit(2);
  }

  const env = { ...readEnv(), ...process.env };
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) {
    console.log("[webhook] skipping - TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET not set");
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ["message"],
    }),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`[webhook] Telegram setWebhook failed ${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(`[webhook] registered ${url}`);
}

main().catch((err) => {
  console.error(`[webhook] failed: ${err?.message ?? err}`);
  process.exit(1);
});
