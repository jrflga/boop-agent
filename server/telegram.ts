import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { audioTranscriptionEnabled, maxAudioBytes, transcribeAudioFile } from "./local-stt.js";

const API_BASE = "https://api.telegram.org";
const MAX_CHUNK = 3900;
const TYPING_REFRESH_MS = 4000;

interface TelegramUser {
  id?: number;
  username?: string;
}

interface TelegramChat {
  id?: number;
  type?: string;
  username?: string;
}

interface TelegramMessage {
  message_id?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  voice?: TelegramAudio;
  audio?: TelegramAudio;
}

interface TelegramAudio {
  file_id?: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function allowedIds(): Set<string> {
  return new Set(
    (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isAllowed(message: TelegramMessage): boolean {
  const ids = allowedIds();
  if (ids.size === 0) return false;
  const chatId = message.chat?.id?.toString();
  const fromId = message.from?.id?.toString();
  return Boolean((chatId && ids.has(chatId)) || (fromId && ids.has(fromId)));
}

function telegramCommandReply(content: string): string | null {
  const [rawCommand] = content.split(/\s+/, 1);
  if (!rawCommand?.startsWith("/")) return null;

  const command = rawCommand.split("@", 1)[0]?.toLowerCase();
  switch (command) {
    case "/start":
      return "Oi, eu sou o Boop. Me manda o que você precisa; posso responder coisas rápidas, lembrar preferências ou acionar integrações conectadas.";
    case "/help":
      return "Me manda uma mensagem normal com o que você precisa. Posso conversar, lembrar preferências, agendar tarefas recorrentes e usar integrações conectadas para trabalho real.";
    default:
      return "Ainda não reconheço esse comando do Telegram. Me manda uma mensagem normal, ou tenta /help.";
  }
}

function audioFromMessage(message: TelegramMessage): (TelegramAudio & { kind: "voice" | "audio" }) | null {
  if (message.voice?.file_id) return { ...message.voice, kind: "voice" };
  if (message.audio?.file_id) return { ...message.audio, kind: "audio" };
  return null;
}

function extensionFromFilePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext && ext.length <= 10 ? ext : ".audio";
}

function verifyTelegramSecret(req: express.Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) {
    console.error("[telegram] TELEGRAM_WEBHOOK_SECRET is not set; rejecting webhook");
    return false;
  }
  return req.get("X-Telegram-Bot-Api-Secret-Token") === expected;
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const token = botToken();
  if (!token) {
    console.warn("[telegram] missing TELEGRAM_BOT_TOKEN - not sending");
    return;
  }
  const plain = stripMarkdown(text);
  for (const part of chunk(plain)) {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] send failed ${res.status}: ${body}`);
    } else {
      console.log(`[telegram] -> sent ${part.length} chars to ${chatId}`);
    }
  }
}

async function sendTelegramChatAction(chatId: string, action: "typing"): Promise<void> {
  const token = botToken();
  if (!token) return;
  const res = await fetch(`${API_BASE}/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      action,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[telegram] chat action failed ${res.status}: ${body}`);
  }
}

async function getTelegramFile(fileId: string): Promise<{ filePath: string; fileSize?: number }> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required to download audio.");
  const res = await fetch(`${API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: { file_path?: string; file_size?: number }; description?: string }
    | null;
  if (!res.ok || !body?.ok || !body.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${body?.description ?? res.status}`);
  }
  return {
    filePath: body.result.file_path,
    fileSize: body.result.file_size,
  };
}

async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required to download audio.");
  const res = await fetch(`${API_BASE}/file/bot${token}/${filePath}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram file download failed ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function transcribeTelegramAudio(audio: TelegramAudio & { kind: "voice" | "audio" }): Promise<string> {
  if (!audioTranscriptionEnabled()) {
    throw new Error("Audio transcription is disabled. Set STT_PROVIDER=local to enable it.");
  }
  if (!audio.file_id) throw new Error("Telegram audio has no file_id.");

  const limit = maxAudioBytes();
  if (audio.file_size && audio.file_size > limit) {
    throw new Error(`Telegram audio is too large (${audio.file_size} bytes, max ${limit}).`);
  }

  const file = await getTelegramFile(audio.file_id);
  if (file.fileSize && file.fileSize > limit) {
    throw new Error(`Telegram audio is too large (${file.fileSize} bytes, max ${limit}).`);
  }

  const bytes = await downloadTelegramFile(file.filePath);
  if (bytes.byteLength > limit) {
    throw new Error(`Telegram audio is too large (${bytes.byteLength} bytes, max ${limit}).`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "boop-telegram-audio-"));
  const inputPath = path.join(workDir, `input${extensionFromFilePath(file.filePath)}`);
  try {
    await writeFile(inputPath, bytes);
    return await transcribeAudioFile(inputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function startTypingIndicator(chatId: string): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    sendTelegramChatAction(chatId, "typing").catch((err) =>
      console.error("[telegram] typing indicator failed", err),
    );
  };
  tick();
  const timer = setInterval(tick, TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function registerTelegramWebhook(webhookUrl: string): Promise<void> {
  const token = botToken();
  if (!token) {
    console.warn("[telegram] missing TELEGRAM_BOT_TOKEN - webhook not registered");
    return;
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.warn("[telegram] missing TELEGRAM_WEBHOOK_SECRET - webhook not registered");
    return;
  }
  const res = await fetch(`${API_BASE}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message"],
    }),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Telegram setWebhook failed ${res.status}: ${body}`);
  }
  console.log(`[telegram] webhook registered: ${webhookUrl}`);
}

export function createTelegramRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    if (!verifyTelegramSecret(req)) {
      res.status(401).json({ error: "invalid Telegram webhook secret" });
      return;
    }

    const update = (req.body ?? {}) as TelegramUpdate;
    const updateId = update.update_id;
    if (typeof updateId === "number") {
      const { claimed } = await convex.mutation(api.webhookDedup.claim, {
        provider: "telegram",
        handle: String(updateId),
      });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const message = update.message;
    const textContent = message?.text?.trim();
    const audio = message ? audioFromMessage(message) : null;
    const chatId = message?.chat?.id;
    if (!message || (!textContent && !audio) || typeof chatId !== "number") {
      res.json({ ok: true, skipped: true });
      return;
    }

    if (!isAllowed(message)) {
      console.warn(
        `[telegram] rejected unauthorized update chat=${message.chat?.id ?? "unknown"} from=${message.from?.id ?? "unknown"}`,
      );
      res.status(403).json({ error: "telegram chat/user not allowed" });
      return;
    }

    const chatIdText = String(chatId);
    const conversationId = `telegram:${chatIdText}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const incoming = textContent ?? `[${audio?.kind ?? "audio"} message]`;
    const preview = incoming.length > 100 ? incoming.slice(0, 100) + "..." : incoming;
    console.log(`[turn ${turnTag}] <- telegram:${chatIdText}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", {
      conversationId,
      content: incoming,
      chatId: chatIdText,
      updateId,
    });
    res.json({ ok: true });

    let stopTyping = () => {};
    try {
      let content = textContent;
      if (!content && audio) {
        stopTyping = startTypingIndicator(chatIdText);
        const transcript = await transcribeTelegramAudio(audio);
        const caption = message.caption?.trim();
        content = caption
          ? `[Áudio transcrito]\n${transcript}\n\nLegenda do áudio: ${caption}`
          : `[Áudio transcrito]\n${transcript}`;
        logTranscript(turnTag, transcript);
      }
      if (!content) {
        throw new Error("Telegram update had no text or transcribable audio content.");
      }

      let reply = telegramCommandReply(content);
      if (reply) {
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "user",
          content,
        });
        broadcast("user_message", { conversationId, content });
      } else {
        if (textContent) stopTyping = startTypingIndicator(chatIdText);
        reply = await handleUserMessage({
          conversationId,
          content,
          turnTag,
          onThinking: (t) => broadcast("thinking", { conversationId, t }),
        });
      }
      stopTyping();
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "..." : reply;
        console.log(
          `[turn ${turnTag}] -> reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        await sendTelegramMessage(chatIdText, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] -> (no reply)`);
      }
    } catch (err) {
      stopTyping();
      console.error(`[turn ${turnTag}] handler error`, err);
      if (!textContent && audio) {
        await sendTelegramMessage(
          chatIdText,
          "Foi mal — não consegui transcrever esse áudio agora. Tenta mandar em texto ou envia um áudio mais curto.",
        );
      }
    }
  });

  return router;
}

function logTranscript(turnTag: string, transcript: string): void {
  const preview = transcript.length > 120 ? transcript.slice(0, 120) + "..." : transcript;
  console.log(`[turn ${turnTag}] audio transcript: ${JSON.stringify(preview)}`);
}
