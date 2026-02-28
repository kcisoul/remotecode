import * as fs from "fs";
import { TelegramConfig, sendMessage, editMessageText, deleteMessage } from "./telegram";
import { tryMdToHtml, truncateMessage, formatToolDescription, escapeHtml } from "./format";
import * as os from "os";
import { UUID_RE, findSessionFilePath, listRecentSessionFiles, decodeProjectPath, loadActiveSessionId } from "./sessions";
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
  permNotifyText: string | null;
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
  permNotifyText: null,
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
  state.permNotifyText = null;
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
  const text = `<b>[sync] Permission pending on host</b>\n\n${desc}${countLabel}`;
  const sessionId = state.currentSessionId;
  const buttons = [
    [{ text: "📱 Continue in Telegram", callback_data: `takeover:${sessionId}` }],
    [{ text: "✖ Dismiss", callback_data: "takeover:dismiss" }],
  ];

  sendMessage(telegram, chatId, text, {
    parseMode: "HTML",
    replyMarkup: { inline_keyboard: buttons },
  }).then((msgId) => {
    state.permNotifyMsgId = msgId;
    state.permNotifyText = text;
  }).catch((err) => {
    logger.error("watcher", `sendPermNotification error: ${errorMessage(err)}`);
  });
}

function dismissPermNotification(): void {
  if (state.permNotifyMsgId && state.telegram && state.lastChatId) {
    const resolvedText = state.permNotifyText
      ? `${state.permNotifyText}\n\n✓ Resolved in Claude Code on host`
      : "✓ Resolved in Claude Code on host";
    silentCatch("watcher", "dismissPermNotification",
      editMessageText(state.telegram, state.lastChatId, state.permNotifyMsgId, resolvedText, { parseMode: "HTML" }));
  }
  clearPermState();
}

/** Get a snapshot of pending tool uses (for takeover display). */
export function getPendingToolUses(): Array<{ toolName: string; input: Record<string, unknown> }> {
  return [...state.pendingToolUses.values()];
}

/** Dismiss watcher permission notification with status text (keeps original content). */
export function dismissWatcherAsUser(): void {
  if (state.permNotifyMsgId && state.telegram && state.lastChatId) {
    const text = state.permNotifyText
      ? `${state.permNotifyText}\n\n✖ Dismissed`
      : "✖ Dismissed";
    silentCatch("watcher", "dismissWatcherAsUser",
      editMessageText(state.telegram, state.lastChatId, state.permNotifyMsgId, text, { parseMode: "HTML" }));
  }
  clearPermState();
}

/** Mark watcher notification as continuing in Telegram (keeps original content). */
export function continueWatcherInTelegram(): void {
  if (state.permNotifyMsgId && state.telegram && state.lastChatId) {
    const text = state.permNotifyText
      ? `${state.permNotifyText}\n\n✓ Continuing in Telegram`
      : "✓ Continuing in Telegram";
    silentCatch("watcher", "continueWatcherInTelegram",
      editMessageText(state.telegram, state.lastChatId, state.permNotifyMsgId, text, { parseMode: "HTML" }));
  }
  clearPermState();
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

// ===================================================================
// Global Session Scanner — detect pending permissions across all sessions
// ===================================================================

const SCANNER_INTERVAL_MS = 10_000;
const SCANNER_MAX_FILE_AGE_MS = 300_000;
const SCANNER_STALE_THRESHOLD_MS = 30_000;

interface PendingToolInfo {
  toolName: string;
  input: Record<string, unknown>;
}

interface ScannerNotification {
  msgId: number;
  text: string; // original message text (for appending resolved status)
}

interface ScannerState {
  timer: ReturnType<typeof setInterval> | null;
  telegram: TelegramConfig | null;
  chatId: number | null;
  sessionsFile: string | null;
  notified: Map<string, ScannerNotification>; // sessionId → notification
  suppressed: Set<string>; // sessionIds dismissed/continued — suppress until resolved
}

const scanner: ScannerState = {
  timer: null,
  telegram: null,
  chatId: null,
  sessionsFile: null,
  notified: new Map(),
  suppressed: new Set(),
};

interface ScanResult {
  pendingTools: PendingToolInfo[];
  lastUserInput: string | null;
}

function scanSessionTail(filePath: string): ScanResult {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch { return { pendingTools: [], lastUserInput: null }; }

  let chunk: string;
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const readSize = Math.min(size, 65536);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    chunk = buf.toString("utf-8");
  } catch {
    try { fs.closeSync(fd); } catch { /* */ }
    return { pendingTools: [], lastUserInput: null };
  }
  try { fs.closeSync(fd); } catch { /* */ }

  // Track tool_use / tool_result to find unresolved tool_use at end of file
  const pending = new Map<string, PendingToolInfo>();
  let lastUserInput: string | null = null;

  for (const entry of parseJsonlLines(chunk, "scanner")) {
    const type = entry.type as string;
    if (type !== "assistant" && type !== "user") continue;

    const msgObj = entry.message as Record<string, unknown> | undefined;
    const content = msgObj?.content;

    // Track last real user input (not tool_result, not meta)
    if (type === "user" && !entry.isMeta && !entry.toolUseResult) {
      if (Array.isArray(content) && content.length > 0 &&
          (content[0] as Record<string, unknown>)?.type === "tool_result") {
        // tool_result — skip for user input but still process for pending tracking
      } else {
        const text = extractMessageContent(content).trim();
        if (text && !text.startsWith("<")) lastUserInput = text;
      }
    }

    if (!Array.isArray(content)) continue;

    if (type === "user") {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          pending.delete(b.tool_use_id);
        }
      }
    }

    if (type === "assistant") {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && typeof b.id === "string") {
          pending.set(b.id, {
            toolName: (b.name as string) || "Unknown",
            input: (b.input as Record<string, unknown>) || {},
          });
        }
      }
    }
  }

  return { pendingTools: [...pending.values()], lastUserInput };
}

