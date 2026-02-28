import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";

import {
  TelegramConfig,
  Message,
  sendMessage,
  editMessageText,
  deleteMessage,
  sendChatAction,
  downloadFile,
} from "./telegram";
import { querySession, closeSession, wasSessionInterrupted, markSessionStale, type CanUseToolFn, type MessageContent } from "./claude";
import { mdToTelegramHtml, escapeHtml, tryMdToHtml, truncateMessage, stripThinking, formatToolDescription } from "./format";
import { logger, errorMessage, silentCatch, silentTry } from "./logger";
import { defaultCwd, whisperModelPath, SILENT_TOOLS } from "./config";
import {
  getOrCreateSessionId,
  loadSessionCwd,
  loadModel,
  createNewSession,
  findSession,
  findSessionFilePath,
  saveActiveSessionId,
  saveSessionCwd,
} from "./sessions";
import { sessionsReplyKeyboard } from "./session-ui";
import { handleCommand } from "./commands";
import { HandlerContext, isUserAllowed, activeQueries } from "./context";
import { registerPendingAsk, registerPendingPerm, denyAllPending, hasPendingPerms, hasPendingAsks, resolveAsksWithText, consumePendingInput, isPermDenied, clearPermDenied, stopOldSession, registerTakeoverHandler, registerWatcherCleanup, registerScannerDismiss, registerWatcherDismissAsUser, registerScannerDismissAsUser } from "./callbacks";
import { isSttReady, isMacOS, transcribeAudio } from "./stt";
import { skipToEnd, clearWatcherPermState, getPendingToolUses, dismissScannerNotification, dismissWatcherAsUser, dismissScannerAsUser, continueWatcherInTelegram, continueScannerInTelegram } from "./watcher";
import { isAssistantMessage, isSystemInit, isTaskStarted, isTaskNotification, isResult, isResultError } from "./sdk-types";
import { matchCliPermissions } from "./permissions";
import {
  isSessionYolo, isToolAllowed, isSessionSuppressed, clearSuppression,
  setCleanupTimeout, clearCleanupTimeout,
  enqueue, hasQueuedMessages, drainNext,
  markProcessing, clearProcessing, isSessionBusy,
  updateReplyTarget, getReplyTarget, clearReplyTarget,
  type QueuedMessage,
} from "./session-state";

// ---------- SDK error message rewriting ----------
/** Rewrite SDK error messages that reference CLI commands (e.g. /login) which don't exist in Telegram. */
function rewriteSdkError(text: string): string {
  return text.replace(/Please run \/login/g, "For security, login is not supported via Telegram. Please run `claude login` in Claude Code CLI");
}

// ---------- read last user prompt from JSONL ----------
import { extractMessageContent } from "./jsonl";

function readLastUserPrompt(sessionId: string): string | null {
  const filePath = findSessionFilePath(sessionId);
  if (!filePath) return null;

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Parse lines in reverse to find last real user message (not tool_result, not meta)
  const lines = content.split("\n").filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (entry.type !== "user") continue;
    if (entry.isMeta) continue;

    const msgObj = entry.message as Record<string, unknown> | undefined;
    const msgContent = msgObj?.content;

    // Skip tool_result messages
    if (Array.isArray(msgContent) && msgContent.length > 0 &&
        (msgContent[0] as Record<string, unknown>)?.type === "tool_result") continue;
    if (entry.toolUseResult) continue;

    const text = extractMessageContent(msgContent);
    if (text) return text;
  }

  return null;
}

// ---------- takeover handler (registered with callbacks.ts to break circular dep) ----------
async function handleTakeover(
  sessionId: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
): Promise<void> {
  // Mark SDK session as stale so it recreates with resume: sessionId
  markSessionStale(sessionId);

  // Mark notifications as "Continuing in Telegram" (keeps original content)
  continueScannerInTelegram(sessionId);
  continueWatcherInTelegram();

  // Resolve session CWD from the JSONL file metadata
  const session = findSession(sessionId);
  if (session) {
    stopOldSession(ctx.sessionsFile, sessionId);
    saveActiveSessionId(ctx.sessionsFile, sessionId);
    saveSessionCwd(ctx.sessionsFile, session.project);
  }

  // Read the last user prompt from JSONL so the session continues naturally
  const lastPrompt = readLastUserPrompt(sessionId) || "continue";
  logger.debug("takeover", `resuming with prompt: ${lastPrompt.slice(0, 80)}`);

  // Send feedback notification
  const promptPreview = escapeHtml(lastPrompt.length > 300 ? lastPrompt.slice(0, 300) + "…" : lastPrompt);
  const feedbackText = `Syncing session context. Re-sending last message to Claude.\n<blockquote>${promptPreview}</blockquote>\nWaiting for response...`;
  let replyId = messageId;
  try {
    replyId = await sendMessage(ctx.telegram, chatId, feedbackText, {
      parseMode: "HTML",
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    });
  } catch (err) {
    logger.debug("takeover", `feedback message send error: ${errorMessage(err)}`);
  }

  // Resume via SDK — canUseTool is now active for permission dialogs
  await handlePrompt(lastPrompt, chatId, replyId, ctx);
}

