import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseTruthyEnv } from "./logger";

export interface Config {
  botToken: string;
  allowedUsers: { ids: Set<number>; usernames: Set<string> };
  yolo: boolean;
  verbose: boolean;
}

export function globalConfigDir(): string {
  return path.join(os.homedir(), ".remotecode");
}

export function ensureConfigDir(): void {
  const dir = globalConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), "config");
}

export function pidFilePath(): string {
  return path.join(globalConfigDir(), "remotecode.pid");
}

export function logFilePath(): string {
  return path.join(globalConfigDir(), "remotecode.log");
}

export function sessionsFilePath(): string {
  return path.join(globalConfigDir(), "local");
}

export function whisperModelDir(): string {
  return path.join(globalConfigDir(), "whisper");
}

export function whisperModelPath(): string {
  return path.join(whisperModelDir(), "ggml-small.bin");
}

export function defaultCwd(): string {
  const dir = path.join(globalConfigDir(), "RemoteCodeSessions");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readKvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const data: Record<string, string> = {};
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const idx = stripped.indexOf("=");
    const key = stripped.slice(0, idx).trim();
    const value = stripped.slice(idx + 1).trim();
    data[key] = value;
  }
  return data;
}

export function readEnvLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n");
}

export function writeEnvLines(filePath: string, lines: string[]): void {
  const content = lines.join("\n").trimEnd() + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
}

export function loadConfig(): string | null {
  const gp = globalConfigPath();
  const config = readKvFile(gp);
  for (const [key, value] of Object.entries(config)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  if (fs.existsSync(gp)) return gp;
  return null;
}

function parseAllowedUsers(raw: string): { ids: Set<number>; usernames: Set<string> } {
  const ids = new Set<number>();
  const usernames = new Set<string>();
  if (!raw.trim()) return { ids, usernames };
  const parts = raw.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      ids.add(parseInt(part, 10));
    } else {
      usernames.add(part.replace(/^@/, "").toLowerCase());
    }
  }
  return { ids, usernames };
}

export function getConfig(): Config {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("Missing required env var: TELEGRAM_BOT_TOKEN");
  }
  const allowedUsers = parseAllowedUsers(process.env.REMOTECODE_ALLOWED_USERS || "");
  if (allowedUsers.ids.size === 0 && allowedUsers.usernames.size === 0) {
    throw new Error("REMOTECODE_ALLOWED_USERS is empty or invalid. Set at least one user ID or username.");
  }
  const yolo = parseTruthyEnv(process.env.REMOTECODE_YOLO);
  const verbose = parseTruthyEnv(process.env.REMOTECODE_VERBOSE);

  return { botToken, allowedUsers, yolo, verbose };
}

/** Tool names whose tool_use messages are not forwarded to Telegram. */
export const SILENT_TOOLS = new Set([
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "TodoRead", "AskUserQuestion",
]);

/** Model choices shown in the /model inline keyboard. */
export const MODEL_CHOICES: Array<{ label: string; modelId: string }> = [
  { label: "Sonnet 4.5", modelId: "claude-sonnet-4-5-20250929" },
  { label: "Opus 4.6", modelId: "claude-opus-4-6" },
  { label: "Haiku 4.5", modelId: "claude-haiku-4-5-20251001" },
];
