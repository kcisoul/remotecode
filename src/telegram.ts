import axios from "axios";
import https from "https";
import { logger } from "./logger";

const httpsAgent = new https.Agent({ family: 4 });

export interface TelegramConfig {
  botToken: string;
}

export interface SendMessageOptions {
  replyToMessageId?: number;
  replyMarkup?: Record<string, unknown>;
  parseMode?: string;
}

export interface Update {
  update_id: number;
  message?: Message;
  callback_query?: CallbackQuery;
}

export interface Message {
  message_id: number;
  from?: User;
  chat: Chat;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number; mime_type?: string };
  audio?: { file_id: string; duration?: number; mime_type?: string; file_name?: string };
  photo?: PhotoSize[];
  document?: Document;
}

export interface User {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface Chat {
  id: number;
}

export interface PhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface Document {
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface CallbackQuery {
  id: string;
  from: User;
  message?: Message;
  data?: string;
}

// ---------- internal helpers ----------
function callApi<T>(token: string, method: string, body: Record<string, unknown>, timeoutMs: number = 30000): Promise<T> {
  return axios
    .post(`https://api.telegram.org/bot${token}/${method}`, body, { timeout: timeoutMs, httpsAgent })
    .then((resp) => {
      if (!resp.data.ok) throw new Error(`Telegram API error: ${JSON.stringify(resp.data)}`);
      return resp.data.result as T;
    });
}

export interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

// ---------- public API ----------
export function getMe(config: TelegramConfig): Promise<BotInfo> {
  return callApi<BotInfo>(config.botToken, "getMe", {}, 10000);
}

export function getUpdates(config: TelegramConfig, offset: number, timeout: number = 30): Promise<Update[]> {
  return callApi(config.botToken, "getUpdates", {
    offset, timeout, allowed_updates: ["message", "callback_query"],
  }, (timeout + 5) * 1000);
}

const TELEGRAM_MSG_LIMIT = 4096;

// U+2800 (Braille Pattern Blank) filler forces the message bubble to full chat width
const WIDE_FILLER = "\u2800".repeat(35);

function widenForInlineKeyboard(text: string, replyMarkup?: Record<string, unknown>): string {
  if (replyMarkup && "inline_keyboard" in replyMarkup) {
    return text + "\n" + WIDE_FILLER;
  }
  return text;
}

export async function sendMessage(config: TelegramConfig, chatId: number, text: string, options?: SendMessageOptions): Promise<number> {
  logger.debug("telegram", `OUT message chat_id=${chatId} text=${text}`);
  if (text.length > TELEGRAM_MSG_LIMIT) {
    text = text.slice(0, TELEGRAM_MSG_LIMIT - 15) + "\n...[truncated]";
  }
  text = widenForInlineKeyboard(text, options?.replyMarkup);
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (options?.replyToMessageId) payload.reply_to_message_id = options.replyToMessageId;
  if (options?.replyMarkup) payload.reply_markup = options.replyMarkup;
  if (options?.parseMode) payload.parse_mode = options.parseMode;
  try {
    const result = await callApi<{ message_id: number }>(config.botToken, "sendMessage", payload);
    return result.message_id;
  } catch (err) {
    // Retry without parse_mode if HTML parsing failed (400)
    if (options?.parseMode && axios.isAxiosError(err) && err.response?.status === 400) {
      logger.warn("telegram", `HTML parse failed, retrying as plain text`);
      delete payload.parse_mode;
      const result = await callApi<{ message_id: number }>(config.botToken, "sendMessage", payload);
      return result.message_id;
    }
    throw err;
  }
}

export function deleteMessage(config: TelegramConfig, chatId: number, messageId: number): Promise<void> {
  return callApi(config.botToken, "deleteMessage", { chat_id: chatId, message_id: messageId }).then(() => {});
}

export function answerCallbackQuery(config: TelegramConfig, callbackQueryId: string, text?: string): Promise<void> {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  return callApi(config.botToken, "answerCallbackQuery", payload).then(() => {});
}

export async function downloadFile(config: TelegramConfig, fileId: string): Promise<{ data: Buffer; filePath: string }> {
  const fileInfo = await callApi<{ file_path: string }>(config.botToken, "getFile", { file_id: fileId }, 60000);
  const url = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`;
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  return { data: Buffer.from(resp.data), filePath: fileInfo.file_path };
}

export function setMyCommands(config: TelegramConfig, commands: Array<{ command: string; description: string }>): Promise<void> {
  return callApi(config.botToken, "setMyCommands", { commands }).then(() => {});
}

export function editMessageText(config: TelegramConfig, chatId: number, messageId: number, text: string, options?: { replyMarkup?: Record<string, unknown>; parseMode?: string }): Promise<void> {
  text = widenForInlineKeyboard(text, options?.replyMarkup);
  const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (options?.replyMarkup) payload.reply_markup = options.replyMarkup;
  if (options?.parseMode) payload.parse_mode = options.parseMode;
  return callApi(config.botToken, "editMessageText", payload).then(() => {});
}

export function sendChatAction(config: TelegramConfig, chatId: number, action: string = "typing"): Promise<void> {
  return callApi(config.botToken, "sendChatAction", { chat_id: chatId, action }).then(() => {});
}

export function deleteWebhook(config: TelegramConfig): Promise<void> {
  return callApi(config.botToken, "deleteWebhook", {}).then(() => {});
}