registerTakeoverHandler(handleTakeover);
registerWatcherCleanup(clearWatcherPermState);
registerScannerDismiss(dismissScannerNotification);
registerWatcherDismissAsUser(dismissWatcherAsUser);
registerScannerDismissAsUser(dismissScannerAsUser);

// ---------- unauthorized tracking ----------
const warnedUsers = new Set<string>();

// ---------- prompt formatting ----------
function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function formatPrompt(prompt: string, imagePaths?: string[]): MessageContent {
  if (!imagePaths || imagePaths.length === 0) return prompt;
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  > = [];
  if (prompt) blocks.push({ type: "text", text: prompt });
  for (const p of imagePaths) {
    const data = fs.readFileSync(p).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: mimeFromExt(p), data } });
  }
  return blocks;
}

// ---------- image handling ----------
function ensureTempDir(): string {
  const dir = path.join(os.tmpdir(), "remotecode_tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadAndSaveImage(config: TelegramConfig, fileId: string): Promise<string> {
  const { data, filePath } = await downloadFile(config, fileId);
  const ext = path.extname(filePath) || ".jpg";
  const tempDir = ensureTempDir();
  const filename = `image_${uuidv4().replace(/-/g, "")}${ext}`;
  const savePath = path.join(tempDir, filename);
  fs.writeFileSync(savePath, data);
  return savePath;
}

function pickBestPhotoId(photos: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>): string | null {
  if (photos.length === 0) return null;
  let best = photos[0];
  for (const photo of photos) {
    const score = (p: typeof photo) =>
      p.file_size != null && p.file_size > 0 ? p.file_size : (p.width ?? 0) * (p.height ?? 0);
    if (score(photo) > score(best)) best = photo;
  }
  return best.file_id;
}

function isImageDocument(doc?: { mime_type?: string }): boolean {
  if (!doc) return false;
  return (doc.mime_type || "").toLowerCase().startsWith("image/");
}

// ---------- typing indicator ----------
interface TypingHandle {
  stop: () => void;
  pause: () => void;
  resume: () => void;
}

function startTyping(config: TelegramConfig, chatId: number): TypingHandle {
  let interval: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (interval) return;
    silentCatch("typing", "sendChatAction", sendChatAction(config, chatId));
    interval = setInterval(() => {
      silentCatch("typing", "sendChatAction", sendChatAction(config, chatId));
    }, 4000);
  };

  const stop = () => {
    if (interval) { clearInterval(interval); interval = null; }
  };

  start();
  return { stop, pause: stop, resume: start };
}

// ---------- flush reference for canUseTool ----------
/** Mutable reference that canUseTool uses to flush accumulated text and pause typing before showing UI. */
export interface FlushRef {
  flush: () => Promise<void>;
  pauseTyping: () => void;
  resumeTyping: () => void;
}

/** Mutable reference to the current tool description message so permission results can be appended to it. */
export interface ToolMsgRef {
  /** Append a status line (e.g. "✓ Allowed Bash") to the specific tool block identified by toolUseId */
  appendStatus: (toolUseId: string, status: string) => Promise<void>;
  /** Make a hidden tool block visible and update the Telegram message */
  revealBlock: (toolUseId: string) => Promise<void>;
}

interface ToolBlock {
  toolUseId: string;
  desc: string;
  status?: string;
  visible: boolean;
}

// ---------- tool message controller ----------
/** Manages tool description messages in Telegram: batching, deduplication, edit serialization. */
class ToolMessageController {
  private msgId: number | null = null;
  private blocks: ToolBlock[] = [];
  private editLock: Promise<void> = Promise.resolve();

