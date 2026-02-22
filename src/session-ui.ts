import * as fs from "fs";
import { readKvFile } from "./config";
import { mdToTelegramHtml, escapeHtml } from "./format";
import { SessionInfo, findSessionFilePath } from "./sessions";
import { parseJsonlLines, extractMessageContent, cleanUserMessage } from "./jsonl";

// ---------- formatting helpers ----------
export function formatTimeAgo(mtime: number): string {
  const diff = Date.now() / 1000 - mtime;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatSessionLabel(session: SessionInfo): string {
  const project = session.projectName || "unknown";
  const preview = session.firstMessage;
  if (preview) {
    const truncated = preview.length > 40 ? preview.slice(0, 37) + "..." : preview;
    return `${project} - ${truncated}`;
  }
  if (session.slug) return `${project} (${session.slug})`;
  return project;
}

// ---------- history rendering ----------
function safePage(body: string, maxLen: number): string {
  const open = "<blockquote>";
  const close = "</blockquote>";
  const full = open + body + close;
  if (full.length <= maxLen) return full;
  const trimTo = maxLen - open.length - close.length - 15;
  return open + body.slice(0, trimTo) + "\n...[truncated]" + close;
}

export function readLastTurns(sessionId: string, maxTurns: number = 4): string[] {
  const filePath = findSessionFilePath(sessionId);
  if (!filePath) return [];

  const turns: Array<{ role: string; text: string }> = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const entry of parseJsonlLines(content, "session-ui")) {
      if (entry.type === "user" && !entry.isMeta) {
        const msgObj = entry.message as Record<string, unknown> | undefined;
        const text = extractMessageContent(msgObj?.content).trim();
        if (text && !text.startsWith("<")) {
          const cleaned = cleanUserMessage(text);
          if (cleaned) {
            const last = turns.length > 0 ? turns[turns.length - 1] : null;
            if (last && last.role === "user") {
              last.text += "\n" + cleaned;
            } else {
              turns.push({ role: "user", text: cleaned });
            }
          }
        }
      } else if (entry.type === "assistant") {
        const msgObj = entry.message as Record<string, unknown> | undefined;
        const text = extractMessageContent(msgObj?.content).trim();
        if (text) {
          const last = turns.length > 0 ? turns[turns.length - 1] : null;
          if (last && last.role === "assistant") {
            last.text += "\n" + text;
          } else {
            turns.push({ role: "assistant", text });
          }
        }
      }
    }
  } catch { return []; }

  const recent = turns.slice(-maxTurns);
  if (recent.length === 0) return [];

  const maxLen = 3900;
  const separator = "\n\n";

  const formatted: string[] = [];
  const turnLimit = 3000;
  for (const t of recent) {
    const label = t.role === "user" ? "You" : "Bot";
    const trimmed = t.text.length > turnLimit ? t.text.slice(0, turnLimit) + "\n...[truncated]" : t.text;
    let html = mdToTelegramHtml(trimmed);
    // Strip tags that cannot nest inside <blockquote>
    html = html.replace(/<\/?(?:blockquote|pre)>/g, "");
    formatted.push(`<b><code>${label}:</code></b>\n${html}`);
  }

  const messages: string[] = [];
  let current: string[] = [];
  let currentLen = "<blockquote></blockquote>".length;

  for (const entry of formatted) {
    const entryLen = entry.length + (current.length > 0 ? separator.length : 0);
    if (current.length > 0 && currentLen + entryLen > maxLen) {
      messages.push(safePage(current.join(separator), maxLen));
      current = [];
      currentLen = "<blockquote></blockquote>".length;
    }
    current.push(entry);
    currentLen += entry.length + (current.length > 1 ? separator.length : 0);
  }
  if (current.length > 0) {
    messages.push(safePage(current.join(separator), maxLen));
  }

  return messages;
}

// ---------- session grid builder ----------
export type InlineButton = { text: string; callback_data: string };

export function buildSessionGrid(
  sessions: SessionInfo[],
  activeId: string | null,
  opts?: { showDir?: boolean }
): Array<Array<InlineButton>> {
  const buttons: Array<Array<InlineButton>> = [];
  const showDir = opts?.showDir ?? true;

  for (const s of sessions) {
    const isActive = s.sessionId === activeId;
    const timeAgo = formatTimeAgo(s.lastModified);
    const preview = s.lastMessage || s.firstMessage || s.slug || "new session";

    const parts: string[] = [];
    if (isActive) parts.push("[v]");
    if (showDir) parts.push(`${s.projectName}:`);
    parts.push(`${timeAgo} - ${preview}`);

    let label = parts.join(" ");
    const maxLen = 40;
    if (label.length > maxLen) label = label.slice(0, maxLen - 2) + "..";

    buttons.push([{ text: label, callback_data: `sess:${s.sessionId}` }]);
  }

  return buttons;
}

// Non-breaking space for indentation
const I = "\u00a0\u00a0\u00a0";

function buildSessionBlock(
  s: SessionInfo,
  num: number,
  isActive: boolean,
): string {
  const timeAgo = formatTimeAgo(s.lastModified);
  const prefix = s.sessionId.slice(0, 8);
  const maxPreview = 100;

  const preview = s.lastMessage || s.firstMessage || s.slug || "";
  const trimmed = preview.length > maxPreview
    ? preview.slice(0, maxPreview - 3) + "..."
    : preview;

  const header = isActive
    ? `\u2022 <b><u>${escapeHtml(s.projectName)}  [current]</u></b>`
    : `\u2022 <b>${escapeHtml(s.projectName)}</b>`;

  const lines = [header];
  if (trimmed) lines.push(`${I}${escapeHtml(trimmed)}`);
  lines.push(`${I}<code>${timeAgo}</code>`);

  const info = lines.join("\n");

  if (isActive) return info + "\n" + `<blockquote>current session</blockquote>`;

  return info + "\n" + `<blockquote>/switch_to_${prefix}</blockquote>`;
}

export function buildSessionDisplay(
  sessions: SessionInfo[],
  activeId: string | null,
): { text: string; buttons: Array<Array<InlineButton>> } {
  const buttons: Array<Array<InlineButton>> = [
    [{ text: "+ New session", callback_data: "sess:new" }],
  ];

  if (sessions.length === 0) {
    return { text: "No sessions found.", buttons };
  }

  const blocks: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    blocks.push(buildSessionBlock(sessions[i], i + 1, sessions[i].sessionId === activeId));
  }

  return { text: blocks.join("\n\n"), buttons };
}

export function buildProjectSessionDisplay(
  sessions: SessionInfo[],
  activeId: string | null,
  projectName: string,
  encodedDir: string,
): { text: string; buttons: Array<Array<InlineButton>> } {
  const buttons: Array<Array<InlineButton>> = [
    [{ text: "+ New session", callback_data: `proj:new:${encodedDir}` }],
  ];

  if (sessions.length === 0) {
    return { text: `${escapeHtml(projectName)}: no sessions.`, buttons };
  }

  const blocks: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    blocks.push(buildSessionBlock(sessions[i], i + 1, sessions[i].sessionId === activeId));
  }

  return { text: blocks.join("\n\n"), buttons };
}

export function sessionsReplyKeyboard(sessionsFile?: string): Record<string, unknown> {
  let syncLabel = "/sync";
  if (sessionsFile) {
    const val = readKvFile(sessionsFile).REMOTECODE_AUTO_SYNC;
    syncLabel = val === "off" ? "/sync (off)" : "/sync (on)";
  }
  return {
    keyboard: [[{ text: syncLabel }, { text: "/sessions" }, { text: "/projects" }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}
