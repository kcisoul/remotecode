import { sendMessage } from "./telegram";
import { logger } from "./logger";
import { isAutoSyncEnabled, setAutoSync } from "./watcher";
import {
  loadActiveSessionId,
  discoverSessions,
  findSession,
  createNewSession,
} from "./sessions";
import {
  formatSessionLabel,
  readLastTurns,
  buildSessionDisplay,
  sessionsReplyKeyboard,
} from "./session-ui";
import { HandlerContext } from "./context";
import { buildProjectListMarkup } from "./callbacks";

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

  if (command === "/new") {
    logger.debug("command", `chat_id=${chatId} command=/new`);
    createNewSession(ctx.sessionsFile);
    await sendMessage(ctx.telegram, chatId, "New session started.", {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    });
    return true;
  }

  // Claude CLI REPL slash commands — not supported in print mode
  const cliOnlyCommands = [
    "/clear", "/compact", "/config", "/context", "/copy", "/cost",
    "/debug", "/desktop", "/doctor", "/exit", "/export",
    "/init", "/mcp", "/memory", "/model", "/permissions", "/plan",
    "/rename", "/resume", "/rewind", "/stats", "/status",
    "/statusline", "/tasks", "/teleport", "/terminal-setup",
    "/theme", "/todos", "/usage", "/vim",
  ];
  if (cliOnlyCommands.includes(command)) {
    logger.debug("command", `chat_id=${chatId} blocked CLI-only command: ${command}`);
    await sendMessage(ctx.telegram, chatId,
      `<code>${command}</code> is a Claude Code CLI command and is not available in RemoteCode.`,
      { replyToMessageId: messageId, parseMode: "HTML" },
    );
    return true;
  }

  return false;
}
