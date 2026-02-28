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
  "TodoRead", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
]);

// ---------- skill discovery ----------

export interface SkillInfo {
  name: string;
  description: string;
  skillMdPath: string;
}

/** Parse YAML-ish frontmatter from a SKILL.md file to extract name and description. */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*"?([^"]*)"?\s*$/);
    if (m) result[m[1]] = m[2];
  }
  return { name: result.name, description: result.description };
}

/** Discover all available Claude Code skills from ~/.claude/skills/ and enabled plugins. */
export function discoverSkills(): SkillInfo[] {
  const claudeDir = path.join(os.homedir(), ".claude");
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  // 1) ~/.claude/skills/*/SKILL.md
  const skillsDir = path.join(claudeDir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mdPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(mdPath)) continue;
      try {
        const fm = parseSkillFrontmatter(fs.readFileSync(mdPath, "utf-8"));
        const name = fm.name || entry.name;
        if (seen.has(name)) continue;
        seen.add(name);
        skills.push({ name, description: fm.description || "", skillMdPath: mdPath });
      } catch { /* skip unreadable */ }
    }
  }

  // 2) Enabled plugins — find latest version's skills
  const settingsPath = path.join(claudeDir, "settings.json");
  const installedPath = path.join(claudeDir, "plugins", "installed_plugins.json");
  if (fs.existsSync(settingsPath) && fs.existsSync(installedPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const installed = JSON.parse(fs.readFileSync(installedPath, "utf-8"));
      const enabled = settings.enabledPlugins || {};
      for (const pluginKey of Object.keys(enabled)) {
        if (!enabled[pluginKey]) continue;
        const entries = installed.plugins?.[pluginKey];
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const latest = entries[0];
        const pluginSkillsDir = path.join(latest.installPath, "skills");
        if (!fs.existsSync(pluginSkillsDir)) continue;
        for (const sEntry of fs.readdirSync(pluginSkillsDir, { withFileTypes: true })) {
          if (!sEntry.isDirectory()) continue;
          const mdPath = path.join(pluginSkillsDir, sEntry.name, "SKILL.md");
          if (!fs.existsSync(mdPath)) continue;
          try {
            const fm = parseSkillFrontmatter(fs.readFileSync(mdPath, "utf-8"));
            const name = fm.name || sEntry.name;
            if (seen.has(name)) continue;
            seen.add(name);
            skills.push({ name, description: fm.description || "", skillMdPath: mdPath });
          } catch { /* skip */ }
        }
      }
    } catch { /* skip parse errors */ }
  }

  return skills;
}

/** Model choices shown in the /model inline keyboard. */
export const MODEL_CHOICES: Array<{ label: string; modelId: string }> = [
  { label: "Sonnet 4.5", modelId: "claude-sonnet-4-5-20250929" },
  { label: "Opus 4.6", modelId: "claude-opus-4-6" },
  { label: "Haiku 4.5", modelId: "claude-haiku-4-5-20251001" },
];
