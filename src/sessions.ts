import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import { readKvFile, readEnvLines, writeEnvLines } from "./config";

// Re-export UI functions for backward compatibility
export {
  formatTimeAgo,
  formatSessionLabel,
  readLastTurns,
  buildSessionGrid,
  buildSessionDisplay,
  sessionsReplyKeyboard,
} from "./session-ui";
export type { InlineButton } from "./session-ui";

// ---------- types ----------
export interface SessionInfo {
  sessionId: string;
  slug: string | null;
  project: string;
  projectName: string;
  lastModified: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export interface ProjectInfo {
  encodedDir: string;
  projectName: string;
  sessionCount: number;
  lastModified: number;
}

// ---------- project path helpers ----------
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeProjectPath(encodedDir: string): string {
  // Claude Code encodes: / -> -, and strips leading . from hidden dirs
  // So /path/.hidden/foo -> -path--hidden-foo (-- means /.)
  return "/" + encodedDir.replace(/^-/, "").replace(/--/g, "/.").replace(/-/g, "/");
}

function projectDisplayName(encodedDir: string): string {
  const decoded = decodeProjectPath(encodedDir);
  const home = os.homedir();
  if (decoded.replace(/\/$/, "") === home.replace(/\/$/, "")) return "~/";
  return decoded.replace(/\/$/, "").split("/").pop() || decoded;
}

// ---------- JSONL parsing ----------
export function extractMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
}

function cleanFirstMessage(text: string): string | null {
  let msg = text;
  if (msg.startsWith("User said:\n")) msg = msg.slice("User said:\n".length);
  msg = msg.replace(/\n+Reply concisely\.?\s*$/, "");
  msg = msg.replace(/\n+Image file path\(s\):.*/s, "");
  msg = msg.trim();
  if (!msg || msg.startsWith("<") || msg.startsWith("#")) return null;
  const firstLine = msg.split("\n", 1)[0].trim();
  if (!firstLine) return null;
  if (firstLine.length > 60) return firstLine.slice(0, 57) + "...";
  return firstLine;
}

interface ParsedSession {
  slug: string | null;
  firstMessage: string | null;
  lastMessage: string | null;
}

function parseSessionFile(filePath: string): ParsedSession | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    let slug: string | null = null;
    let firstMessage: string | null = null;
    let lastMessage: string | null = null;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!slug && entry.slug) slug = entry.slug as string;
      if (entry.type === "user" && !entry.isMeta) {
        const msgObj = entry.message as Record<string, unknown> | undefined;
        const msgContent = extractMessageContent(msgObj?.content);
        if (msgContent.trim() && !msgContent.startsWith("<")) {
          const cleaned = cleanFirstMessage(msgContent.trim());
          if (!firstMessage) firstMessage = cleaned;
          lastMessage = cleaned;
        }
      }
    }
    return { slug, firstMessage, lastMessage };
  } catch {
    return null;
  }
}

// ---------- active session state (KV file) ----------
export function loadActiveSessionId(sessionsFile: string): string | null {
  return readKvFile(sessionsFile).REMOTECODE_SESSION_CLAUDE || null;
}

export function saveActiveSessionId(sessionsFile: string, sessionId: string | null): void {
  let lines = readEnvLines(sessionsFile);
  lines = lines.filter((l) => !l.trim().startsWith("REMOTECODE_SESSION_CLAUDE="));
  if (sessionId) lines.push(`REMOTECODE_SESSION_CLAUDE=${sessionId}`);
  writeEnvLines(sessionsFile, lines);
}

export function getOrCreateSessionId(sessionsFile: string): string {
  const existing = loadActiveSessionId(sessionsFile);
  if (existing) return existing;
  const newId = uuidv4();
  saveActiveSessionId(sessionsFile, newId);
  return newId;
}

export function createNewSession(sessionsFile: string, cwd?: string): string {
  const newId = uuidv4();
  saveActiveSessionId(sessionsFile, newId);
  saveSessionCwd(sessionsFile, cwd || "");
  return newId;
}

export function loadSessionCwd(sessionsFile: string): string | null {
  return readKvFile(sessionsFile).REMOTECODE_SESSION_CLAUDE_CWD || null;
}

export function saveSessionCwd(sessionsFile: string, cwd: string): void {
  let lines = readEnvLines(sessionsFile);
  lines = lines.filter((l) => !l.trim().startsWith("REMOTECODE_SESSION_CLAUDE_CWD="));
  if (cwd) lines.push(`REMOTECODE_SESSION_CLAUDE_CWD=${cwd}`);
  writeEnvLines(sessionsFile, lines);
}

