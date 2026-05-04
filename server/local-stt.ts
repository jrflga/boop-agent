import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GROQ_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_GROQ_MODEL = "whisper-large-v3-turbo";
const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

type SttProvider = "local" | "groq";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rawProvider(): string {
  return (process.env.STT_PROVIDER ?? "off").trim().toLowerCase();
}

export function audioTranscriptionEnabled(): boolean {
  const p = rawProvider();
  return p === "local" || p === "groq";
}

export function maxAudioBytes(): number {
  return envInt("TELEGRAM_AUDIO_MAX_BYTES", DEFAULT_MAX_BYTES);
}

function selectedProvider(): SttProvider {
  const p = rawProvider();
  if (p === "local" || p === "groq") return p;
  throw new Error(`Unsupported STT_PROVIDER "${p}". Supported: local, groq, off.`);
}

function localWhisperConfig() {
  const model = process.env.WHISPER_MODEL?.trim();
  if (!model) {
    throw new Error("WHISPER_MODEL is required for local audio transcription.");
  }
  return {
    ffmpegBin: process.env.FFMPEG_BIN?.trim() || "ffmpeg",
    whisperBin: process.env.WHISPER_BIN?.trim() || "whisper-cli",
    model,
    language: process.env.WHISPER_LANGUAGE?.trim() || "pt",
    timeoutMs: envInt("WHISPER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    threads: process.env.WHISPER_THREADS?.trim(),
    useGpu: process.env.WHISPER_USE_GPU?.trim().toLowerCase() === "true",
  };
}

function groqConfig() {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is required for Groq audio transcription.");
  }
  return {
    apiKey,
    model: process.env.GROQ_STT_MODEL?.trim() || DEFAULT_GROQ_MODEL,
    // Groq accepts a single primary language hint in ISO-639-1. We reuse
    // WHISPER_LANGUAGE so users who flip providers don't have to duplicate.
    language: process.env.GROQ_STT_LANGUAGE?.trim() || process.env.WHISPER_LANGUAGE?.trim() || "pt",
    timeoutMs: envInt("GROQ_STT_TIMEOUT_MS", DEFAULT_GROQ_TIMEOUT_MS),
  };
}

async function transcribeWithLocalWhisper(inputPath: string): Promise<string> {
  const cfg = localWhisperConfig();
  const workDir = await mkdtemp(path.join(tmpdir(), "boop-stt-"));
  const wavPath = path.join(workDir, "audio.wav");
  const outBase = path.join(workDir, "transcript");
  const outTxt = `${outBase}.txt`;

  try {
    await execFileAsync(
      cfg.ffmpegBin,
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { timeout: cfg.timeoutMs, maxBuffer: 1024 * 1024 },
    );

    const args = [
      "-m",
      cfg.model,
      "-f",
      wavPath,
      "-l",
      cfg.language,
      "-nt",
      "-otxt",
      "-of",
      outBase,
    ];
    if (cfg.threads) args.push("-t", cfg.threads);
    if (!cfg.useGpu) args.push("-ng");

    await execFileAsync(cfg.whisperBin, args, {
      timeout: cfg.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });

    const transcript = (await readFile(outTxt, "utf-8")).trim();
    if (!transcript) {
      throw new Error("Whisper returned an empty transcript.");
    }
    return transcript;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function transcribeWithGroq(inputPath: string): Promise<string> {
  const cfg = groqConfig();
  const buf = await readFile(inputPath);
  // Groq's allowlist is flac/mp3/mp4/mpeg/mpga/m4a/ogg/opus/wav/webm and it
  // sniffs the filename extension. Telegram saves voice messages as `.oga`
  // (the Ogg container with Opus inside) which trips a 400 even though the
  // bytes are valid. Normalize `.oga` -> `.ogg` for upload only.
  const ext = path.extname(inputPath).toLowerCase();
  const safeExt = ext === ".oga" ? ".ogg" : ext;
  const base = path.basename(inputPath, ext);
  const filename = (base || "audio") + (safeExt || ".ogg");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)]), filename);
  form.append("model", cfg.model);
  form.append("language", cfg.language);
  form.append("response_format", "text");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Groq STT failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
    );
  }

  const transcript = (await res.text()).trim();
  if (!transcript) {
    throw new Error("Groq returned an empty transcript.");
  }
  return transcript;
}

export async function transcribeAudioFile(inputPath: string): Promise<string> {
  switch (selectedProvider()) {
    case "groq":
      return transcribeWithGroq(inputPath);
    case "local":
      return transcribeWithLocalWhisper(inputPath);
  }
}
