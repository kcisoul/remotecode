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
  editMessageText,
  deleteMessage,
  sendChatAction,
  downloadFile,
} from "./telegram";
import { querySession, closeSession, wasSessionInterrupted, type CanUseToolFn, type MessageContent } from "./claude";
import { mdToTelegramHtml, escapeHtml, tryMdToHtml, truncateMessage, stripThinking } from "./format";
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
import { registerPendingAsk, registerPendingPerm, denyAllPending, hasPendingPerms, hasPendingAsks, resolveAsksWithText, consumePendingInput, isPermDenied, clearPermDenied, stopOldSession, type PermMeta } from "./callbacks";
import { isSttReady, isMacOS, checkSttStatus } from "./stt";
import { skipToEnd } from "./watcher";
import { isAssistantMessage, isSystemInit, isTaskStarted, isTaskNotification, isResult, isResultError } from "./sdk-types";

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
  prompt: MessageContent;
  chatId: number;
  messageId: number;
  ctx: HandlerContext;
  voiceMode?: boolean;
  quiet?: boolean;
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
function formatToolDetail(toolName: string, input: Record<string, unknown>): string {
  const e = escapeHtml;
  switch (toolName) {
    case "Bash":
      return `${e(String(input.command || "").slice(0, 200))}`;
    case "Edit":
    case "Write":
    case "Read":
      return `${e(String(input.file_path || ""))}`;
    case "Glob":
    case "Grep":
      return `${e(String(input.pattern || ""))}`;
    case "Task":
      return `${e(String(input.description || ""))}`;
    case "WebSearch":
      return `${e(String(input.query || "").slice(0, 200))}`;
    case "WebFetch":
      return `${e(String(input.url || "").slice(0, 200))}`;
    case "NotebookEdit":
      return `${e(String(input.notebook_path || ""))}`;
    case "Skill":
      return `${e(String(input.skill || ""))}`;
    default:
      return "";
  }
}

function detectBashLang(command: string): string {
  const cmd = command.trimStart();
  if (/^python[23]?\s/.test(cmd)) return "python";
  if (/^node\s/.test(cmd)) return "javascript";
  if (/^ruby\s/.test(cmd)) return "ruby";
  if (/^go\s/.test(cmd)) return "go";
  if (/^cargo\s|^rustc\s/.test(cmd)) return "rust";
  if (/^swift\s|^swiftc\s/.test(cmd)) return "swift";
  if (/^java\s|^javac\s|^gradle\s|^mvn\s/.test(cmd)) return "java";
  return "bash";
}

function toolLanguage(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": return detectBashLang(String(input.command || ""));
    case "Edit":
    case "Write":
    case "Read":
    case "Glob":
    case "Grep": return "bash";
    case "WebSearch":
    case "WebFetch": return "bash";
    case "Task": return "bash";
    default: return "bash";
  }
}

