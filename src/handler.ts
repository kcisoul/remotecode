import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { v4 as uuidv4 } from "uuid";

import {
  TelegramConfig,
  Message,
  sendMessage,
  sendChatAction,
  downloadFile,
} from "./telegram";
import { querySession, closeSession, wasSessionInterrupted, type CanUseToolFn } from "./claude";
import { mdToTelegramHtml, escapeHtml, tryMdToHtml, truncateMessage } from "./format";
import { logger, errorMessage, silentCatch, silentTry } from "./logger";
import { defaultCwd, whisperModelPath, SILENT_TOOLS } from "./config";
import {
  getOrCreateSessionId,
  loadSessionCwd,
  loadActiveSessionId,
  loadModel,
  createNewSession,
} from "./sessions";
import { sessionsReplyKeyboard } from "./session-ui";
import { handleCommand } from "./commands";
import { HandlerContext, isUserAllowed, activeQueries } from "./context";
import { registerPendingAsk, registerPendingPerm, denyAllPending, hasPendingPerms, consumePendingInput, isPermDenied, clearPermDenied, type PermMeta } from "./callbacks";
import { isSttReady, isMacOS, checkSttStatus } from "./stt";
import { skipToEnd } from "./watcher";
import { isAssistantMessage, isSystemInit, isTaskStarted, isTaskNotification, isResult, isResultError } from "./sdk-types";

// ---------- unauthorized tracking ----------
const warnedUsers = new Set<string>();

