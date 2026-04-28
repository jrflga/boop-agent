import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function audioTranscriptionEnabled(): boolean {
  return (process.env.STT_PROVIDER ?? "off").trim().toLowerCase() === "local";
}

export function maxAudioBytes(): number {
  return envInt("TELEGRAM_AUDIO_MAX_BYTES", DEFAULT_MAX_BYTES);
}

function localWhisperConfig() {
  const provider = (process.env.STT_PROVIDER ?? "off").trim().toLowerCase();
  if (provider !== "local") {
    throw new Error(`Unsupported STT_PROVIDER "${provider}". Supported values: local, off.`);
  }

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

export async function transcribeAudioFile(inputPath: string): Promise<string> {
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
