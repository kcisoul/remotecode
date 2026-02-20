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
import { askClaude } from "./claude";
import { mdToTelegramHtml, tryMdToHtml, truncateMessage } from "./format";
import { logger, errorMessage } from "./logger";
import { defaultCwd, whisperModelPath } from "./config";
import {
  getOrCreateSessionId,
  loadSessionCwd,
} from "./sessions";
import { sessionsReplyKeyboard } from "./session-ui";
import { handleCommand } from "./commands";
import { HandlerContext, isUserAllowed, withSessionLock } from "./context";
import { isSttReady, isMacOS, checkSttStatus } from "./stt";
import { getUpdateTip } from "./update";

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
    await sendMessage(ctx.telegram, chatId, `Error: ${errorMessage(err)}${getUpdateTip()}`, { replyToMessageId: messageId });
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
    await sendMessage(ctx.telegram, chatId, `Error: ${errorMessage(err)}${getUpdateTip()}`, { replyToMessageId: messageId });
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
    await sendMessage(ctx.telegram, chatId, `Error processing voice: ${errorMessage(err)}${getUpdateTip()}`, { replyToMessageId: messageId });
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
  const formattedPrompt = formatPrompt(prompt, imagePaths);

  const stopTyping = startTyping(ctx.telegram, chatId);
  let busyNotified = false;
  let answer: string;
  try {
    answer = await withSessionLock(sessionId, async () => {
      return askClaude(formattedPrompt, sessionId, {
        imagePaths,
        cwd: sessionCwd || defaultCwd(),
        yolo: ctx.yolo,
        onBusy: async () => {
          if (!busyNotified) {
            busyNotified = true;
            await sendMessage(ctx.telegram, chatId, "Session busy \u2014 Claude Code is active on host. Retrying...", { replyToMessageId: messageId });
          }
        },
      });
    });
  } finally {
    stopTyping();
  }

  const cleaned = answer.trim().replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();

  if (voiceMode) {
    const userHtml = mdToTelegramHtml(prompt);
    const botHtml = mdToTelegramHtml(truncateMessage(cleaned, 3200));
    const formatted = `<blockquote><b><code>You:</code></b>\n${userHtml}\n\n<b><code>Bot:</code></b>\n${botHtml}</blockquote>`;
    await sendMessage(ctx.telegram, chatId, formatted, {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
      parseMode: "HTML",
    });
  } else {
    const formatted = tryMdToHtml(cleaned);
    await sendMessage(ctx.telegram, chatId, formatted.text, {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
      parseMode: formatted.parseMode,
    });
  }
}