  constructor(
    private telegram: TelegramConfig,
    private chatId: number,
  ) {}

  reset(): void {
    this.msgId = null;
    this.blocks = [];
  }

  private render(): string {
    return this.blocks
      .filter(b => b.visible)
      .map(b => b.status ? `${b.desc}\n${b.status}` : b.desc)
      .join("\n");
  }

  /** Add new tool blocks, deduplicating by toolUseId. */
  addBlocks(newBlocks: ToolBlock[]): void {
    for (const nb of newBlocks) {
      if (!this.blocks.some(b => b.toolUseId === nb.toolUseId)) {
        this.blocks.push(nb);
      }
    }
  }

  /** Send or edit the tool message (for yolo mode streaming). */
  async sendOrUpdate(): Promise<void> {
    const rendered = this.render();
    if (!rendered) return;
    if (this.msgId) {
      await editMessageText(this.telegram, this.chatId, this.msgId, rendered, { parseMode: "HTML" }).catch(() => {
        this.msgId = null;
      });
    }
    if (!this.msgId) {
      this.msgId = await sendMessage(this.telegram, this.chatId, rendered, {
        parseMode: "HTML",
      });
    }
  }

  /** Append a status line to a tool block and update the message. */
  async appendStatus(toolUseId: string, status: string): Promise<void> {
    const prev = this.editLock;
    let release!: () => void;
    this.editLock = new Promise(r => { release = r; });
    try {
      await prev;
      if (!this.msgId) return;
      const block = this.blocks.find(b => b.toolUseId === toolUseId);
      if (block) block.status = status;
      const rendered = this.render();
      if (rendered) {
        await editMessageText(this.telegram, this.chatId, this.msgId, rendered, { parseMode: "HTML" }).catch(() => {});
      }
    } finally {
      release();
    }
  }

  /** Make a hidden tool block visible and update/send the message. */
  async revealBlock(toolUseId: string): Promise<void> {
    const prev = this.editLock;
    let release!: () => void;
    this.editLock = new Promise(r => { release = r; });
    try {
      await prev;
      const block = this.blocks.find(b => b.toolUseId === toolUseId);
      if (!block || block.visible) return;
      block.visible = true;
      const rendered = this.render();
      if (!rendered) return;
      if (this.msgId) {
        await editMessageText(this.telegram, this.chatId, this.msgId, rendered, { parseMode: "HTML" }).catch(() => {});
      } else {
        this.msgId = await sendMessage(this.telegram, this.chatId, rendered, {
          parseMode: "HTML",
        });
      }
    } finally {
      release();
    }
  }

  /** Create a ToolMsgRef for use by canUseTool callbacks. */
  toRef(): ToolMsgRef {
    return {
      appendStatus: (id, status) => this.appendStatus(id, status),
      revealBlock: (id) => this.revealBlock(id),
    };
  }
}

