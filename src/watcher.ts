import * as fs from "fs";
import { TelegramConfig, sendMessage, editMessageText, deleteMessage } from "./telegram";
import { tryMdToHtml, truncateMessage, formatToolDescription } from "./format";
import { UUID_RE, findSessionFilePath } from "./sessions";
import { extractMessageContent, parseJsonlLines } from "./jsonl";
import { readKvFile, readEnvLines, writeEnvLines } from "./config";
import { activeQueries } from "./context";
import { markSessionStale } from "./claude";
import { logger, errorMessage, silentTry, silentCatch } from "./logger";

export function isAutoSyncEnabled(sessionsFile: string): boolean {
  const val = readKvFile(sessionsFile).REMOTECODE_AUTO_SYNC;
  return val !== "off";
}

export function setAutoSync(sessionsFile: string, enabled: boolean): void {
  let lines = readEnvLines(sessionsFile);
  lines = lines.filter((l) => !l.trim().startsWith("REMOTECODE_AUTO_SYNC="));
  lines.push(`REMOTECODE_AUTO_SYNC=${enabled ? "on" : "off"}`);
  writeEnvLines(sessionsFile, lines);
}

interface WatcherState {
  currentSessionId: string | null;
  currentWatcher: fs.FSWatcher | null;
  currentFilePath: string | null;
  lastByteOffset: number;
  lineBuf: string;
  pollTimer: ReturnType<typeof setInterval> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  sessionsFile: string | null;
  // Permission tracking for host-side tool_use blocks
  pendingToolUses: Map<string, { toolName: string; input: Record<string, unknown> }>;
  permCheckTimer: ReturnType<typeof setTimeout> | null;
  permNotifyMsgId: number | null;
  telegram: TelegramConfig | null;
  lastChatId: number | null;
}

const state: WatcherState = {
  currentSessionId: null,
  currentWatcher: null,
  currentFilePath: null,
  lastByteOffset: 0,
  lineBuf: "",
  pollTimer: null,
  debounceTimer: null,
  sessionsFile: null,
  pendingToolUses: new Map(),
  permCheckTimer: null,
  permNotifyMsgId: null,
  telegram: null,
  lastChatId: null,
};