// ---------- session file candidates ----------
function projectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function findSessionFilePath(sessionId: string): string | null {
  const pDir = projectsDir();
  if (!fs.existsSync(pDir)) return null;
  try {
    for (const dir of fs.readdirSync(pDir)) {
      const dirPath = path.join(pDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      const candidate = path.join(dirPath, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return null;
}

function listSessionCandidates(dirPath: string): Array<{ mtime: number; filePath: string }> {
  const candidates: Array<{ mtime: number; filePath: string }> = [];
  try {
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith(".jsonl")) continue;
      if (!UUID_RE.test(file.slice(0, -6))) continue;
      const filePath = path.join(dirPath, file);
      candidates.push({ mtime: fs.statSync(filePath).mtimeMs / 1000, filePath });
    }
  } catch { /* ignore */ }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates;
}

function candidateToSessionInfo(
  mtime: number,
  filePath: string,
  encodedDir: string
): SessionInfo | null {
  const parsed = parseSessionFile(filePath);
  if (!parsed) return null;
  return {
    sessionId: path.basename(filePath, ".jsonl"),
    slug: parsed.slug,
    project: decodeProjectPath(encodedDir),
    projectName: projectDisplayName(encodedDir),
    lastModified: mtime,
    firstMessage: parsed.firstMessage,
    lastMessage: parsed.lastMessage,
  };
}

// ---------- discovery ----------
export function discoverSessions(limit: number = 10): SessionInfo[] {
  const pDir = projectsDir();
  if (!fs.existsSync(pDir)) return [];

  const all: Array<{ mtime: number; filePath: string; encodedDir: string }> = [];
  try {
    for (const dir of fs.readdirSync(pDir)) {
      const dirPath = path.join(pDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      for (const c of listSessionCandidates(dirPath)) {
        all.push({ ...c, encodedDir: dir });
      }
    }
  } catch { return []; }

  all.sort((a, b) => b.mtime - a.mtime);

  const results: SessionInfo[] = [];
  for (const { mtime, filePath, encodedDir } of all.slice(0, limit)) {
    const info = candidateToSessionInfo(mtime, filePath, encodedDir);
    if (info) results.push(info);
  }
  return results;
}

export function discoverProjectSessions(encodedDir: string, limit: number = 20): SessionInfo[] {
  const dirPath = path.join(projectsDir(), encodedDir);
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];

  const candidates = listSessionCandidates(dirPath);
  const results: SessionInfo[] = [];
  for (const { mtime, filePath } of candidates.slice(0, limit)) {
    const info = candidateToSessionInfo(mtime, filePath, encodedDir);
    if (info) results.push(info);
  }
  return results;
}

export function discoverProjects(): ProjectInfo[] {
  const pDir = projectsDir();
  if (!fs.existsSync(pDir)) return [];

  const results: ProjectInfo[] = [];
  try {
    for (const dir of fs.readdirSync(pDir)) {
      const dirPath = path.join(pDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      if (dir === "memory") continue;
      const sessions = discoverProjectSessions(dir, 50);
      if (sessions.length === 0) continue;
      results.push({
        encodedDir: dir,
        projectName: projectDisplayName(dir),
        sessionCount: sessions.length,
        lastModified: sessions[0].lastModified,
      });
    }
  } catch { return []; }

  results.sort((a, b) => b.lastModified - a.lastModified);
  return results;
}

// ---------- find / delete ----------
export function findSession(query: string): SessionInfo | null {
  const sessions = discoverSessions(50);
  if (sessions.length === 0) return null;
  const q = query.toLowerCase();
  for (const s of sessions) if (s.slug === query) return s;
  for (const s of sessions) if (s.slug?.toLowerCase() === q) return s;
  for (const s of sessions) if (s.sessionId === query) return s;
  for (const s of sessions) if (s.sessionId.startsWith(query)) return s;
  return null;
}

export function deleteSession(sessionId: string): boolean {
  const pDir = projectsDir();
  if (!fs.existsSync(pDir)) return false;
  try {
    for (const dir of fs.readdirSync(pDir)) {
      const dirPath = path.join(pDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      const sessionFile = path.join(dirPath, `${sessionId}.jsonl`);
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
        return true;
      }
    }
  } catch { return false; }
  return false;
}
