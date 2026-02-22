import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { v4 as uuidv4 } from "uuid";

import {
  TelegramConfig,
  Message,
  sendMessage,
  sendChatAction,
  downloadFile,
} from "./telegram";
import { querySession, type SDKMessage, type CanUseToolFn } from "./claude";
import { mdToTelegramHtml, escapeHtml, tryMdToHtml, truncateMessage } from "./format";
import { logger, errorMessage } from "./logger";
import { defaultCwd, whisperModelPath } from "./config";
import {
  getOrCreateSessionId,
  loadSessionCwd,
  loadModel,
} from "./sessions";
import { sessionsReplyKeyboard } from "./session-ui";
import { handleCommand } from "./commands";
import { HandlerContext, isUserAllowed, activeQueries } from "./context";
import { registerPendingAsk, registerPendingPerm, denyAllPending } from "./callbacks";
import { isSttReady, isMacOS, checkSttStatus } from "./stt";

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
    const score = (p: typeof photo) => (p.file_size || 0) || ((p.width || 0) * (p.height || 0));
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
  execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`, {
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
    const output = execSync(
      `"${whisperBin}" -m "${modelPath}" -l auto --no-timestamps --no-prints -f "${wavPath}"`,
      { timeout: 60000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return output.toString("utf-8").trim();
  } finally {
    if (wavPath !== audioPath) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }
}

// ---------- typing indicator ----------
function startTyping(config: TelegramConfig, chatId: number): () => void {
  sendChatAction(config, chatId).catch(() => {});
  const interval = setInterval(() => {
    sendChatAction(config, chatId).catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
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
function buildCanUseTool(ctx: HandlerContext, chatId: number, messageId: number): CanUseToolFn {
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

    // 2) Yolo mode → auto-allow everything
    if (ctx.yolo) {
      return { behavior: "allow" as const, updatedInput: input };
    }

    // 3) Non-yolo → Allow/Deny inline keyboard
    const permId = crypto.randomUUID().slice(0, 8);
    const desc = formatToolDescription(toolName, input);
    const reason = decisionReason ? `\n<i>${escapeHtml(decisionReason)}</i>` : "";
    const buttons = [[
      { text: "Allow", callback_data: `perm:${permId}:allow` },
      { text: "Deny", callback_data: `perm:${permId}:deny` },
    ]];
    await sendMessage(ctx.telegram, chatId, `${desc}${reason}`, {
      replyToMessageId: messageId,
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: buttons },
    });
    const result = await registerPendingPerm(permId);
    if (result === "allow") {
      return { behavior: "allow" as const, updatedInput: input };
    }
    return { behavior: "deny" as const, message: "User denied", interrupt: true };
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
    if (await handleCommand(text, chatId, messageId, ctx)) return;
    await handlePrompt(text, chatId, messageId, ctx);
  } catch (err) {
    logger.error("handler", `Error in handleTextMessage: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${errorMessage(err)}`, { replyToMessageId: messageId });
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
    await sendMessage(ctx.telegram, chatId, `Error: ${errorMessage(err)}`, { replyToMessageId: messageId });
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
      try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
      const msg = errorMessage(sttErr);
      logger.warn("whisper", `Transcription failed chat_id=${chatId}: ${msg}`);
      await sendMessage(ctx.telegram, chatId, `Speech-to-text error: ${msg}`, { replyToMessageId: messageId });
      return;
    }
    try { fs.unlinkSync(audioPath); } catch { /* ignore */ }

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
    await sendMessage(ctx.telegram, chatId, `Error processing voice: ${errorMessage(err)}`, { replyToMessageId: messageId });
  }
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
  const model = loadModel(ctx.sessionsFile);
  const formattedPrompt = formatPrompt(prompt, imagePaths);

  // Abort any existing query for this session (e.g. waiting for perm)
  const existingController = activeQueries.get(sessionId);
  if (existingController) {
    denyAllPending();
    existingController.abort();
  }

  const controller = new AbortController();
  activeQueries.set(sessionId, controller);
  const stopTyping = startTyping(ctx.telegram, chatId);

  const textParts: string[] = [];

  try {
    for await (const msg of querySession(formattedPrompt, {
      sessionId,
      cwd,
      yolo: ctx.yolo,
      model,
      abortController: controller,
      canUseTool: buildCanUseTool(ctx, chatId, messageId),
    })) {
      // Log init (session ID already set via getOrCreateSessionId)
      if (msg.type === "system" && msg.subtype === "init") {
        const initMsg = msg as SDKMessage & { session_id: string };
        logger.debug("handler", `session init: ${initMsg.session_id?.slice(0, 8)}`);
      }

      // Stream assistant messages
      if (msg.type === "assistant") {
        const assistantMsg = msg as SDKMessage & { message: { content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } };
        for (const block of assistantMsg.message.content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          }
          if (block.type === "tool_use" && block.name) {
            const desc = formatToolDescription(block.name, block.input || {});
            await sendMessage(ctx.telegram, chatId, desc, {
              replyToMessageId: messageId,
              parseMode: "HTML",
            });
          }
        }
      }

      // Subagent events
      if (msg.type === "system") {
        const sysMsg = msg as SDKMessage & { subtype: string; description?: string; status?: string; summary?: string; task_id?: string };
        if (sysMsg.subtype === "task_started" && sysMsg.description) {
          await sendMessage(ctx.telegram, chatId, `<b>Agent:</b> ${escapeHtml(sysMsg.description)}`, {
            replyToMessageId: messageId,
            parseMode: "HTML",
          });
        }
        if (sysMsg.subtype === "task_notification" && sysMsg.summary) {
          const status = sysMsg.status || "done";
          await sendMessage(ctx.telegram, chatId, `<b>Agent ${escapeHtml(status)}:</b> ${escapeHtml(sysMsg.summary)}`, {
            replyToMessageId: messageId,
            parseMode: "HTML",
          });
        }
      }

      // Handle result
      if (msg.type === "result") {
        const resultMsg = msg as SDKMessage & { is_error: boolean; errors?: string[]; total_cost_usd?: number; num_turns?: number };
        if (resultMsg.is_error && resultMsg.errors) {
          const errText = resultMsg.errors.join("\n");
          await sendMessage(ctx.telegram, chatId, `Error: ${errText}`, { replyToMessageId: messageId });
        }
      }
    }

    // Send collected text response
    const fullText = textParts.join("\n").trim().replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();
    if (fullText) {
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
  } catch (err) {
    if (controller.signal.aborted) {
      logger.debug("handler", `query aborted for session ${sessionId.slice(0, 8)}`);
      await sendMessage(ctx.telegram, chatId, "Session switched — request cancelled.", {
        replyToMessageId: messageId,
      });
      return;
    }
    throw err;
  } finally {
    stopTyping();
    activeQueries.delete(sessionId);
  }
}
