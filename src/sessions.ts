import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import { readKvFile, readEnvLines, writeEnvLines } from "./config";
import { logger, errorMessage } from "./logger";
import { parseJsonlLines, extractMessageContent, cleanFirstMessage } from "./jsonl";

// Re-export jsonl utilities for backward compatibility
export { extractMessageContent } from "./jsonl";

// Re-export UI functions for backward compatibility
export {
  formatTimeAgo,
  formatSessionLabel,
  readLastTurns,
  buildSessionGrid,
  buildSessionDisplay,
  buildProjectSessionDisplay,
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
  // Claude Code encodes: / -> -, _ -> -, leading . stripped (-- means /.)
  // Since both / and _ map to -, we resolve ambiguity by checking the filesystem.

  // Split on -- first (hidden dir boundary: /. ), then split each part on -
  const raw = encodedDir.replace(/^-/, "");
  const hiddenParts = raw.split("--");
  const segments: string[] = [];

  for (let h = 0; h < hiddenParts.length; h++) {
    const segs = hiddenParts[h].split("-").filter(Boolean);
    if (h > 0 && segs.length > 0) {
      // -- means /. so prepend . to the first segment after --
      segs[0] = "." + segs[0];
    }
    segments.push(...segs);
  }

  return resolvePathSegments("/", segments);
}

function resolvePathSegments(base: string, segments: string[]): string {
  if (segments.length === 0) return base;

  // Try greedily joining segments with _ and check filesystem
  for (let take = segments.length; take >= 1; take--) {
    const candidate = segments.slice(0, take).join("_");
    const full = path.join(base, candidate);
    if (fs.existsSync(full)) {
      if (take === segments.length) return full;
      return resolvePathSegments(full, segments.slice(take));
    }
  }

  // Fallback: treat first segment as a directory (original / encoding)
  const first = segments[0];
  const rest = segments.slice(1);
  const fallback = path.join(base, first);
  if (rest.length === 0) return fallback;
  return resolvePathSegments(fallback, rest);
}

function projectDisplayName(encodedDir: string): string {
  const decoded = decodeProjectPath(encodedDir);
  const home = os.homedir();
  if (decoded.replace(/\/$/, "") === home.replace(/\/$/, "")) return "~/";
  return decoded.replace(/\/$/, "").split("/").pop() || decoded;
}

// ---------- JSONL parsing ----------

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

    for (const entry of parseJsonlLines(content, "sessions")) {
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
  } catch (err) { logger.debug("sessions", `findSessionFilePath scan: ${errorMessage(err)}`); }
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
  } catch (err) { logger.debug("sessions", `listSessionCandidates: ${errorMessage(err)}`); }
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

// ---------- find encoded dir from cwd ----------
export function findEncodedDir(cwd: string): string | null {
  if (!cwd) return null;
  const pDir = projectsDir();
  if (!fs.existsSync(pDir)) return null;
  try {
    for (const dir of fs.readdirSync(pDir)) {
      const dirPath = path.join(pDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      if (dir === "memory") continue;
      if (decodeProjectPath(dir) === cwd) return dir;
    }
  } catch { /* ignore */ }
  return null;
}

// ---------- model preference ----------
export function loadModel(sessionsFile: string): string | undefined {
  return readKvFile(sessionsFile).REMOTECODE_MODEL || undefined;
}

export function saveModel(sessionsFile: string, model: string): void {
  let lines = readEnvLines(sessionsFile);
  lines = lines.filter((l) => !l.trim().startsWith("REMOTECODE_MODEL="));
  lines.push(`REMOTECODE_MODEL=${model}`);
  writeEnvLines(sessionsFile, lines);
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

  // Fallback: scan filesystem directly for prefix match (handles old sessions beyond limit)
  if (query.length >= 8) {
    const pDir = projectsDir();
    if (!fs.existsSync(pDir)) return null;
    try {
      for (const dir of fs.readdirSync(pDir)) {
        const dirPath = path.join(pDir, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith(".jsonl")) continue;
          const name = file.slice(0, -6);
          if (!UUID_RE.test(name)) continue;
          if (name === query || name.startsWith(query)) {
            const filePath = path.join(dirPath, file);
            const mtime = fs.statSync(filePath).mtimeMs / 1000;
            const info = candidateToSessionInfo(mtime, filePath, dir);
            if (info) return info;
          }
        }
      }
    } catch { /* ignore */ }
  }

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
