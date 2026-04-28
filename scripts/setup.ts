#!/usr/bin/env tsx
import prompts from "prompts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, "utf8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function writeEnv(path: string, env: Record<string, string>): void {
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";

  let out = "";
  const seen = new Set<string>();
  const sections = example.split(/\n(?=# ----)/);

  for (const section of sections) {
    const sectionKeys = [...section.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    let s = section;
    for (const k of sectionKeys) {
      // Remove ALL existing occurrences of this key in the section (dedupe).
      const pattern = new RegExp(`^${k}=.*(\\r?\\n)?`, "gm");
      const matches = [...s.matchAll(pattern)];
      if (matches.length === 0) continue;

      if (seen.has(k)) {
        // Already written in an earlier section — just strip any re-occurrences.
        s = s.replace(pattern, "");
        continue;
      }

      const v = env[k] ?? "";
      // Replace first occurrence, remove the rest.
      let replaced = false;
      s = s.replace(pattern, (match) => {
        if (!replaced) {
          replaced = true;
          return `${k}=${v}` + (match.endsWith("\n") ? "\n" : "");
        }
        return "";
      });
      seen.add(k);
    }
    out += s + "\n";
  }
  writeFileSync(path, out.trim() + "\n");
}

function banner(s: string) {
  console.log("\n" + "━".repeat(60));
  console.log("  " + s);
  console.log("━".repeat(60));
}

async function runConvexDev(): Promise<void> {
  // If CONVEX_DEPLOYMENT is already set, `convex dev` reuses that deployment.
  // Only pass --configure new if this is a first-time setup — otherwise re-running
  // setup would silently create a new project and abandon all existing data.
  const existing = readEnv(ENV_PATH);
  const args = existing.CONVEX_DEPLOYMENT
    ? ["convex", "dev", "--once"]
    : ["convex", "dev", "--once", "--configure", "new"];

  console.log(`\nLaunching \`npx ${args.join(" ")}\` to configure your deployment.`);
  console.log("Convex will open a browser window if you're not logged in.");
  if (existing.CONVEX_DEPLOYMENT) {
    console.log(`Reusing existing deployment: ${existing.CONVEX_DEPLOYMENT}`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("npx", args, { stdio: "inherit", cwd: ROOT });
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`convex dev exited ${code}`)),
    );
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore — fall back to the printed URL */
  }
}

async function main() {
  banner("boop-agent setup");

  console.log(`
What this does:
  1. Configures Telegram Bot API + personal access control
  2. Asks about your Claude model preference
  3. Runs \`npx convex dev\` to create a Convex project
  4. Writes .env.local

Before you start:
  • A Claude Code subscription:    https://claude.com/code
  • Convex account (free tier):    https://convex.dev
  • Telegram bot from BotFather:   https://t.me/BotFather
`);

  const existing = readEnv(ENV_PATH);

  const telegramDefaults = {
    TELEGRAM_BOT_TOKEN: existing.TELEGRAM_BOT_TOKEN ?? "",
    TELEGRAM_WEBHOOK_SECRET:
      existing.TELEGRAM_WEBHOOK_SECRET ?? randomBytes(24).toString("hex"),
    TELEGRAM_ALLOWED_CHAT_IDS: existing.TELEGRAM_ALLOWED_CHAT_IDS ?? "",
    ADMIN_TOKEN: existing.ADMIN_TOKEN ?? randomBytes(24).toString("hex"),
  };

  const telegramPrompts = [] as any[];
  if (!telegramDefaults.TELEGRAM_BOT_TOKEN) {
    telegramPrompts.push({
      type: "text",
      name: "TELEGRAM_BOT_TOKEN",
      message: "Telegram bot token from BotFather",
      initial: "",
    });
  }
  telegramPrompts.push(
    {
      type: "text",
      name: "TELEGRAM_WEBHOOK_SECRET",
      message: "Telegram webhook secret token",
      initial: telegramDefaults.TELEGRAM_WEBHOOK_SECRET,
    },
    {
      type: "text",
      name: "TELEGRAM_ALLOWED_CHAT_IDS",
      message: "Allowed Telegram chat/user IDs (comma-separated)",
      initial: telegramDefaults.TELEGRAM_ALLOWED_CHAT_IDS,
    },
    {
      type: "text",
      name: "ADMIN_TOKEN",
      message: "Admin token for dashboard/API access",
      initial: telegramDefaults.ADMIN_TOKEN,
    },
  );

  const answers = await prompts(
    [
      ...telegramPrompts,
      {
        type: "select",
        name: "BOOP_MODEL",
        message: "Which Claude model should the agent use?",
        choices: [
          { title: "claude-sonnet-4-6 (recommended)", value: "claude-sonnet-4-6" },
          { title: "claude-opus-4-6 (slowest, most capable)", value: "claude-opus-4-6" },
          { title: "claude-haiku-4-5 (fastest, cheapest)", value: "claude-haiku-4-5" },
        ],
        initial: 0,
      },
      {
        type: "text",
        name: "PORT",
        message: "Local server port",
        initial: existing.PORT ?? "3456",
      },
      {
        type: "confirm",
        name: "runConvex",
        message: "Run `convex dev` now to configure your Convex deployment?",
        initial: true,
      },
    ],
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  // Merge generated/existing defaults with what the user answered (answer wins).
  Object.assign(answers, {
    TELEGRAM_BOT_TOKEN: answers.TELEGRAM_BOT_TOKEN ?? telegramDefaults.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET:
      answers.TELEGRAM_WEBHOOK_SECRET ?? telegramDefaults.TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_ALLOWED_CHAT_IDS:
      answers.TELEGRAM_ALLOWED_CHAT_IDS ?? telegramDefaults.TELEGRAM_ALLOWED_CHAT_IDS,
    ADMIN_TOKEN: answers.ADMIN_TOKEN ?? telegramDefaults.ADMIN_TOKEN,
  });

  // ---- Composio API key ---------------------------------------------------
  banner("Composio — integrations (Gmail, Slack, GitHub, Linear, 1000+ more)");
  const composioSettingsUrl = "https://platform.composio.dev/settings";
  const existingComposio = existing.COMPOSIO_API_KEY ?? "";
  const { composioMode } = await prompts(
    {
      type: "select",
      name: "composioMode",
      message: existingComposio
        ? "Composio API key detected. Keep it or replace?"
        : "Configure Composio now? (needed to connect any integration)",
      choices: existingComposio
        ? [
            { title: "Keep existing key", value: "keep" },
            { title: "Replace (opens the Composio dashboard)", value: "replace" },
            { title: "Skip", value: "skip" },
          ]
        : [
            { title: "Yes — open the Composio dashboard and paste my key", value: "replace" },
            { title: "Skip for now", value: "skip" },
          ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (composioMode === "replace") {
    console.log(`\nOpening ${composioSettingsUrl} — grab your API key there.`);
    console.log(`(If the browser doesn't open, copy the URL above.)\n`);
    openInBrowser(composioSettingsUrl);
    const { COMPOSIO_API_KEY } = await prompts(
      {
        type: "password",
        name: "COMPOSIO_API_KEY",
        message: "Paste your Composio API key (leave blank to skip):",
        initial: "",
      },
      {
        onCancel: () => {
          console.log("Setup cancelled.");
          process.exit(1);
        },
      },
    );
    (answers as any).COMPOSIO_API_KEY = COMPOSIO_API_KEY || existingComposio;
  } else if (composioMode === "keep") {
    (answers as any).COMPOSIO_API_KEY = existingComposio;
  } else {
    (answers as any).COMPOSIO_API_KEY = existingComposio;
    console.log(
      `\nSkipped. Add COMPOSIO_API_KEY to .env.local later to enable integrations.`,
    );
  }

  // ---- Local speech-to-text ----------------------------------------------
  banner("Telegram voice transcription — local Whisper");
  console.log(`
Optional. If enabled, Telegram voice/audio messages are downloaded, converted
with ffmpeg, transcribed locally with whisper-cli, then handled like normal text.

For a VPS, install these first:
  • ffmpeg
  • whisper.cpp / whisper-cli
  • a multilingual model, e.g. ggml-large-v3-turbo-q5_0.bin
`);

  const existingStt = existing.STT_PROVIDER ?? "off";
  const { sttMode } = await prompts(
    {
      type: "select",
      name: "sttMode",
      message:
        existingStt === "local"
          ? "Local voice transcription is enabled. Keep, reconfigure, or disable?"
          : "Enable local Telegram voice transcription now?",
      choices:
        existingStt === "local"
          ? [
              { title: "Keep existing local Whisper settings", value: "keep" },
              { title: "Reconfigure local Whisper", value: "local" },
              { title: "Disable voice transcription", value: "off" },
            ]
          : [
              { title: "Skip for now", value: "off" },
              { title: "Enable local Whisper", value: "local" },
            ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (sttMode === "local") {
    const sttAnswers = await prompts(
      [
        {
          type: "text",
          name: "WHISPER_BIN",
          message: "Path to whisper-cli",
          initial: existing.WHISPER_BIN ?? "whisper-cli",
        },
        {
          type: "text",
          name: "WHISPER_MODEL",
          message: "Path to multilingual Whisper model",
          initial:
            existing.WHISPER_MODEL ??
            "/opt/whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin",
          validate: (v: string) => Boolean(v.trim()) || "WHISPER_MODEL is required",
        },
        {
          type: "text",
          name: "WHISPER_LANGUAGE",
          message: "Whisper language code",
          initial: existing.WHISPER_LANGUAGE ?? "pt",
        },
        {
          type: "text",
          name: "FFMPEG_BIN",
          message: "Path to ffmpeg",
          initial: existing.FFMPEG_BIN ?? "ffmpeg",
        },
        {
          type: "text",
          name: "WHISPER_TIMEOUT_MS",
          message: "Transcription timeout in ms",
          initial: existing.WHISPER_TIMEOUT_MS ?? "120000",
        },
        {
          type: "text",
          name: "TELEGRAM_AUDIO_MAX_BYTES",
          message: "Max Telegram audio download size in bytes",
          initial: existing.TELEGRAM_AUDIO_MAX_BYTES ?? "26214400",
        },
        {
          type: "text",
          name: "WHISPER_THREADS",
          message: "Whisper CPU threads (blank = whisper default)",
          initial: existing.WHISPER_THREADS ?? "",
        },
        {
          type: "confirm",
          name: "WHISPER_USE_GPU",
          message: "Use GPU acceleration for Whisper? Choose no for most VPSes.",
          initial: existing.WHISPER_USE_GPU === "true",
          format: (v: boolean) => String(v),
        },
      ],
      {
        onCancel: () => {
          console.log("Setup cancelled.");
          process.exit(1);
        },
      },
    );
    Object.assign(answers, sttAnswers, { STT_PROVIDER: "local" });
  } else if (sttMode === "keep") {
    Object.assign(answers, {
      STT_PROVIDER: existing.STT_PROVIDER ?? "local",
      WHISPER_BIN: existing.WHISPER_BIN ?? "whisper-cli",
      WHISPER_MODEL: existing.WHISPER_MODEL ?? "",
      WHISPER_LANGUAGE: existing.WHISPER_LANGUAGE ?? "pt",
      FFMPEG_BIN: existing.FFMPEG_BIN ?? "ffmpeg",
      WHISPER_TIMEOUT_MS: existing.WHISPER_TIMEOUT_MS ?? "120000",
      TELEGRAM_AUDIO_MAX_BYTES: existing.TELEGRAM_AUDIO_MAX_BYTES ?? "26214400",
      WHISPER_THREADS: existing.WHISPER_THREADS ?? "",
      WHISPER_USE_GPU: existing.WHISPER_USE_GPU ?? "false",
    });
  } else {
    Object.assign(answers, { STT_PROVIDER: "off" });
    console.log("\nSkipped. Set STT_PROVIDER=local later to enable Telegram audio transcription.");
  }

  // ---- Tunnel configuration ------------------------------------------------
  banner("Tunnel — public URL for Telegram to reach your server");
  console.log(`
ngrok's FREE plan gives you a NEW public URL every restart, which means
re-registering the Telegram webhook every time. For a stable URL, pick one of:

  1. Free ngrok             (fine for testing / demos — re-paste each restart)
  2. ngrok RESERVED domain  (paid — stays the same across restarts)
  3. Cloudflare Tunnel / other static tunnel you set up yourself
`);

  const { tunnelChoice } = await prompts(
    {
      type: "select",
      name: "tunnelChoice",
      message: "Which option are you using?",
      choices: [
        { title: "Free ngrok — auto-register on each restart", value: "free" },
        { title: "ngrok reserved domain (paid)", value: "ngrok-domain" },
        { title: "Cloudflare Tunnel or another stable URL", value: "static" },
      ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (tunnelChoice === "ngrok-domain") {
    const { NGROK_DOMAIN } = await prompts({
      type: "text",
      name: "NGROK_DOMAIN",
      message: "Your ngrok reserved domain (e.g. boop.ngrok.app, no https://):",
      initial: existing.NGROK_DOMAIN ?? "",
    });
    const clean = (NGROK_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (clean) {
      (answers as any).NGROK_DOMAIN = clean;
      (answers as any).PUBLIC_URL = `https://${clean}`;
    }
  } else if (tunnelChoice === "static") {
    const { PUBLIC_URL } = await prompts({
      type: "text",
      name: "PUBLIC_URL",
      message: "Your stable public URL (e.g. https://boop.mydomain.com):",
      initial: existing.PUBLIC_URL ?? "",
    });
    if (PUBLIC_URL) {
      (answers as any).PUBLIC_URL = PUBLIC_URL.replace(/\/$/, "");
      (answers as any).NGROK_DOMAIN = "";
    }
  } else {
    // free ngrok — clear any stale domain and keep PUBLIC_URL at the localhost default
    (answers as any).NGROK_DOMAIN = "";
  }

  const env: Record<string, string> = { ...existing, ...answers };
  delete (env as any).runConvex;
  if (!env.PUBLIC_URL) env.PUBLIC_URL = `http://localhost:${env.PORT ?? "3456"}`;
  // Clear stale / stub Convex values so `convex dev` can populate them freshly.
  // (`convex dev` uses .convex/ to identify the deployment, not these env vars.)
  if (env.CONVEX_URL?.includes("example.convex.cloud")) delete env.CONVEX_URL;
  if (env.VITE_CONVEX_URL?.includes("example.convex.cloud")) delete env.VITE_CONVEX_URL;
  writeEnv(ENV_PATH, env);

  banner("Claude authentication");
  console.log(`This project uses your Claude Code subscription — no Anthropic API key needed.

If you haven't already:
  • Install Claude Code:  npm install -g @anthropic-ai/claude-code
  • Run once:              claude
  • Sign in when prompted

The Claude Agent SDK reads the credentials Claude Code saves on disk.
You can override with ANTHROPIC_API_KEY in .env.local if you'd rather use an API key.
`);

  if (answers.runConvex) {
    await runConvexDev();
    const after = readEnv(ENV_PATH);

    // CONVEX_DEPLOYMENT is what `convex dev` writes; derive CONVEX_URL from it
    // so it matches even if a stale URL lingered from a previous setup.
    const deploymentMatch = after.CONVEX_DEPLOYMENT?.match(/^([a-z]+):([\w-]+)/);
    if (deploymentMatch) {
      const url = `https://${deploymentMatch[2]}.convex.cloud`;
      if (after.CONVEX_URL !== url || after.VITE_CONVEX_URL !== url) {
        writeEnv(ENV_PATH, {
          ...after,
          CONVEX_URL: url,
          VITE_CONVEX_URL: url,
        });
        console.log(`\n✓ Synced CONVEX_URL + VITE_CONVEX_URL → ${url}`);
      }
    }
  } else {
    console.log("\nSkipped Convex. Run `npx convex dev` yourself when ready.");
  }

  const port = answers.PORT ?? "3456";
  banner("You're set up. Here's how to actually run it.");
  console.log(`
Before you start: install ngrok (one-time).

  brew install ngrok                           # macOS
  # or download:  https://ngrok.com/download
  ngrok config add-authtoken <your-token>      # free at https://dashboard.ngrok.com

⚠ ngrok's FREE plan gives you a NEW URL every restart. That means
  re-registering the Telegram webhook every time.  For anything beyond a demo,
  use a stable URL:
    • ngrok paid plan (reserved domain), or
    • Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

Then run ONE command:

  npm run dev

That starts the server, Convex watcher, debug dashboard, AND ngrok all
together — color-prefixed output so you can tell who's saying what. Once
the tunnel is live, you'll see a banner with your public URL.

Wire up Telegram:

  1. Create a bot with BotFather and put TELEGRAM_BOT_TOKEN in .env.local.
  2. Add your Telegram chat/user ID to TELEGRAM_ALLOWED_CHAT_IDS.
  3. Run: npm run telegram:webhook -- <PUBLIC_URL>/telegram/webhook
     (npm run dev auto-registers this for free ngrok unless disabled).

Test it:
  • Open http://localhost:5173 for the debug dashboard (Chat tab works
    without Telegram).
  • Or message your Telegram bot from an allowed account. The agent replies.

Gotcha to double-check:
  Telegram updates are rejected unless X-Telegram-Bot-Api-Secret-Token
  matches TELEGRAM_WEBHOOK_SECRET and the chat/user ID is allowlisted.

Integrations (via Composio):
  1. Set COMPOSIO_API_KEY in .env.local (get one at https://app.composio.dev/developers?utm_source=chris&utm_medium=youtube&utm_campaign=collab).
  2. Open the debug dashboard → Connections tab.
  3. Click Connect on any toolkit (Gmail, Slack, GitHub, Linear, Notion, …).
  4. Composio handles OAuth; the toolkit becomes available to the agent.

Telegram voice transcription:
  • Optional and local-first. Enable with STT_PROVIDER=local.
  • VPS deps: ffmpeg, whisper-cli, and WHISPER_MODEL pointing at a multilingual model.
  • Good default model: ggml-large-v3-turbo-q5_0.bin.
  • CPU is the default. Set WHISPER_USE_GPU=true only if your VPS has compatible GPU support.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
