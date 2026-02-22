import { sendMessage } from "./telegram";
import { logger } from "./logger";
import { isAutoSyncEnabled, setAutoSync } from "./watcher";
import {
  loadActiveSessionId,
  discoverSessions,
  findSession,
  createNewSession,
  saveModel,
  loadModel,
} from "./sessions";
import {
  formatSessionLabel,
  readLastTurns,
  buildSessionDisplay,
  sessionsReplyKeyboard,
} from "./session-ui";
import { HandlerContext } from "./context";
import { buildProjectListMarkup, denyAllPending } from "./callbacks";
import { interruptSession } from "./claude";
import { clearQueue, isSessionBusy } from "./handler";

export async function handleCommand(
  text: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<boolean> {
  if (!text.startsWith("/")) return false;
  const [rawCommand] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    logger.debug("command", `chat_id=${chatId} command=${command}`);
    const welcome = [
      "<b>RemoteCode</b> - Claude Code via Telegram",
      "",
      "Send any message to chat with Claude.",
      "You can also send images and voice messages.",
      "",
      "<b>Commands:</b>",
      "/sessions - Browse and switch sessions",
      "/projects - Browse sessions by project",
      "/new - Start a new session",
      "/history - Show conversation history",
      "/model - Switch Claude model",
      "/cancel - Cancel the current task",
      "/sync - Toggle auto-sync notifications",
    ].join("\n");
    // Send reply keyboard first, then inline keyboard buttons
    await sendMessage(ctx.telegram, chatId, welcome, {
      replyToMessageId: messageId,
      parseMode: "HTML",
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    });
    await sendMessage(ctx.telegram, chatId, "Quick actions:", {
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "Sessions", callback_data: "sess:list" },
            { text: "Projects", callback_data: "proj:list" },
            { text: "+ New", callback_data: "sess:new" },
          ],
        ],
      },
    });
    return true;
  }

  if (command === "/projects") {
    logger.debug("command", `chat_id=${chatId} command=/projects`);
    await sendMessage(ctx.telegram, chatId, "Projects:", {
      replyToMessageId: messageId,
      replyMarkup: buildProjectListMarkup(),
    });
    return true;
  }

  if (command === "/history") {
    logger.debug("command", `chat_id=${chatId} command=/history`);
    const activeId = loadActiveSessionId(ctx.sessionsFile);
    if (!activeId) {
      await sendMessage(ctx.telegram, chatId, "No active session.", { replyToMessageId: messageId });
      return true;
    }
    const session = findSession(activeId);
    const label = session ? formatSessionLabel(session) : activeId.slice(0, 8);
    const pages = readLastTurns(activeId, 10);
    if (pages.length === 0) {
      await sendMessage(ctx.telegram, chatId, `${label}: No conversation history yet. Send a message to start chatting.`, { replyToMessageId: messageId });
      return true;
    }
    await sendMessage(ctx.telegram, chatId, `${label}\n\n${pages[0]}`, { replyToMessageId: messageId, parseMode: "HTML" });
    for (let i = 1; i < pages.length; i++) {
      await sendMessage(ctx.telegram, chatId, pages[i], { parseMode: "HTML" });
    }
    return true;
  }

  if (command === "/sessions") {
    logger.debug("command", `chat_id=${chatId} command=/sessions`);
    const sessions = discoverSessions(5);
    const activeId = loadActiveSessionId(ctx.sessionsFile);
    const display = buildSessionDisplay(sessions, activeId);
    await sendMessage(ctx.telegram, chatId, display.text, {
      replyToMessageId: messageId,
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: display.buttons },
    });
    return true;
  }

  if (command === "/sync") {
    logger.debug("command", `chat_id=${chatId} command=/sync`);
    const current = isAutoSyncEnabled(ctx.sessionsFile);
    setAutoSync(ctx.sessionsFile, !current);
    const status = !current ? "on" : "off";
    await sendMessage(ctx.telegram, chatId, `Auto-sync: ${status}`, {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    });
    return true;
  }

  if (command === "/model") {
    logger.debug("command", `chat_id=${chatId} command=/model`);
    const arg = text.split(/\s+/).slice(1).join(" ").trim();
    if (arg) {
      saveModel(ctx.sessionsFile, arg);
      await sendMessage(ctx.telegram, chatId, `Model: ${arg}`, { replyToMessageId: messageId });
    } else {
      const current = loadModel(ctx.sessionsFile);
      const buttons = [
        [{ text: "Sonnet 4.5", callback_data: "model:claude-sonnet-4-5-20250929" }],
        [{ text: "Opus 4.6", callback_data: "model:claude-opus-4-6" }],
        [{ text: "Haiku 4.5", callback_data: "model:claude-haiku-4-5-20251001" }],
      ];
      const label = current ? `Current model: ${current}` : "Select model:";
      await sendMessage(ctx.telegram, chatId, label, {
        replyToMessageId: messageId,
        replyMarkup: { inline_keyboard: buttons },
      });
    }
    return true;
  }

  if (command === "/cancel") {
    logger.debug("command", `chat_id=${chatId} command=/cancel`);
    const activeId = loadActiveSessionId(ctx.sessionsFile);
    if (activeId && isSessionBusy(activeId)) {
      denyAllPending();
      clearQueue(activeId);
      interruptSession(activeId);
      await sendMessage(ctx.telegram, chatId, "Task cancelled.", { replyToMessageId: messageId });
    } else {
      await sendMessage(ctx.telegram, chatId, "No active task to cancel.", { replyToMessageId: messageId });
    }
    return true;
  }

  if (command === "/new") {
    logger.debug("command", `chat_id=${chatId} command=/new`);
    createNewSession(ctx.sessionsFile);
    await sendMessage(ctx.telegram, chatId, "New session started.", {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    });
    return true;
  }

  return false;
}