function runScannerTick(): void {
  if (!scanner.telegram || !scanner.chatId || !scanner.sessionsFile) return;

  const telegram = scanner.telegram;
  const chatId = scanner.chatId;
  const now = Date.now();

  const activeSessionId = loadActiveSessionId(scanner.sessionsFile);
  const recentFiles = listRecentSessionFiles(SCANNER_MAX_FILE_AGE_MS);

  const seenSessionIds = new Set<string>();

  for (const file of recentFiles) {
    seenSessionIds.add(file.sessionId);

    // Skip currently selected session (handled by watcher)
    if (file.sessionId === activeSessionId) continue;
    // Skip sessions with active SDK queries
    if (activeQueries.has(file.sessionId)) continue;
    // Skip if not old enough to be considered stale
    if (now - file.mtimeMs < SCANNER_STALE_THRESHOLD_MS) continue;
    // Skip if already notified
    if (scanner.notified.has(file.sessionId)) continue;
    // Skip if user dismissed/continued — wait until resolved before re-notifying
    if (scanner.suppressed.has(file.sessionId)) continue;

    const scan = scanSessionTail(file.filePath);
    if (scan.pendingTools.length === 0) continue;

    // Build notification with full project path + last input + pending tool
    const decoded = decodeProjectPath(file.encodedDir);
    const home = os.homedir();
    const displayPath = decoded.startsWith(home) ? "~" + decoded.slice(home.length) : decoded;
    const first = scan.pendingTools[0];
    const desc = formatToolDescription(first.toolName, first.input);
    const countLabel = scan.pendingTools.length > 1 ? `\n+${scan.pendingTools.length - 1} more pending tool(s)` : "";
    const inputLine = scan.lastUserInput
      ? `\n<b>You:</b>\n<blockquote>${escapeHtml(scan.lastUserInput.length > 200 ? scan.lastUserInput.slice(0, 200) + "…" : scan.lastUserInput)}</blockquote>\n`
      : "\n";
    const text = `<blockquote>Notification</blockquote>\nPermission pending in another session\nProject: <b>${escapeHtml(displayPath)}</b>\n${inputLine}\n<b>Pending:</b>\n${desc}${countLabel}`;
    const buttons = [
      [{ text: "📱 Continue in Telegram", callback_data: `takeover:${file.sessionId}` }],
    ];

    // Register immediately to prevent duplicate notifications on next tick
    scanner.notified.set(file.sessionId, { msgId: 0, text });

    sendMessage(telegram, chatId, text, {
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: buttons },
    }).then((msgId) => {
      const existing = scanner.notified.get(file.sessionId);
      if (existing) existing.msgId = msgId;
    }).catch((err) => {
      logger.error("scanner", `sendMessage error: ${errorMessage(err)}`);
      scanner.notified.delete(file.sessionId);
    });
  }

  // Check previously notified sessions — if resolved, append status to original message
  for (const [sessionId, notif] of [...scanner.notified.entries()]) {
    // Skip sessions we just notified this tick
    if (!seenSessionIds.has(sessionId)) {
      // Session file no longer recent — dismiss silently
      silentCatch("scanner", "deleteStaleNotification", deleteMessage(telegram, chatId, notif.msgId));
      scanner.notified.delete(sessionId);
      continue;
    }

    // Skip currently selected session (takeover already handles this)
    if (sessionId === activeSessionId) {
      scanner.notified.delete(sessionId);
      continue;
    }

    // Re-scan to check if still pending
    const file = recentFiles.find(f => f.sessionId === sessionId);
    if (!file) {
      scanner.notified.delete(sessionId);
      continue;
    }
    const scan = scanSessionTail(file.filePath);
    if (scan.pendingTools.length === 0) {
      const resolvedText = `${notif.text}\n\n✓ Resolved in Claude Code on host`;
      silentCatch("scanner", "editResolved",
        editMessageText(telegram, chatId, notif.msgId, resolvedText, { parseMode: "HTML" }));
      scanner.notified.delete(sessionId);
    }
  }

  // Clear suppressed sessions once their pending tools are resolved
  for (const sessionId of [...scanner.suppressed]) {
    const file = recentFiles.find(f => f.sessionId === sessionId);
    if (!file) {
      scanner.suppressed.delete(sessionId);
      continue;
    }
    const scan = scanSessionTail(file.filePath);
    if (scan.pendingTools.length === 0) {
      scanner.suppressed.delete(sessionId);
    }
  }
}