// ---------- canUseTool callback builder ----------
function buildCanUseTool(ctx: HandlerContext, chatId: number, messageId: number, sessionId: string, cwd: string, flushRef?: FlushRef, toolMsgRef?: ToolMsgRef): CanUseToolFn {
  // Serialize permission dialogs so only one is shown at a time
  let permGate: Promise<void> = Promise.resolve();

  return async (toolName, input, { decisionReason, toolUseID }) => {
    // Helper: reveal tool block and return allow
    const allowWithReveal = async () => {
      if (toolMsgRef) await toolMsgRef.revealBlock(toolUseID);
      return { behavior: "allow" as const, updatedInput: input };
    };

    // Guard: if session was suppressed (switched away), auto-allow without UI
    if (isSessionSuppressed(sessionId)) {
      return { behavior: "allow" as const, updatedInput: input };
    }

    // 1) AskUserQuestion → inline keyboard with options
    if (toolName === "AskUserQuestion") {
      // Flush accumulated text so the user sees context before the question
      if (flushRef) await flushRef.flush();

      const questions = input.questions as Array<{
        question: string;
        options: Array<{ label: string; description?: string }>;
      }> | undefined;
      const q = questions?.[0];
      if (q) {
        const askId = crypto.randomUUID().slice(0, 8);
        const buttons = [
          ...q.options.map((opt, i) => [{
            text: opt.label,
            callback_data: `ask:${askId}:${i}:${opt.label}`,
          }]),
          [{ text: "Skip answer", callback_data: `ask:${askId}:-1:` }],
        ];
        // Pause typing while waiting for user answer
        flushRef?.pauseTyping();
        try {
          const sentAskMsgId = await sendMessage(ctx.telegram, chatId, q.question, {
            replyToMessageId: messageId,
            replyMarkup: { inline_keyboard: buttons },
          });
          const answer = await registerPendingAsk(askId, {
            question: q.question,
            options: q.options.map(o => o.label),
          }, { telegram: ctx.telegram, chatId, sentMessageId: sentAskMsgId });
          return { behavior: "allow" as const, updatedInput: { ...input, answers: answer } };
        } finally {
          flushRef?.resumeTyping();
        }
      }
    }

    // 2) Yolo mode or session yolo → auto-allow everything
    if (ctx.yolo || isSessionYolo(sessionId)) return allowWithReveal();

    // 3) Per-tool session allow
    if (isToolAllowed(sessionId, toolName)) return allowWithReveal();

    // 4) CLI settings.json permissions (global + project)
    const cliPerm = matchCliPermissions(toolName, input, cwd);
    if (cliPerm === "allow") return allowWithReveal();
    if (cliPerm === "deny") return { behavior: "deny" as const, message: "Denied by CLI settings" };

    // 5) Non-yolo → serialize, then show Allow/Deny inline keyboard
    const prevGate = permGate;
    let releaseGate!: () => void;
    permGate = new Promise<void>(r => { releaseGate = r; });

    try {
      await prevGate;

      // Session was interrupted while waiting in queue → skip dialog
      if (isPermDenied(sessionId)) {
        return { behavior: "deny" as const, message: "Session interrupted", interrupt: true };
      }

      // Re-check yolo/tool-allow in case it was set while queued (e.g. "Yolo for session" button)
      if (ctx.yolo || isSessionYolo(sessionId)) return allowWithReveal();
      if (isToolAllowed(sessionId, toolName)) return allowWithReveal();

      // Flush accumulated text so user sees tool context before the dialog
      if (flushRef) await flushRef.flush();

      // Reveal this tool block now that it's this tool's turn for permission
      if (toolMsgRef) await toolMsgRef.revealBlock(toolUseID);

      const permId = crypto.randomUUID().slice(0, 8);
      const reason = decisionReason
        ? `Allow ${escapeHtml(toolName)}?\n<i>${escapeHtml(decisionReason)}</i>`
        : `Allow ${escapeHtml(toolName)}?`;
      const buttons = [
        [
          { text: "Allow", callback_data: `perm:${permId}:allow` },
          { text: "Deny", callback_data: `perm:${permId}:deny` },
        ],
        [
          { text: `Allow ${toolName} for session`, callback_data: `perm:${permId}:tool` },
        ],
        [
          { text: "Yolo for session", callback_data: `perm:${permId}:yolo` },
        ],
      ];
      // Pause typing while waiting for permission response
      flushRef?.pauseTyping();
      try {
        const sentMsgId = await sendMessage(ctx.telegram, chatId, reason, {
          parseMode: "HTML",
          replyMarkup: { inline_keyboard: buttons },
        });
        const result = await registerPendingPerm(permId, { sessionId, toolName }, {
          telegram: ctx.telegram, chatId, sentMessageId: sentMsgId,
        });
        // Delete the permission dialog and append status to tool message
        deleteMessage(ctx.telegram, chatId, sentMsgId).catch(() => {});
        if (result === "allow" || result === "tool" || result === "yolo") {
          const label = result === "yolo" ? "✓ Yolo"
            : result === "tool" ? `✓ Allowed ${escapeHtml(toolName)} (session)`
            : `✓ Allowed ${escapeHtml(toolName)}`;
          if (toolMsgRef) await toolMsgRef.appendStatus(toolUseID, label);
          return { behavior: "allow" as const, updatedInput: input };
        }
        if (toolMsgRef) await toolMsgRef.appendStatus(toolUseID, `✗ Denied ${escapeHtml(toolName)}`);
        return { behavior: "deny" as const, message: "User denied", interrupt: true };
      } finally {
        flushRef?.resumeTyping();
      }
    } finally {
      releaseGate();
    }
  };
}

