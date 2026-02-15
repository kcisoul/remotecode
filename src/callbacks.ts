import {
  CallbackQuery,
  sendMessage,
  deleteMessage,
  editMessageText,
  answerCallbackQuery,
} from "./telegram";
import { logger, errorMessage } from "./logger";
import { HandlerContext, isUserAllowed } from "./context";
import {
  loadActiveSessionId,
  saveActiveSessionId,
  saveSessionCwd,
  discoverSessions,
  discoverProjects,
  discoverProjectSessions,
  findSession,
  deleteSession,
  createNewSession,
  decodeProjectPath,
} from "./sessions";
import {
  formatTimeAgo,
  formatSessionLabel,
  readLastTurns,
  buildSessionGrid,
  buildSessionDisplay,
  sessionsReplyKeyboard,
} from "./session-ui";

export function buildProjectListMarkup(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const projects = discoverProjects();
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  if (projects.length > 0) {
    for (const p of projects) {
      let label = p.projectName;
      if (label.length > 16) label = label.slice(0, 13) + "..";
      const timeAgo = formatTimeAgo(p.lastModified);
      const count = p.sessionCount > 5 ? "5+" : String(p.sessionCount);
      buttons.push([
        { text: `${label}  [${count}]  ${timeAgo}`, callback_data: `proj:${p.encodedDir}` },
      ]);
    }
  } else {
    buttons.push([{ text: "No projects found", callback_data: "proj:noop" }]);
  }

  buttons.push([{ text: "Close", callback_data: "proj:close" }]);
  return { inline_keyboard: buttons };
}

export async function handleCallbackQuery(callback: CallbackQuery, ctx: HandlerContext): Promise<void> {
  const user = callback.from;
  try { await answerCallbackQuery(ctx.telegram, callback.id); } catch { /* ignore */ }

  if (!isUserAllowed(user.id, user.username, ctx.allowedIds, ctx.allowedNames)) {
    const chatId = callback.message?.chat.id;
    const messageId = callback.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) {
      await sendMessage(ctx.telegram, chatId, "Not authorized.", { replyToMessageId: messageId });
    }
    return;
  }

  const data = (callback.data || "").trim();
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  if (!data || chatId === undefined || messageId === undefined) return;

  try {
    logger.debug("callback", `chat_id=${chatId} message_id=${messageId} data=${data}`);

    if (data.startsWith("proj:")) return handleProjectCallback(data, chatId, messageId, ctx);
    if (data.startsWith("sessdel:")) return handleSessionDeleteCallback(data, chatId, messageId, ctx);
    if (data.startsWith("sess:")) return handleSessionCallback(data, chatId, messageId, ctx);
  } catch (err) {
    logger.error("callback", `Error in handleCallbackQuery: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${errorMessage(err)}`, { replyToMessageId: messageId });
  }
}

async function handleProjectCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  const action = data.slice("proj:".length);
  if (action === "noop") return;

  if (action === "list" || action === "back") {
    try {
      await editMessageText(ctx.telegram, chatId, messageId, "Projects:", { replyMarkup: buildProjectListMarkup() });
    } catch { /* ignore */ }
    return;
  }

  if (action === "close") {
    try { await deleteMessage(ctx.telegram, chatId, messageId); } catch { /* ignore */ }
    return;
  }

  if (action.startsWith("new:")) {
    const dir = action.slice("new:".length);
    const projectPath = decodeProjectPath(dir);
    createNewSession(ctx.sessionsFile, projectPath);
    const name = projectPath.split("/").pop() || projectPath;
    try { await deleteMessage(ctx.telegram, chatId, messageId); } catch { /* ignore */ }
    await sendMessage(ctx.telegram, chatId, `New session in ${name}`, { replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile) });
    return;
  }

  const encodedDir = action;
  const sessions = discoverProjectSessions(encodedDir, 5);
  const activeId = loadActiveSessionId(ctx.sessionsFile);
  const buttons = buildSessionGrid(sessions, activeId, { showDir: false });

  if (sessions.length === 0) {
    buttons.push([{ text: "No sessions", callback_data: "proj:noop" }]);
  }

  buttons.push([
    { text: "\u2190 Back", callback_data: "proj:back" },
    { text: "+ New", callback_data: `proj:new:${encodedDir}` },
    { text: "Close", callback_data: "proj:close" },
  ]);

  const projectName = sessions.length > 0 ? sessions[0].projectName : encodedDir;

  try {
    await editMessageText(ctx.telegram, chatId, messageId, `${projectName} sessions:`, {
      replyMarkup: { inline_keyboard: buttons },
    });
  } catch { /* ignore */ }
}

async function handleSessionCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  const action = data.slice("sess:".length);
  if (action === "noop") return;

  if (action === "list") {
    const sessions = discoverSessions(5);
    const activeId = loadActiveSessionId(ctx.sessionsFile);
    const display = buildSessionDisplay(sessions, activeId);
    try {
      await editMessageText(ctx.telegram, chatId, messageId, display.text, {
        parseMode: "HTML",
        replyMarkup: { inline_keyboard: display.buttons },
      });
    } catch { /* ignore */ }
    return;
  }

  if (action === "close") {
    try { await deleteMessage(ctx.telegram, chatId, messageId); } catch { /* ignore */ }
    return;
  }

  if (action === "new") {
    createNewSession(ctx.sessionsFile);
    try { await deleteMessage(ctx.telegram, chatId, messageId); } catch { /* ignore */ }
    await sendMessage(ctx.telegram, chatId, "New session started.", { replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile) });
    return;
  }

  const session = findSession(action);
  if (!session) {
    await sendMessage(ctx.telegram, chatId, "Session not found.", { replyToMessageId: messageId });
    return;
  }

  saveActiveSessionId(ctx.sessionsFile, session.sessionId);
  saveSessionCwd(ctx.sessionsFile, session.project);

  const label = formatSessionLabel(session);
  const pages = readLastTurns(session.sessionId, 4);
  const text = pages.length > 0 ? `Switched to: ${label}\n\n${pages[0]}` : `Switched to: ${label}`;
  try { await deleteMessage(ctx.telegram, chatId, messageId); } catch { /* ignore */ }
  await sendMessage(ctx.telegram, chatId, text, {
    replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    parseMode: pages.length > 0 ? "HTML" : undefined,
  });
}

async function handleSessionDeleteCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  const sessionId = data.slice("sessdel:".length);

  if (loadActiveSessionId(ctx.sessionsFile) === sessionId) {
    await sendMessage(ctx.telegram, chatId, "Cannot delete the active session.", { replyToMessageId: messageId });
    return;
  }

  const session = findSession(sessionId);
  const label = session ? formatSessionLabel(session) : sessionId.slice(0, 8);

  if (!deleteSession(sessionId)) {
    await sendMessage(ctx.telegram, chatId, "Session file not found.", { replyToMessageId: messageId });
    return;
  }

  try { await deleteMessage(ctx.telegram, chatId, messageId); } catch { /* ignore */ }
  await sendMessage(ctx.telegram, chatId, `Deleted: ${label}`, { replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile) });
}