// ---------- prompt formatting ----------
function formatPrompt(prompt: string, imagePaths?: string[]): string {
  if (!imagePaths || imagePaths.length === 0) return prompt;
  const parts = [prompt, "Image file path(s):"];
  for (const p of imagePaths) parts.push(`- ${p}`);
  return parts.join("\n\n");
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

// ---------- whisper transcription ----------
function convertToWav(inputPath: string): string {
  const wavPath = inputPath.replace(/\.[^.]+$/, "") + ".wav";
  const result = spawnSync("ffmpeg", [
    "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
  ], { timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited with code ${result.status}: ${result.stderr?.toString("utf-8").slice(0, 200)}`);
  }
  return wavPath;
}

function transcribeAudio(audioPath: string): string {
  let wavPath = audioPath;
  if (!audioPath.toLowerCase().endsWith(".wav")) {
    wavPath = convertToWav(audioPath);
  }

  try {
    const modelPath = whisperModelPath();
    const whisperBin = checkSttStatus().whisperCli || "whisper-cli";
    logger.debug("whisper", `transcribing: ${wavPath} (bin: ${whisperBin})`);
    const result = spawnSync(whisperBin, [
      "-m", modelPath, "-l", "auto", "--no-timestamps", "--no-prints", "-f", wavPath,
    ], { timeout: 60000, stdio: ["pipe", "pipe", "pipe"] });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`whisper exited with code ${result.status}: ${result.stderr?.toString("utf-8").slice(0, 200)}`);
    }
    return result.stdout.toString("utf-8").trim();
  } finally {
    if (wavPath !== audioPath) {
      silentTry("whisper", "cleanup wav", () => fs.unlinkSync(wavPath));
    }
  }
}

// ---------- typing indicator ----------
function startTyping(config: TelegramConfig, chatId: number): () => void {
  silentCatch("typing", "sendChatAction", sendChatAction(config, chatId));
  const interval = setInterval(() => {
    silentCatch("typing", "sendChatAction", sendChatAction(config, chatId));
  }, 4000);
  return () => clearInterval(interval);
}

// ---------- per-session auto-allow ----------
const sessionAutoAllowTools = new Map<string, Set<string>>();
const sessionYolo = new Map<string, boolean>();

export function resetSessionAutoAllow(sessionId: string): void {
  sessionAutoAllowTools.delete(sessionId);
  sessionYolo.delete(sessionId);
}

export function setSessionAutoAllow(sessionId: string): void {
  sessionYolo.set(sessionId, true);
}

export function setSessionToolAllow(sessionId: string, toolName: string): void {
  let tools = sessionAutoAllowTools.get(sessionId);
  if (!tools) {
    tools = new Set();
    sessionAutoAllowTools.set(sessionId, tools);
  }
  tools.add(toolName);
}

// ---------- session message suppression (for session switch) ----------
const suppressedSessions = new Set<string>();

export function suppressSessionMessages(sessionId: string): void {
  suppressedSessions.add(sessionId);
}

export function unsuppressSessionMessages(sessionId: string): void {
  suppressedSessions.delete(sessionId);
}

// ---------- query cleanup timeouts (prevent stale guard removal) ----------
const queryCleanupTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// ---------- message queue ----------
interface QueuedMessage {
  prompt: string;
  chatId: number;
  messageId: number;
  ctx: HandlerContext;
  voiceMode?: boolean;
}

const messageQueue = new Map<string, QueuedMessage[]>();
const processingTurns = new Set<string>();

function enqueue(sessionId: string, msg: QueuedMessage): void {
  const queue = messageQueue.get(sessionId) ?? [];
  queue.push(msg);
  messageQueue.set(sessionId, queue);
}

export function clearQueue(sessionId: string): void {
  messageQueue.delete(sessionId);
}

export function isSessionBusy(sessionId: string): boolean {
  return processingTurns.has(sessionId);
}

// ---------- tool description formatting ----------
function formatToolDescription(toolName: string, input: Record<string, unknown>): string {
  const e = escapeHtml;
  switch (toolName) {
    case "Bash":
      return `<b>Bash:</b> <code>${e(String(input.command || "").slice(0, 200))}</code>`;
    case "Edit":
      return `<b>Edit:</b> <code>${e(String(input.file_path || ""))}</code>`;
    case "Write":
      return `<b>Write:</b> <code>${e(String(input.file_path || ""))}</code>`;
    case "Read":
      return `<b>Read:</b> <code>${e(String(input.file_path || ""))}</code>`;
    case "Glob":
      return `<b>Glob:</b> <code>${e(String(input.pattern || ""))}</code>`;
    case "Grep":
      return `<b>Grep:</b> <code>${e(String(input.pattern || ""))}</code>`;
    case "Task":
      return `<b>Task:</b> ${e(String(input.description || ""))}`;
    default:
      return `<b>${e(toolName)}</b>`;
  }
}

// ---------- canUseTool callback builder ----------
function buildCanUseTool(ctx: HandlerContext, chatId: number, messageId: number, sessionId: string): CanUseToolFn {
  // Serialize permission dialogs so only one is shown at a time
  let permGate: Promise<void> = Promise.resolve();

  return async (toolName, input, { decisionReason }) => {
    // 1) AskUserQuestion → inline keyboard with options
    if (toolName === "AskUserQuestion") {
      const questions = input.questions as Array<{
        question: string;
        options: Array<{ label: string; description?: string }>;
      }> | undefined;
      const q = questions?.[0];
      if (q) {
        const askId = crypto.randomUUID().slice(0, 8);
        const buttons = q.options.map((opt, i) => [{
          text: opt.label,
          callback_data: `ask:${askId}:${i}:${opt.label}`,
        }]);
        await sendMessage(ctx.telegram, chatId, q.question, {
          replyToMessageId: messageId,
          replyMarkup: { inline_keyboard: buttons },
        });
        const answer = await registerPendingAsk(askId);
        return { behavior: "allow" as const, updatedInput: { ...input, answers: answer } };
      }
    }

    // 2) Yolo mode or session yolo → auto-allow everything
    if (ctx.yolo || sessionYolo.get(sessionId)) {
      return { behavior: "allow" as const, updatedInput: input };
    }

    // 3) Per-tool session allow
    const allowedTools = sessionAutoAllowTools.get(sessionId);
    if (allowedTools?.has(toolName)) {
      return { behavior: "allow" as const, updatedInput: input };
    }

    // 4) Non-yolo → serialize, then show Allow/Deny inline keyboard
    const prevGate = permGate;
    let releaseGate!: () => void;
    permGate = new Promise<void>(r => { releaseGate = r; });

    try {
      await prevGate;

      // Session was interrupted while waiting in queue → skip dialog
      if (isPermDenied(sessionId)) {
        return { behavior: "deny" as const, message: "Session interrupted", interrupt: true };
      }

      const permId = crypto.randomUUID().slice(0, 8);
      const reason = decisionReason ? `<i>${escapeHtml(decisionReason)}</i>` : "Allow?";
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
      const sentMsgId = await sendMessage(ctx.telegram, chatId, reason, {
        replyToMessageId: messageId,
        parseMode: "HTML",
        replyMarkup: { inline_keyboard: buttons },
      });
      const result = await registerPendingPerm(permId, { sessionId, toolName }, {
        telegram: ctx.telegram, chatId, sentMessageId: sentMsgId,
      });
      if (result === "allow" || result === "allowall") {
        return { behavior: "allow" as const, updatedInput: input };
      }
      return { behavior: "deny" as const, message: "User denied", interrupt: true };
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

    // Check pending input (e.g. new project name)
    const pendingType = consumePendingInput(chatId);
    if (pendingType && !text.startsWith("/")) {
      if (pendingType === "new_project") {
        await handleNewProject(text, chatId, messageId, ctx);
        return;
      }
    }

    // Commands always handled immediately (regardless of busy state)
    if (await handleCommand(text, chatId, messageId, ctx)) return;
    await handlePrompt(text, chatId, messageId, ctx);
  } catch (err) {
    logger.error("handler", `Error in handleTextMessage: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${escapeHtml(errorMessage(err))}`, { replyToMessageId: messageId });
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
    await handlePrompt(prompt, chatId, messageId, ctx, [imagePath]);
  } catch (err) {
    logger.error("handler", `Error in handleImageMessage: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${escapeHtml(errorMessage(err))}`, { replyToMessageId: messageId });
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
      const msg = isMacOS()
        ? "Speech-to-text is not set up.\nRun: remotecode setup-stt"
        : "Speech-to-text is currently not supported on Linux.";
      await sendMessage(ctx.telegram, chatId, msg, { replyToMessageId: messageId });
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
      const msg = errorMessage(sttErr);
      logger.warn("whisper", `Transcription failed chat_id=${chatId}: ${msg}`);
      await sendMessage(ctx.telegram, chatId, `Speech-to-text error: ${escapeHtml(msg)}`, { replyToMessageId: messageId });
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
    await handlePrompt(transcription, chatId, messageId, ctx, undefined, true);
  } catch (err) {
    logger.error("handler", `Error in handleVoiceMessage: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error processing voice: ${escapeHtml(errorMessage(err))}`, { replyToMessageId: messageId });
  }
}

// ---------- new project creation ----------
async function handleNewProject(
  input: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
): Promise<void> {
  // Validate input
  if (!input || input.includes("..") || path.isAbsolute(input)) {
    await sendMessage(ctx.telegram, chatId, "Invalid path.", { replyToMessageId: messageId });
    return;
  }

  const sanitized = input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  if (!sanitized) {
    await sendMessage(ctx.telegram, chatId, "Invalid path.", { replyToMessageId: messageId });
    return;
  }

  const fullPath = path.join(os.homedir(), sanitized);
  const projectName = path.basename(fullPath);

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
  const oldId = loadActiveSessionId(ctx.sessionsFile);
  if (oldId) {
    if (isSessionBusy(oldId)) {
      suppressSessionMessages(oldId);
      setSessionAutoAllow(oldId);
      denyAllPending();
    } else {
      resetSessionAutoAllow(oldId);
      denyAllPending();
    }
  }

  createNewSession(ctx.sessionsFile, fullPath);
  await sendMessage(ctx.telegram, chatId, `Created project: <code>~/${escapeHtml(sanitized)}</code>`, {
    replyToMessageId: messageId,
    parseMode: "HTML",
    replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
  });

  // Send "new project" prompt to Claude to initialize the session
  await handlePrompt("new project", chatId, messageId, ctx);
}

// ---------- prompt handling ----------
async function handlePrompt(
  prompt: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
  imagePaths?: string[],
  voiceMode?: boolean,
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
  if (processingTurns.has(sessionId)) {
    enqueue(sessionId, { prompt: formattedPrompt, chatId, messageId, ctx, voiceMode });
    if (hasPendingPerms()) {
      // Permission dialog open → deny to unblock, queue drains immediately
      denyAllPending();
    }
    return;
  }

  await executePrompt(sessionId, formattedPrompt, chatId, messageId, ctx, voiceMode);
}

// ---------- streaming response ----------
interface StreamResult {
  textParts: string[];
  gotResult: boolean;
}

async function streamResponse(
  sessionId: string,
  prompt: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
  options: { cwd: string; model?: string },
): Promise<StreamResult> {
  const textParts: string[] = [];
  let gotResult = false;

  for await (const msg of querySession(prompt, {
    sessionId,
    cwd: options.cwd,
    yolo: ctx.yolo,
    model: options.model,
    canUseTool: buildCanUseTool(ctx, chatId, messageId, sessionId),
  })) {
    // Skip sending messages if session was switched away
    const suppressed = suppressedSessions.has(sessionId);

    if (isSystemInit(msg)) {
      logger.debug("handler", `session init: ${msg.session_id?.slice(0, 8)}`);
    }

    if (isAssistantMessage(msg)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && "text" in block) {
          textParts.push(block.text);
        }
        if (!suppressed && block.type === "tool_use" && "name" in block && !SILENT_TOOLS.has(block.name)) {
          const desc = formatToolDescription(block.name, (block as { input?: Record<string, unknown> }).input || {});
          await sendMessage(ctx.telegram, chatId, desc, {
            replyToMessageId: messageId,
            parseMode: "HTML",
          });
        }
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
      if (!suppressed && isResultError(msg) && msg.errors && !wasSessionInterrupted(sessionId)) {
        const errText = msg.errors.join("\n");
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
  const fullText = textParts.join("\n").trim().replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();
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
  prompt: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
  voiceMode?: boolean,
): Promise<void> {
  const cwd = loadSessionCwd(ctx.sessionsFile) || defaultCwd();
  const model = loadModel(ctx.sessionsFile);

  // Cancel any pending cleanup timeout — we're starting a new query for this session
  const prevCleanup = queryCleanupTimeouts.get(sessionId);
  if (prevCleanup) {
    clearTimeout(prevCleanup);
    queryCleanupTimeouts.delete(sessionId);
  }

  clearPermDenied(sessionId);
  processingTurns.add(sessionId);
  activeQueries.add(sessionId);
  const stopTyping = startTyping(ctx.telegram, chatId);

  try {
    const { textParts, gotResult } = await streamResponse(
      sessionId, prompt, chatId, messageId, ctx, { cwd, model },
    );

    if (!gotResult) return;

    // Don't send final response if session was switched away
    if (!suppressedSessions.has(sessionId)) {
      await sendFinalResponse(textParts, prompt, chatId, messageId, ctx, voiceMode);
    }
  } finally {
    stopTyping();
    skipToEnd();
    suppressedSessions.delete(sessionId);

    // Delay watcher guard removal to let SDK finish writing to JSONL.
    // Cancel any previous timeout first to prevent stale removal during a new query.
    const sid = sessionId;
    const prevTimer = queryCleanupTimeouts.get(sid);
    if (prevTimer) clearTimeout(prevTimer);
    const cleanupTimer = setTimeout(() => {
      skipToEnd();
      activeQueries.delete(sid);
      queryCleanupTimeouts.delete(sid);
    }, 2000);
    queryCleanupTimeouts.set(sid, cleanupTimer);

    // Auto-close non-active session processes when their task finishes
    const currentActiveId = getOrCreateSessionId(ctx.sessionsFile);
    const queue = messageQueue.get(sessionId);
    const hasQueuedMessages = queue && queue.length > 0;

    if (sessionId !== currentActiveId && !hasQueuedMessages) {
      const closingTimer = queryCleanupTimeouts.get(sessionId);
      if (closingTimer) clearTimeout(closingTimer);
      queryCleanupTimeouts.delete(sessionId);
      activeQueries.delete(sessionId);
      closeSession(sessionId);
      processingTurns.delete(sessionId);
      return;
    }

    // Drain message queue
    if (hasQueuedMessages) {
      const next = queue!.shift()!;
      if (queue!.length === 0) messageQueue.delete(sessionId);
      // Keep processingTurns set — next executePrompt will manage it
      executePrompt(sessionId, next.prompt, next.chatId, next.messageId, next.ctx, next.voiceMode).catch(err => {
        logger.error("handler", `Queue drain error: ${errorMessage(err)}`);
        processingTurns.delete(sessionId);
      });
    } else {
      processingTurns.delete(sessionId);
    }
  }
}