// ---------- main handler ----------
export async function handleMessage(msg: Message, ctx: HandlerContext): Promise<void> {
  const user = msg.from;
  if (!isUserAllowed(user?.id, user?.username, ctx.allowedIds, ctx.allowedNames)) {
    const userKey = String(user?.id || user?.username || msg.chat.id);
    if (warnedUsers.has(userKey)) {
      logger.debug("handler", `Blocked repeat unauthorized message from ${user?.username || user?.id || "unknown"}`);
      return;
    }
    warnedUsers.add(userKey);
    logger.warn("handler", `Unauthorized message from ${user?.username || user?.id || "unknown"}`);
    await sendMessage(ctx.telegram, msg.chat.id, "Not authorized.", { replyToMessageId: msg.message_id });
    return;
  }

  if (msg.voice || msg.audio) return handleVoiceMessage(msg, ctx);
  if (msg.photo && msg.photo.length > 0) return handleImageMessage(msg, ctx, pickBestPhotoId(msg.photo), "photo");
  if (msg.document && isImageDocument(msg.document)) return handleImageMessage(msg, ctx, msg.document.file_id, "document");
  if (msg.text) return handleTextMessage(msg, ctx);
}

async function handleTextMessage(msg: Message, ctx: HandlerContext): Promise<void> {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const text = (msg.text || "").trim();
  if (!text) return;

  try {
    logger.debug("text", `chat_id=${chatId} message_id=${messageId} text=${text}`);

    // Check pending input (e.g. new project name, new session directory)
    const pendingType = consumePendingInput(chatId);
    if (pendingType && !text.startsWith("/")) {
      if (pendingType === "new_project") {
        await handleNewProject(text, chatId, messageId, ctx);
        return;
      }
      if (pendingType === "new_session_dir") {
        await handleNewSessionDir(text, chatId, messageId, ctx);
        return;
      }
    }

    // Commands always handled immediately (regardless of busy state)
    if (await handleCommand(text, chatId, messageId, ctx)) return;
    await handlePrompt(text, chatId, messageId, ctx);
  } catch (err) {
    logger.error("handler", `Error in handleTextMessage: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${escapeHtml(rewriteSdkError(errorMessage(err)))}`, { replyToMessageId: messageId });
  }
}

async function handleImageMessage(msg: Message, ctx: HandlerContext, fileId: string | null | undefined, tag: string): Promise<void> {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const caption = (msg.caption || "").trim();
  const prompt = caption || "User sent an image.";

  if (!fileId) {
    logger.warn(tag, `No ${tag} data found chat_id=${chatId}`);
    await sendMessage(ctx.telegram, chatId, `Error: No ${tag} data found.`, { replyToMessageId: messageId });
    return;
  }

  try {
    await sendMessage(ctx.telegram, chatId, "Processing your image...", { replyToMessageId: messageId });
    logger.debug(tag, `chat_id=${chatId} message_id=${messageId} caption=${caption}`);
    const imagePath = await downloadAndSaveImage(ctx.telegram, fileId);
    await handlePrompt(prompt, chatId, messageId, ctx, [imagePath], false, true);
  } catch (err) {
    logger.error("handler", `Error in handleImageMessage: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${escapeHtml(rewriteSdkError(errorMessage(err)))}`, { replyToMessageId: messageId });
  }
}

