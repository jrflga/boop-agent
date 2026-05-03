import "./env-setup.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { createTelegramRouter } from "./telegram.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { adminTokenFromUpgrade, isAdminTokenValid, requireAdminToken } from "./http-auth.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";
import { createFinanceRouter } from "./finance/routes.js";
import { getFinanceDb } from "./finance/db.js";

async function main() {
  // Open SQLite + run any pending migrations on boot, so the first finance
  // request doesn't pay the migrate cost and a missing/unwritable data dir
  // surfaces immediately instead of inside a tool call.
  getFinanceDb();
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();
  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost.
  preloadLocalModel();

  // If a stable public URL is configured, register the Composio webhook +
  // Gmail trigger now. For ngrok-based dev, scripts/dev.mjs drives the same
  // function once the ngrok URL is known, so we skip when only the local
  // PORT default is available.
  // Proactive Gmail watcher disabled in this fork: the dispatch path in
  // proactive-email.ts still calls into Sendblue/iMessage, which we removed
  // when migrating to Telegram. Re-enable after porting that dispatch to
  // sendTelegramMessage.
  void ensureProactiveWatcher;
  // const stableUrl = process.env.PUBLIC_URL;
  // if (stableUrl && !stableUrl.includes("localhost")) {
  //   ensureProactiveWatcher(stableUrl).catch((err) =>
  //     console.error("[proactive] startup failed", err),
  //   );
  // }

  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDir = path.resolve(__dirname, "..", "debug", "dist");

  app.use(cors());
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  app.use("/telegram", createTelegramRouter());

  // Dashboard (debug React app). Static assets are public; the API
  // behind /api/* and the WebSocket are gated. The bundle has no
  // secrets in it (only VITE_CONVEX_URL, public-by-design).
  app.use(express.static(dashboardDir, { index: false, fallthrough: true }));
  app.get(/^\/(?!api\/|auth\/|telegram\/|health$|ws$|login$).*/, (req, res, next) => {
    if (!req.accepts("text/html")) {
      next();
      return;
    }
    const indexPath = path.join(dashboardDir, "index.html");
    res.sendFile(indexPath, (err) => {
      if (err) next(err);
    });
  });

  const apiRouter = express.Router();
  apiRouter.use(requireAdminToken);
  apiRouter.use("/composio", createComposioRouter());
  apiRouter.use("/memory", createMemoryRouter());
  apiRouter.use("/finance", createFinanceRouter());

  apiRouter.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  apiRouter.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  apiRouter.post("/compact", async (_req, res) => {
    try {
      const { runCompaction } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runCompaction("compact-manual").catch((err) =>
        console.error("[compaction] manual run failed", err),
      );
      res.json({ ok: true, triggered: "compact-manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  apiRouter.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  apiRouter.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({ conversationId, content });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/api", apiRouter);

  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info: { req: Parameters<typeof adminTokenFromUpgrade>[0] }) =>
      isAdminTokenValid(adminTokenFromUpgrade(info.req)),
  });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/api/chat`);
    console.log(`  telegram    POST http://localhost:${port}/telegram/webhook`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