function processNewData(telegram: TelegramConfig, chatId: number): void {
  const { currentFilePath, currentSessionId } = state;
  if (!currentFilePath || !currentSessionId) return;

  // Store telegram/chatId for dismiss operations from other call sites
  state.telegram = telegram;
  state.lastChatId = chatId;

  let fileSize: number;
  try {
    fileSize = fs.statSync(currentFilePath).size;
  } catch {
    return;
  }

  if (fileSize <= state.lastByteOffset) return;

  let chunk: string;
  try {
    const buf = Buffer.alloc(fileSize - state.lastByteOffset);
    const fd = fs.openSync(currentFilePath, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, state.lastByteOffset);
    } finally {
      fs.closeSync(fd);
    }
    chunk = buf.toString("utf-8");
  } catch {
    return;
  }

  state.lastByteOffset = fileSize;

  const raw = state.lineBuf + chunk;
  const lines = raw.split("\n");
  // Keep the last incomplete line in the buffer
  state.lineBuf = lines.pop() || "";

  if (activeQueries.has(currentSessionId)) {
    dismissPermNotification();
    return;
  }

  // External changes detected — mark persistent session stale so it
  // recreates on next message (picks up CLI/other-source context)
  markSessionStale(currentSessionId);

  const entries = [...parseJsonlLines(lines.join("\n"), "watcher")];

  // --- Pass 1: Track tool_use / tool_result (runs regardless of autoSync) ---
  for (const entry of entries) {
    const type = entry.type as string;
    if (type !== "assistant" && type !== "user") continue;

    const msgObj = entry.message as Record<string, unknown> | undefined;
    const content = msgObj?.content;

    // Track tool_result → clear matching pending tools
    if (type === "user" && Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          state.pendingToolUses.delete(b.tool_use_id);
        }
      }
    }

    // Track tool_use → add to pending
    if (type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && typeof b.id === "string") {
          state.pendingToolUses.set(b.id, {
            toolName: (b.name as string) || "Unknown",
            input: (b.input as Record<string, unknown>) || {},
          });
        }
      }
    }
  }

  // Schedule or dismiss based on pending tools state
  if (state.pendingToolUses.size > 0) {
    schedulePermCheck();
  } else {
    dismissPermNotification();
  }

  // --- Pass 2: Display text messages (only when autoSync enabled) ---
  if (!isAutoSyncEnabled(state.sessionsFile!)) return;

  for (const entry of entries) {
    const type = entry.type as string;
    if (type !== "assistant" && type !== "user") continue;
    if (type === "user" && entry.isMeta) continue;

    const msgObj = entry.message as Record<string, unknown> | undefined;
    const content = msgObj?.content;

    // Skip tool_result messages (auto-generated by SDK, not real user input)
    if (type === "user") {
      if (entry.toolUseResult) continue;
      if (Array.isArray(content) && content.length > 0 &&
          (content[0] as Record<string, unknown>)?.type === "tool_result") continue;
    }

    // Skip assistant messages that contain tool_use blocks (tool preamble noise + permission-like text)
    if (type === "assistant" && Array.isArray(content)) {
      const hasToolUse = content.some((b: unknown) =>
        b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_use");
      if (hasToolUse) continue;
    }

    const text = extractMessageContent(content).trim();
    if (!text) continue;

    const cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();
    if (!cleaned) continue;

    const label = type === "user" ? "[sync] You:" : "[sync] Bot:";
    const truncated = truncateMessage(cleaned, 3200);
    const formatted = tryMdToHtml(truncated);
    const body = `<blockquote>${label}</blockquote>\n\n${formatted.text}`;
    sendMessage(telegram, chatId, body, {
      parseMode: "HTML",
    }).catch((err) => {
      logger.error("watcher", `sendMessage error: ${errorMessage(err)}`);
    });
  }
}

// ---------- permission notification helpers ----------
const PERM_CHECK_DELAY_MS = 8_000;

function clearPermState(): void {
  state.pendingToolUses.clear();
  if (state.permCheckTimer) {
    clearTimeout(state.permCheckTimer);
    state.permCheckTimer = null;
  }
  state.permNotifyMsgId = null;
}

function schedulePermCheck(): void {
  if (state.permCheckTimer) return; // already scheduled
  state.permCheckTimer = setTimeout(() => {
    state.permCheckTimer = null;
    checkPendingPerms();
  }, PERM_CHECK_DELAY_MS);
}

function checkPendingPerms(): void {
  if (state.pendingToolUses.size === 0) return;
  if (!state.currentSessionId) return;
  if (activeQueries.has(state.currentSessionId)) return;
  if (state.permNotifyMsgId) return; // already notified

  const telegram = state.telegram;
  const chatId = state.lastChatId;
  if (!telegram || !chatId) return;

  const [, first] = [...state.pendingToolUses.entries()][0];
  const desc = formatToolDescription(first.toolName, first.input);
  const count = state.pendingToolUses.size;
  const countLabel = count > 1 ? `\n+${count - 1} more pending tool(s)` : "";
  const text = `<b>[sync] Permission pending on host</b>\n${desc}${countLabel}`;
  const sessionId = state.currentSessionId;
  const buttons = [
    [{ text: "📱 Take over session", callback_data: `takeover:${sessionId}` }],
    [{ text: "✖ Dismiss", callback_data: "takeover:dismiss" }],
  ];

  sendMessage(telegram, chatId, text, {
    parseMode: "HTML",
    replyMarkup: { inline_keyboard: buttons },
  }).then((msgId) => {
    state.permNotifyMsgId = msgId;
  }).catch((err) => {
    logger.error("watcher", `sendPermNotification error: ${errorMessage(err)}`);
  });
}

function dismissPermNotification(): void {
  if (state.permNotifyMsgId && state.telegram && state.lastChatId) {
    silentCatch("watcher", "dismissPermNotification",
      editMessageText(state.telegram, state.lastChatId, state.permNotifyMsgId, "✓ Resolved by host"));
  }
  clearPermState();
}