async function handleVoiceMessage(msg: Message, ctx: HandlerContext): Promise<void> {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const fileId = msg.voice?.file_id || msg.audio?.file_id;
  if (!fileId) {
    logger.warn("voice", `No audio data found chat_id=${chatId}`);
    await sendMessage(ctx.telegram, chatId, "Error: No audio data found.", { replyToMessageId: messageId });
    return;
  }

  try {
    logger.debug("voice", `chat_id=${chatId} message_id=${messageId}`);

    if (!isSttReady()) {
      logger.warn("whisper", "Speech-to-text not set up");
      const notReadyText = isMacOS()
        ? "Speech-to-text is not set up.\nRun: remotecode setup-stt"
        : "Speech-to-text is currently not supported on Linux.";
      await sendMessage(ctx.telegram, chatId, notReadyText, { replyToMessageId: messageId });
      return;
    }

    await sendMessage(ctx.telegram, chatId, "Transcribing audio...", { replyToMessageId: messageId });

    const { data, filePath } = await downloadFile(ctx.telegram, fileId);
    const tempDir = ensureTempDir();
    const ext = path.extname(filePath) || ".oga";
    const audioPath = path.join(tempDir, `voice_${uuidv4().replace(/-/g, "")}${ext}`);
    fs.writeFileSync(audioPath, data);

    let transcription: string;
    try {
      transcription = transcribeAudio(audioPath);
    } catch (sttErr) {
      silentTry("whisper", "cleanup audio", () => fs.unlinkSync(audioPath));
      const errMsg = errorMessage(sttErr);
      logger.warn("whisper", `Transcription failed chat_id=${chatId}: ${errMsg}`);
      await sendMessage(ctx.telegram, chatId, `Speech-to-text error: ${escapeHtml(errMsg)}`, { replyToMessageId: messageId });
      return;
    }
    silentTry("whisper", "cleanup audio", () => fs.unlinkSync(audioPath));

    const blankPattern = /^\[.*BLANK.*AUDIO.*\]$|^\(.*blank.*\)$|^\[.*silence.*\]$/i;
    if (!transcription || blankPattern.test(transcription)) {
      logger.info("whisper", `Blank audio chat_id=${chatId} raw=${JSON.stringify(transcription)}`);
      await sendMessage(ctx.telegram, chatId, "No speech detected (blank audio).", { replyToMessageId: messageId });
      return;
    }

    logger.debug("whisper", `Transcription: ${transcription}`);
    await handlePrompt(transcription, chatId, messageId, ctx, undefined, true, true);
  } catch (err) {
    logger.error("handler", `Error in handleVoiceMessage: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error processing voice: ${escapeHtml(errorMessage(err))}`, { replyToMessageId: messageId });
  }
}

// ---------- path validation ----------
/** Validate and sanitize a relative path input (no ".." or absolute paths). Returns null if invalid. */
function sanitizeRelativePath(input: string): string | null {
  if (!input || input.includes("..") || path.isAbsolute(input)) return null;
  const sanitized = input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  return sanitized || null;
}

