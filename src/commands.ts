import { sendMessage } from "./telegram";
import { logger } from "./logger";
import { MODEL_CHOICES } from "./config";
import { isAutoSyncEnabled, setAutoSync } from "./watcher";
import {
  loadActiveSessionId,
  saveActiveSessionId,
  saveSessionCwd,
  discoverSessions,
  discoverProjects,
  discoverProjectSessions,
  findSession,
  createNewSession,
  saveModel,
  loadModel,
} from "./sessions";
import {
  formatSessionLabel,
  readLastTurns,
  buildSessionDisplay,
  buildProjectSessionDisplay,
  sessionsReplyKeyboard,
} from "./session-ui";
import { HandlerContext } from "./context";
import { buildProjectListDisplay, denyAllPending, allowAllPending } from "./callbacks";
import { interruptSession } from "./claude";
import { clearQueue, isSessionBusy, suppressSessionMessages, unsuppressSessionMessages, resetSessionAutoAllow, setSessionAutoAllow } from "./handler";

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
    const projDisplay = buildProjectListDisplay();
    await sendMessage(ctx.telegram, chatId, projDisplay.text, {
      replyToMessageId: messageId,
      parseMode: "HTML",
    });
    return true;
  }

  if (command.startsWith("/show_sessions_")) {
    const suffix = command.slice("/show_sessions_".length);
    logger.debug("command", `chat_id=${chatId} command=/show_sessions_ suffix=${suffix}`);
    const projects = discoverProjects();
    const match = projects.find(p => p.projectName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() === suffix);
    if (!match) {
      await sendMessage(ctx.telegram, chatId, "Project not found.", { replyToMessageId: messageId });
      return true;
    }
    const activeId = loadActiveSessionId(ctx.sessionsFile);
    const sessions = discoverProjectSessions(match.encodedDir, 5);
    const projName = sessions.length > 0 ? sessions[0].projectName : match.projectName;
    const display = buildProjectSessionDisplay(sessions, activeId, projName, match.encodedDir);
    await sendMessage(ctx.telegram, chatId, display.text, {
      replyToMessageId: messageId,
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: display.buttons },
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
      const buttons = MODEL_CHOICES.map(({ label, modelId }) => [
        { text: label, callback_data: `model:${modelId}` },
      ]);
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
    stopOldSession(ctx.sessionsFile);
    createNewSession(ctx.sessionsFile);
    await sendMessage(ctx.telegram, chatId, "New session started.", {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    });
    return true;
  }

  if (command.startsWith("/switch_to_")) {
    const prefix = command.slice("/switch_to_".length);
    logger.debug("command", `chat_id=${chatId} command=/switch_to_ prefix=${prefix}`);
    const session = findSession(prefix);
    if (!session) {
      await sendMessage(ctx.telegram, chatId, "Session not found.", { replyToMessageId: messageId });
      return true;
    }
    stopOldSession(ctx.sessionsFile, session.sessionId);
    saveActiveSessionId(ctx.sessionsFile, session.sessionId);
    saveSessionCwd(ctx.sessionsFile, session.project);
    const label = formatSessionLabel(session);
    const pages = readLastTurns(session.sessionId, 4);
    const text = pages.length > 0 ? `Switched to: ${label}\n\n${pages[0]}` : `Switched to: ${label}`;
    await sendMessage(ctx.telegram, chatId, text, {
      replyToMessageId: messageId,
      replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
      parseMode: pages.length > 0 ? "HTML" : undefined,
    });
    return true;
  }

  return false;
}

// ---------- stop old session on switch ----------
function stopOldSession(sessionsFile: string, newSessionId?: string): void {
  const oldId = loadActiveSessionId(sessionsFile);
  if (oldId && oldId !== newSessionId) {
    if (isSessionBusy(oldId)) {
      suppressSessionMessages(oldId);
      setSessionAutoAllow(oldId);
      allowAllPending();
    } else {
      resetSessionAutoAllow(oldId);
      denyAllPending();
    }
  }
  if (newSessionId) {
    unsuppressSessionMessages(newSessionId);
  }
}
