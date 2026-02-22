import {
  CallbackQuery,
  sendMessage,
  deleteMessage,
  editMessageText,
  answerCallbackQuery,
} from "./telegram";
import { logger, errorMessage } from "./logger";
import { HandlerContext, isUserAllowed, activeQueries } from "./context";
import { closeActiveQuery } from "./claude";
import {
  loadActiveSessionId,
  saveActiveSessionId,
  saveSessionCwd,
  saveModel,
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

// ---------- pending ask/perm systems ----------
const pendingAsk = new Map<string, {
  resolve: (answer: Record<string, string>) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const pendingPerm = new Map<string, {
  resolve: (decision: "allow" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const PENDING_TIMEOUT_MS = 300_000; // 5 minutes

export function registerPendingAsk(id: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAsk.delete(id);
      reject(new Error("Timeout waiting for user response"));
    }, PENDING_TIMEOUT_MS);
    pendingAsk.set(id, { resolve, timer });
  });
}

export function registerPendingPerm(id: string): Promise<"allow" | "deny"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPerm.delete(id);
      reject(new Error("Timeout waiting for permission response"));
    }, PENDING_TIMEOUT_MS);
    pendingPerm.set(id, { resolve, timer });
  });
}

export function denyAllPending(): void {
  for (const [id, pending] of pendingPerm) {
    clearTimeout(pending.timer);
    pending.resolve("deny");
  }
  pendingPerm.clear();
  for (const [id, pending] of pendingAsk) {
    clearTimeout(pending.timer);
    pending.resolve({ answer: "" });
  }
  pendingAsk.clear();
}

// ---------- project list markup ----------
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

// ---------- main callback handler ----------
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
    if (data.startsWith("ask:")) return handleAskCallback(data, chatId, messageId, ctx);
    if (data.startsWith("perm:")) return handlePermCallback(data, chatId, messageId, ctx);
    if (data.startsWith("model:")) return handleModelCallback(data, chatId, messageId, ctx);
  } catch (err) {
    logger.error("callback", `Error in handleCallbackQuery: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${errorMessage(err)}`, { replyToMessageId: messageId });
  }
}

// ---------- ask callback ----------
async function handleAskCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  // Format: "ask:<id>:<optionIndex>:<label>"
  const parts = data.split(":");
  const id = parts[1];
  const label = parts.slice(3).join(":");
  const pending = pendingAsk.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    pendingAsk.delete(id);
    pending.resolve({ answer: label });
  }
  try {
    await editMessageText(ctx.telegram, chatId, messageId, `Selected: ${label}`);
  } catch { /* ignore */ }
}

// ---------- perm callback ----------
async function handlePermCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  // Format: "perm:<id>:allow" or "perm:<id>:deny"
  const parts = data.split(":");
  const id = parts[1];
  const decision = parts[2] as "allow" | "deny";
  const pending = pendingPerm.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    pendingPerm.delete(id);
    pending.resolve(decision);
  }
  try {
    await editMessageText(ctx.telegram, chatId, messageId, decision === "allow" ? "Allowed" : "Denied");
  } catch { /* ignore */ }
}

// ---------- model callback ----------
async function handleModelCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  const model = data.slice("model:".length);
  saveModel(ctx.sessionsFile, model);
  try {
    await editMessageText(ctx.telegram, chatId, messageId, `Model: ${model}`);
  } catch { /* ignore */ }
}

// ---------- project callback ----------
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
    denyAllPending();
    closeActiveQuery();
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

// ---------- session callback ----------
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
    denyAllPending();
    closeActiveQuery();
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

  // Close persistent query on the old session
  denyAllPending();
  closeActiveQuery();
  const oldId = loadActiveSessionId(ctx.sessionsFile);
  if (oldId) activeQueries.delete(oldId);

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

// ---------- session delete callback ----------
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