// ---------- new project creation ----------
async function handleNewProject(
  input: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
): Promise<void> {
  const sanitized = sanitizeRelativePath(input);
  if (!sanitized) {
    await sendMessage(ctx.telegram, chatId, "Invalid path.", { replyToMessageId: messageId });
    return;
  }

  const fullPath = path.join(os.homedir(), sanitized);

  // Check if final directory already exists
  if (fs.existsSync(fullPath)) {
    await sendMessage(ctx.telegram, chatId, `Already exists: <code>~/${escapeHtml(sanitized)}</code>`, {
      replyToMessageId: messageId,
      parseMode: "HTML",
    });
    return;
  }

  // Create parent directories if needed, then final directory
  try {
    const parentDir = path.dirname(fullPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.mkdirSync(fullPath);
  } catch (err) {
    await sendMessage(ctx.telegram, chatId, `Failed to create directory: ${escapeHtml(errorMessage(err))}`, {
      replyToMessageId: messageId,
    });
    return;
  }

  // Stop old session and create new one
  stopOldSession(ctx.sessionsFile);
  createNewSession(ctx.sessionsFile, fullPath);
  await sendMessage(ctx.telegram, chatId, `Created project: <code>~/${escapeHtml(sanitized)}</code>`, {
    replyToMessageId: messageId,
    parseMode: "HTML",
    replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
  });

  // Send "new project" prompt to Claude to initialize the session
  await handlePrompt("new project", chatId, messageId, ctx);
}

// ---------- new session in directory ----------
async function handleNewSessionDir(
  input: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
): Promise<void> {
  const sanitized = sanitizeRelativePath(input);
  if (!sanitized) {
    await sendMessage(ctx.telegram, chatId, "Invalid path.", { replyToMessageId: messageId });
    return;
  }

  const fullPath = path.join(os.homedir(), sanitized);

  // Create directory if it doesn't exist
  if (!fs.existsSync(fullPath)) {
    try {
      fs.mkdirSync(fullPath, { recursive: true });
    } catch (err) {
      await sendMessage(ctx.telegram, chatId, `Failed to create directory: ${escapeHtml(errorMessage(err))}`, {
        replyToMessageId: messageId,
      });
      return;
    }
  }

  // Stop old session and create new one
  stopOldSession(ctx.sessionsFile);
  createNewSession(ctx.sessionsFile, fullPath);
  const name = fullPath.split("/").pop() || sanitized;
  await sendMessage(ctx.telegram, chatId, `New session in <code>~/${escapeHtml(sanitized)}</code>`, {
    replyToMessageId: messageId,
    parseMode: "HTML",
    replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
  });
}

// ---------- prompt handling ----------
export async function handlePrompt(
  prompt: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
  imagePaths?: string[],
  voiceMode?: boolean,
  quiet?: boolean,
): Promise<void> {
  const sessionId = getOrCreateSessionId(ctx.sessionsFile);
  const sessionCwd = loadSessionCwd(ctx.sessionsFile);
  const cwd = sessionCwd || defaultCwd();
  if (!fs.existsSync(cwd)) {
    await sendMessage(ctx.telegram, chatId, `Working directory not found: ${cwd}\nSwitch session or set a valid project path.`, {
      replyToMessageId: messageId,
    });
    return;
  }
  const formattedPrompt = formatPrompt(prompt, imagePaths);

  // If this session is busy, queue the message
  if (isSessionBusy(sessionId)) {
    // Pending AskUserQuestion → use text as the answer (don't queue as new prompt)
    if (hasPendingAsks()) {
      resolveAsksWithText(typeof formattedPrompt === "string" ? formattedPrompt : prompt);
      updateReplyTarget(sessionId, messageId);
      return;
    }
    enqueue(sessionId, { prompt: formattedPrompt, chatId, messageId, ctx, voiceMode, quiet });
    if (hasPendingPerms()) {
      // Permission dialog open → deny to unblock, queue drains immediately
      denyAllPending();
    }
    return;
  }

  await executePrompt(sessionId, formattedPrompt, chatId, messageId, ctx, voiceMode, quiet);
}

// ---------- streaming response ----------
interface StreamResult {
  textParts: string[];
  gotResult: boolean;
}

async function streamResponse(
  sessionId: string,
  prompt: MessageContent,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
  options: { cwd: string; model?: string; typingHandle?: TypingHandle; quiet?: boolean },
): Promise<StreamResult> {
  const textParts: string[] = [];
  let gotResult = false;
  const getReplyId = () => getReplyTarget(sessionId) ?? messageId;

  const toolCtrl = new ToolMessageController(ctx.telegram, chatId);

  const flushRef: FlushRef = {
    flush: async () => {
      if (isSessionSuppressed(sessionId)) return;
      if (textParts.length === 0) return;
      const text = stripThinking(textParts.join("\n"));
      if (!text) return;
      const formatted = tryMdToHtml(text);
      await sendMessage(ctx.telegram, chatId, formatted.text, {
        parseMode: formatted.parseMode,
      });
      textParts.length = 0;
    },
    pauseTyping: () => options.typingHandle?.pause(),
    resumeTyping: () => options.typingHandle?.resume(),
  };

  const quiet = options.quiet === true;
  const isYolo = quiet || ctx.yolo || isSessionYolo(sessionId);

  for await (const msg of querySession(prompt, {
    sessionId,
    cwd: options.cwd,
    yolo: isYolo,
    model: options.model,
    canUseTool: buildCanUseTool(ctx, chatId, messageId, sessionId, options.cwd, flushRef, toolCtrl.toRef()),
  })) {
    const suppressed = isSessionSuppressed(sessionId) || quiet;

    if (isSystemInit(msg)) {
      logger.debug("handler", `session init: ${msg.session_id?.slice(0, 8)}`);
    }

    if (isAssistantMessage(msg)) {
      const newBlocks: ToolBlock[] = [];
      let hasText = false;
      for (const block of msg.message.content) {
        if (block.type === "text" && "text" in block) {
          textParts.push(block.text);
          hasText = true;
        }
        if (!suppressed && block.type === "tool_use" && "name" in block && !SILENT_TOOLS.has(block.name)) {
          newBlocks.push({
            toolUseId: (block as { id?: string }).id || crypto.randomUUID().slice(0, 8),
            desc: formatToolDescription(block.name, (block as { input?: Record<string, unknown> }).input || {}),
            visible: isYolo,
          });
        }
      }
      if (hasText && isYolo) toolCtrl.reset();
      if (newBlocks.length > 0) {
        toolCtrl.addBlocks(newBlocks);
        if (isYolo) await toolCtrl.sendOrUpdate();
      }
    }

    if (!suppressed && isTaskStarted(msg) && msg.description) {
      await sendMessage(ctx.telegram, chatId, `<b>Agent:</b> ${escapeHtml(msg.description)}`, {
        replyToMessageId: messageId,
        parseMode: "HTML",
      });
    }
    if (!suppressed && isTaskNotification(msg) && msg.summary) {
      const status = msg.status || "done";
      await sendMessage(ctx.telegram, chatId, `<b>Agent ${escapeHtml(status)}:</b> ${escapeHtml(msg.summary)}`, {
        replyToMessageId: messageId,
        parseMode: "HTML",
      });
    }

    if (isResult(msg)) {
      gotResult = true;
      toolCtrl.reset();
      if (!suppressed && isResultError(msg) && msg.errors && !wasSessionInterrupted(sessionId)) {
        const errText = rewriteSdkError(msg.errors.join("\n"));
        await sendMessage(ctx.telegram, chatId, `Error: ${escapeHtml(errText)}`, { replyToMessageId: messageId });
      }
    }
  }

  return { textParts, gotResult };
}

// ---------- final response sender ----------
async function sendFinalResponse(
  textParts: string[],
  prompt: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
  voiceMode?: boolean,
): Promise<void> {
  const fullText = stripThinking(textParts.join("\n"));
  if (!fullText) return;

  if (voiceMode) {
    const userHtml = mdToTelegramHtml(prompt);
    const botHtml = mdToTelegramHtml(truncateMessage(fullText, 3200));
    const formatted = `<blockquote><b><code>You:</code></b>\n${userHtml}\n\n<b><code>Bot:</code></b>\n${botHtml}</blockquote>`;
    await sendMessage(ctx.telegram, chatId, formatted, {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
      parseMode: "HTML",
    });
  } else {
    const formatted = tryMdToHtml(fullText);
    await sendMessage(ctx.telegram, chatId, formatted.text, {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
      parseMode: formatted.parseMode,
    });
  }
}

// ---------- prompt execution orchestrator ----------
async function executePrompt(
  sessionId: string,
  prompt: MessageContent,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
  voiceMode?: boolean,
  quiet?: boolean,
): Promise<void> {
  const cwd = loadSessionCwd(ctx.sessionsFile) || defaultCwd();
  const model = loadModel(ctx.sessionsFile);

  // Cancel any pending cleanup timeout — we're starting a new query for this session
  clearCleanupTimeout(sessionId);

  clearPermDenied(sessionId);
  markProcessing(sessionId);
  activeQueries.add(sessionId);
  const typingHandle = startTyping(ctx.telegram, chatId);

  try {
    const { textParts, gotResult } = await streamResponse(
      sessionId, prompt, chatId, messageId, ctx, { cwd, model, typingHandle, quiet },
    );

    if (!gotResult) return;

    // Don't send final response if session was switched away
    if (!isSessionSuppressed(sessionId)) {
      const replyId = getReplyTarget(sessionId) ?? messageId;
      const promptText = typeof prompt === "string" ? prompt : prompt.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n");
      await sendFinalResponse(textParts, promptText, chatId, replyId, ctx, voiceMode);
    }
  } finally {
    typingHandle.stop();
    skipToEnd();
    clearSuppression(sessionId);
    clearReplyTarget(sessionId);

    // Delay watcher guard removal to let SDK finish writing to JSONL.
    const sid = sessionId;
    clearCleanupTimeout(sid);
    const cleanupTimer = setTimeout(() => {
      skipToEnd();
      activeQueries.delete(sid);
      clearCleanupTimeout(sid);
    }, 2000);
    setCleanupTimeout(sid, cleanupTimer);

    // Auto-close non-active session processes when their task finishes
    const currentActiveId = getOrCreateSessionId(ctx.sessionsFile);
    const queued = hasQueuedMessages(sessionId);

    if (sessionId !== currentActiveId && !queued) {
      clearCleanupTimeout(sessionId);
      activeQueries.delete(sessionId);
      closeSession(sessionId);
      clearProcessing(sessionId);
      return;
    }

    // Drain message queue
    if (queued) {
      const next = drainNext(sessionId);
      if (next) {
        // Keep processingTurns set — next executePrompt will manage it
        executePrompt(sessionId, next.prompt, next.chatId, next.messageId, next.ctx, next.voiceMode, next.quiet).catch(err => {
          logger.error("handler", `Queue drain error: ${errorMessage(err)}`);
          clearProcessing(sessionId);
        });
      } else {
        clearProcessing(sessionId);
      }
    } else {
      clearProcessing(sessionId);
    }
  }
}