export function startGlobalScanner(telegram: TelegramConfig, sessionsFile: string): void {
  scanner.telegram = telegram;
  scanner.sessionsFile = sessionsFile;

  // Read chat ID from sessions file
  const chatIdRaw = readKvFile(sessionsFile).REMOTECODE_CHAT_ID;
  scanner.chatId = chatIdRaw ? parseInt(chatIdRaw, 10) || null : null;

  // Seed suppressed with already-pending sessions to avoid re-notifying on restart
  const recentFiles = listRecentSessionFiles(SCANNER_MAX_FILE_AGE_MS);
  for (const file of recentFiles) {
    const scan = scanSessionTail(file.filePath);
    if (scan.pendingTools.length > 0) {
      scanner.suppressed.add(file.sessionId);
    }
  }
  if (scanner.suppressed.size > 0) {
    logger.info("scanner", `seeded ${scanner.suppressed.size} suppressed session(s) on start`);
  }

  scanner.timer = setInterval(() => {
    // Refresh chatId each tick in case it changes
    const raw = readKvFile(scanner.sessionsFile!).REMOTECODE_CHAT_ID;
    scanner.chatId = raw ? parseInt(raw, 10) || null : null;

    runScannerTick();
  }, SCANNER_INTERVAL_MS);

  logger.info("scanner", "global session scanner started");
}

export function stopGlobalScanner(): void {
  if (scanner.timer) {
    clearInterval(scanner.timer);
    scanner.timer = null;
  }
  scanner.notified.clear();
  scanner.suppressed.clear();
  logger.info("scanner", "global session scanner stopped");
}

/** Remove scanner notification (used when taking over — notification replaced by takeover flow). */
export function dismissScannerNotification(sessionId: string): void {
  const notif = scanner.notified.get(sessionId);
  if (notif && scanner.telegram && scanner.chatId) {
    silentCatch("scanner", "dismissNotification",
      deleteMessage(scanner.telegram, scanner.chatId, notif.msgId));
  }
  scanner.notified.delete(sessionId);
}

/** Mark scanner notification as continuing in Telegram (keeps original content). */
export function continueScannerInTelegram(sessionId: string): void {
  const notif = scanner.notified.get(sessionId);
  if (notif && scanner.telegram && scanner.chatId) {
    const text = `${notif.text}\n\n✓ Continuing in Telegram`;
    silentCatch("scanner", "continueScannerInTelegram",
      editMessageText(scanner.telegram, scanner.chatId, notif.msgId, text, { parseMode: "HTML" }));
  }
  scanner.notified.delete(sessionId);
  scanner.suppressed.add(sessionId);
}