/** Get a snapshot of pending tool uses (for takeover display). */
export function getPendingToolUses(): Array<{ toolName: string; input: Record<string, unknown> }> {
  return [...state.pendingToolUses.values()];
}

/** Clear watcher permission state from outside (e.g. takeover callback). */
export function clearWatcherPermState(): void {
  if (state.permNotifyMsgId && state.telegram && state.lastChatId) {
    silentCatch("watcher", "clearWatcherPermState",
      deleteMessage(state.telegram, state.lastChatId, state.permNotifyMsgId));
  }
  clearPermState();
}

function startWatching(telegram: TelegramConfig, chatId: number, sessionId: string): void {
  // Stop existing watcher
  if (state.currentWatcher) {
    state.currentWatcher.close();
    state.currentWatcher = null;
  }
  clearPermState(); // Reset permission tracking on session switch

  const filePath = findSessionFilePath(sessionId);
  state.currentSessionId = sessionId;
  state.currentFilePath = filePath;
  state.lineBuf = "";

  if (!filePath) {
    // File doesn't exist yet -- set offset to 0, will be picked up once created
    state.lastByteOffset = 0;
    logger.warn("watcher", `session ${sessionId.slice(0, 8)} file not found yet`);
    return;
  }

  // Start from end of file (only new content)
  try {
    state.lastByteOffset = fs.statSync(filePath).size;
  } catch {
    state.lastByteOffset = 0;
  }

  try {
    state.currentWatcher = fs.watch(filePath, () => {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => processNewData(telegram, chatId), 500);
    });
    state.currentWatcher.on("error", () => {
      // File may have been deleted/moved; will re-attach on next poll
      state.currentWatcher?.close();
      state.currentWatcher = null;
    });
    logger.debug("watcher", `watching ${sessionId.slice(0, 8)}`);
  } catch {
    logger.warn("watcher", `failed to watch ${filePath}`);
  }
}

function getChatId(sessionsFile: string): number | null {
  const raw = readKvFile(sessionsFile).REMOTECODE_CHAT_ID;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

export function startWatcher(telegram: TelegramConfig, sessionsFile: string): void {
  logger.info("watcher", "starting");
  state.sessionsFile = sessionsFile;

  // Initial check
  const kv = readKvFile(sessionsFile);
  const chatId = getChatId(sessionsFile);
  const sessionId = kv.REMOTECODE_SESSION_CLAUDE || null;
  if (sessionId && UUID_RE.test(sessionId) && chatId) {
    startWatching(telegram, chatId, sessionId);
  }

  // Poll for session changes every 3 seconds
  state.pollTimer = setInterval(() => {
    const kv = readKvFile(sessionsFile);
    const newSessionId = kv.REMOTECODE_SESSION_CLAUDE || null;
    const newChatId = getChatId(sessionsFile);

    if (!newChatId || !newSessionId || !UUID_RE.test(newSessionId)) return;

    if (newSessionId !== state.currentSessionId) {
      logger.info("watcher", `session changed: ${state.currentSessionId?.slice(0, 8) || "none"} -> ${newSessionId.slice(0, 8)}`);
      startWatching(telegram, newChatId, newSessionId);
      return;
    }

    // If file didn't exist before, check again
    if (!state.currentFilePath || !state.currentWatcher) {
      const filePath = findSessionFilePath(newSessionId);
      if (filePath) {
        startWatching(telegram, newChatId, newSessionId);
      }
    }
  }, 3000);
}

/** Advance watcher offset to end-of-file and cancel pending debounce so SDK data won't be re-sent */
export function skipToEnd(): void {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  if (state.currentFilePath) {
    silentTry("watcher", "skipToEnd stat", () => {
      state.lastByteOffset = fs.statSync(state.currentFilePath!).size;
      state.lineBuf = "";
    });
  }
}

export function stopWatcher(): void {
  if (state.currentWatcher) {
    state.currentWatcher.close();
    state.currentWatcher = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  logger.info("watcher", "stopped");
}