function formatToolDescription(toolName: string, input: Record<string, unknown>): string {
  const lang = toolLanguage(toolName, input);
  const detail = formatToolDetail(toolName, input);
  if (detail) {
    return `<pre><code class="language-${lang}">${escapeHtml(toolName)}: ${detail}</code></pre>`;
  }
  return `<pre><code class="language-${lang}">${escapeHtml(toolName)}</code></pre>`;
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

// ---------- canUseTool callback builder ----------
function buildCanUseTool(ctx: HandlerContext, chatId: number, messageId: number, sessionId: string, flushRef?: FlushRef, toolMsgRef?: ToolMsgRef): CanUseToolFn {
  // Serialize permission dialogs so only one is shown at a time
  let permGate: Promise<void> = Promise.resolve();

  return async (toolName, input, { decisionReason, toolUseID }) => {
    // Guard: if session was suppressed (switched away), auto-allow without UI
    if (suppressedSessions.has(sessionId)) {
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
    if (ctx.yolo || sessionYolo.get(sessionId)) {
      if (toolMsgRef) await toolMsgRef.revealBlock(toolUseID);
      return { behavior: "allow" as const, updatedInput: input };
    }

    // 3) Per-tool session allow
    const allowedTools = sessionAutoAllowTools.get(sessionId);
    if (allowedTools?.has(toolName)) {
      if (toolMsgRef) await toolMsgRef.revealBlock(toolUseID);
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

      // Re-check yolo/tool-allow in case it was set while queued (e.g. "Yolo for session" button)
      if (ctx.yolo || sessionYolo.get(sessionId)) {
        if (toolMsgRef) await toolMsgRef.revealBlock(toolUseID);
        return { behavior: "allow" as const, updatedInput: input };
      }
      const allowedToolsRecheck = sessionAutoAllowTools.get(sessionId);
      if (allowedToolsRecheck?.has(toolName)) {
        if (toolMsgRef) await toolMsgRef.revealBlock(toolUseID);
        return { behavior: "allow" as const, updatedInput: input };
      }

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
          replyToMessageId: messageId,
          parseMode: "HTML",
          replyMarkup: { inline_keyboard: buttons },
        });
        const result = await registerPendingPerm(permId, { sessionId, toolName }, {
          telegram: ctx.telegram, chatId, sentMessageId: sentMsgId,
        });
        // Delete the permission dialog and append status to tool message
        deleteMessage(ctx.telegram, chatId, sentMsgId).catch(() => {});
        if (result === "allow" || result === "allowall") {
          if (toolMsgRef) await toolMsgRef.appendStatus(toolUseID, `✓ Allowed ${escapeHtml(toolName)}`);
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
    await handlePrompt(prompt, chatId, messageId, ctx, [imagePath], false, true);
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
    await handlePrompt(transcription, chatId, messageId, ctx, undefined, true, true);
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
  if (processingTurns.has(sessionId)) {
    // Pending AskUserQuestion → use text as the answer (don't queue as new prompt)
    if (hasPendingAsks()) {
      resolveAsksWithText(typeof formattedPrompt === "string" ? formattedPrompt : prompt);
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

  // Track the last tool description message so sequential tool_use
  // blocks are edited into the same Telegram message instead of spamming.
  let toolMsgId: number | null = null;
  let toolBlocks: ToolBlock[] = [];

  function resetToolMsg(): void {
    toolMsgId = null;
    toolBlocks = [];
  }

  function renderToolBlocks(): string {
    return toolBlocks
      .filter(b => b.visible)
      .map(b => b.status ? `${b.desc}\n${b.status}` : b.desc)
      .join("\n");
  }

  // Mutable flush ref: canUseTool calls this to send accumulated text
  // before showing interactive UI (e.g. AskUserQuestion keyboard).
  // Also exposes typing pause/resume so we stop "typing..." while
  // waiting for user interaction (AskUserQuestion, perm dialogs).
  const flushRef: FlushRef = {
    flush: async () => {
      if (suppressedSessions.has(sessionId)) return;
      if (textParts.length === 0) return;
      const text = stripThinking(textParts.join("\n"));
      if (!text) return;
      const formatted = tryMdToHtml(text);
      await sendMessage(ctx.telegram, chatId, formatted.text, {
        replyToMessageId: messageId,
        parseMode: formatted.parseMode,
      });
      textParts.length = 0;
    },
    pauseTyping: () => options.typingHandle?.pause(),
    resumeTyping: () => options.typingHandle?.resume(),
  };

  // Mutable ref so canUseTool can append permission status to the tool description message.
  // editLock serializes Telegram message edits to prevent race conditions when multiple
  // auto-allowed tools reveal concurrently.
  let editLock: Promise<void> = Promise.resolve();

  const toolMsgRef: ToolMsgRef = {
    appendStatus: async (toolUseId: string, status: string) => {
      const prev = editLock;
      let release!: () => void;
      editLock = new Promise(r => { release = r; });
      try {
        await prev;
        if (!toolMsgId) return;
        const block = toolBlocks.find(b => b.toolUseId === toolUseId);
        if (block) {
          block.status = status;
        }
        const rendered = renderToolBlocks();
        if (rendered) {
          await editMessageText(ctx.telegram, chatId, toolMsgId, rendered, { parseMode: "HTML" }).catch(() => {});
        }
      } finally {
        release();
      }
    },
    revealBlock: async (toolUseId: string) => {
      const prev = editLock;
      let release!: () => void;
      editLock = new Promise(r => { release = r; });
      try {
        await prev;
        const block = toolBlocks.find(b => b.toolUseId === toolUseId);
        if (!block || block.visible) return;
        block.visible = true;
        const rendered = renderToolBlocks();
        if (!rendered) return;
        if (toolMsgId) {
          await editMessageText(ctx.telegram, chatId, toolMsgId, rendered, { parseMode: "HTML" }).catch(() => {});
        } else {
          toolMsgId = await sendMessage(ctx.telegram, chatId, rendered, {
            replyToMessageId: messageId,
            parseMode: "HTML",
          });
        }
      } finally {
        release();
      }
    },
  };

  const quiet = options.quiet === true;
  const isYolo = quiet || ctx.yolo || sessionYolo.get(sessionId) === true;

  for await (const msg of querySession(prompt, {
    sessionId,
    cwd: options.cwd,
    yolo: isYolo,
    model: options.model,
    canUseTool: buildCanUseTool(ctx, chatId, messageId, sessionId, flushRef, toolMsgRef),
  })) {
    // Skip sending messages if session was switched away or in quiet mode
    const suppressed = suppressedSessions.has(sessionId) || quiet;

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
      // Reset tool message tracker when new text appears (new response phase).
      // In non-yolo mode canUseTool manages the tool message exclusively,
      // so only reset on hasText when yolo (streaming handler owns the message).
      if (hasText && isYolo) resetToolMsg();
      if (newBlocks.length > 0) {
        // Deduplicate: SDK streaming may re-yield the same tool_use blocks
        for (const nb of newBlocks) {
          if (!toolBlocks.some(b => b.toolUseId === nb.toolUseId)) {
            toolBlocks.push(nb);
          }
        }
        // Only send/edit tool message from streaming handler in yolo mode.
        // In non-yolo mode, canUseTool reveals blocks via toolMsgRef.
        if (isYolo) {
          const rendered = renderToolBlocks();
          if (rendered) {
            if (toolMsgId) {
              await editMessageText(ctx.telegram, chatId, toolMsgId, rendered, { parseMode: "HTML" }).catch(() => {
                toolMsgId = null;
              });
            }
            if (!toolMsgId) {
              toolMsgId = await sendMessage(ctx.telegram, chatId, rendered, {
                replyToMessageId: messageId,
                parseMode: "HTML",
              });
            }
          }
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
      resetToolMsg();
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
  const prevCleanup = queryCleanupTimeouts.get(sessionId);
  if (prevCleanup) {
    clearTimeout(prevCleanup);
    queryCleanupTimeouts.delete(sessionId);
  }

  clearPermDenied(sessionId);
  processingTurns.add(sessionId);
  activeQueries.add(sessionId);
  const typingHandle = startTyping(ctx.telegram, chatId);

  try {
    const { textParts, gotResult } = await streamResponse(
      sessionId, prompt, chatId, messageId, ctx, { cwd, model, typingHandle, quiet },
    );

    if (!gotResult) return;

    // Don't send final response if session was switched away
    if (!suppressedSessions.has(sessionId)) {
      const promptText = typeof prompt === "string" ? prompt : prompt.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n");
      await sendFinalResponse(textParts, promptText, chatId, messageId, ctx, voiceMode);
    }
  } finally {
    typingHandle.stop();
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
      executePrompt(sessionId, next.prompt, next.chatId, next.messageId, next.ctx, next.voiceMode, next.quiet).catch(err => {
        logger.error("handler", `Queue drain error: ${errorMessage(err)}`);
        processingTurns.delete(sessionId);
      });
    } else {
      processingTurns.delete(sessionId);
    }
  }
}
