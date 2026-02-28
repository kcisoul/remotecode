import {
  TelegramConfig,
  CallbackQuery,
  sendMessage,
  deleteMessage,
  editMessageText,
  answerCallbackQuery,
} from "./telegram";
import { logger, errorMessage, silentCatch } from "./logger";
import { escapeHtml } from "./format";
import { defaultCwd } from "./config";
import { HandlerContext, isUserAllowed } from "./context";
import { setSessionAutoAllow, setSessionToolAllow, resetSessionAutoAllow, isSessionBusy, suppressSessionMessages, unsuppressSessionMessages } from "./session-state";
import {
  loadActiveSessionId,
  loadSessionCwd,
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
  buildSessionDisplay,
  buildProjectSessionDisplay,
  sessionsReplyKeyboard,
} from "./session-ui";

// ---------- pending text input system ----------
type PendingInputType = "new_project" | "new_session_dir";

interface PendingInput {
  type: PendingInputType;
  timer: ReturnType<typeof setTimeout>;
}

const pendingInputs = new Map<number, PendingInput>();
const PENDING_INPUT_TIMEOUT_MS = 120_000; // 2 minutes

export function registerPendingInput(chatId: number, type: PendingInputType): void {
  const prev = pendingInputs.get(chatId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => { pendingInputs.delete(chatId); }, PENDING_INPUT_TIMEOUT_MS);
  pendingInputs.set(chatId, { type, timer });
}

export function consumePendingInput(chatId: number): PendingInput["type"] | null {
  const pending = pendingInputs.get(chatId);
  if (!pending) return null;
  clearTimeout(pending.timer);
  pendingInputs.delete(chatId);
  return pending.type;
}

// ---------- pending ask/perm systems ----------
export interface AskMeta {
  question: string;
  options: string[];
}

const pendingAsk = new Map<string, {
  resolve: (answer: Record<string, string>) => void;
  timer: ReturnType<typeof setTimeout>;
  meta?: AskMeta;
  msgInfo?: PermMsgInfo;
}>();

export interface PermMeta {
  sessionId: string;
  toolName: string;
}

export interface PermMsgInfo {
  telegram: TelegramConfig;
  chatId: number;
  sentMessageId: number;
}

const pendingPerm = new Map<string, {
  resolve: (decision: "allow" | "deny" | "tool" | "yolo") => void;
  timer: ReturnType<typeof setTimeout>;
  meta: PermMeta;
  msgInfo?: PermMsgInfo;
}>();

const PENDING_TIMEOUT_MS = 300_000; // 5 minutes

export function registerPendingAsk(id: string, meta?: AskMeta, msgInfo?: PermMsgInfo): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAsk.delete(id);
      if (msgInfo) {
        silentCatch("callback", "editAskTimeout",
          editMessageText(msgInfo.telegram, msgInfo.chatId, msgInfo.sentMessageId, "Timed out"));
      }
      resolve({ answer: "" });
    }, PENDING_TIMEOUT_MS);
    pendingAsk.set(id, { resolve, timer, meta, msgInfo });
  });
}

export function registerPendingPerm(id: string, meta: PermMeta, msgInfo?: PermMsgInfo): Promise<"allow" | "deny" | "tool" | "yolo"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPerm.delete(id);
      if (msgInfo) {
        silentCatch("callback", "editPermTimeout",
          editMessageText(msgInfo.telegram, msgInfo.chatId, msgInfo.sentMessageId, "Timed out"));
      }
      resolve("deny");
    }, PENDING_TIMEOUT_MS);
    pendingPerm.set(id, { resolve, timer, meta, msgInfo });
  });
}

export function denyAllPending(): void {
  for (const [, pending] of pendingPerm) {
    clearTimeout(pending.timer);
    pending.resolve("deny");
    permDenied.add(pending.meta.sessionId);
    if (pending.msgInfo) {
      silentCatch("callback", "editPermDenied",
        editMessageText(pending.msgInfo.telegram, pending.msgInfo.chatId, pending.msgInfo.sentMessageId, "Cancelled"));
    }
  }
  pendingPerm.clear();
  for (const [, pending] of pendingAsk) {
    clearTimeout(pending.timer);
    pending.resolve({ answer: "" });
    if (pending.msgInfo) {
      silentCatch("callback", "editAskDenied",
        editMessageText(pending.msgInfo.telegram, pending.msgInfo.chatId, pending.msgInfo.sentMessageId, "Cancelled"));
    }
  }
  pendingAsk.clear();
}

export function allowAllPending(): void {
  for (const [, pending] of pendingPerm) {
    clearTimeout(pending.timer);
    pending.resolve("allow");
    if (pending.msgInfo) {
      silentCatch("callback", "editPermAllowed",
        editMessageText(pending.msgInfo.telegram, pending.msgInfo.chatId, pending.msgInfo.sentMessageId, "Allowed"));
    }
  }
  pendingPerm.clear();
  for (const [, pending] of pendingAsk) {
    clearTimeout(pending.timer);
    pending.resolve({ answer: "" });
    if (pending.msgInfo) {
      silentCatch("callback", "editAskSkipped",
        editMessageText(pending.msgInfo.telegram, pending.msgInfo.chatId, pending.msgInfo.sentMessageId, "Skipped"));
    }
  }
  pendingAsk.clear();
}

export function hasPendingPerms(): boolean {
  return pendingPerm.size > 0;
}

export function hasPendingAsks(): boolean {
  return pendingAsk.size > 0;
}

/** Resolve all pending AskUserQuestion prompts with the given text. Returns true if any were resolved. */
export function resolveAsksWithText(text: string): boolean {
  if (pendingAsk.size === 0) return false;
  for (const [, pending] of pendingAsk) {
    clearTimeout(pending.timer);
    pending.resolve({ answer: text });
    if (pending.msgInfo) {
      silentCatch("callback", "editAskTextResolve",
        editMessageText(pending.msgInfo.telegram, pending.msgInfo.chatId, pending.msgInfo.sentMessageId,
          `Answered: ${escapeHtml(text.length > 200 ? text.slice(0, 200) + "…" : text)}`, { parseMode: "HTML" }));
    }
  }
  pendingAsk.clear();
  return true;
}

// ---------- takeover handler registration (breaks circular dep with handler.ts) ----------
type TakeoverHandler = (sessionId: string, chatId: number, messageId: number, ctx: HandlerContext) => Promise<void>;
let takeoverHandler: TakeoverHandler | null = null;

export function registerTakeoverHandler(handler: TakeoverHandler): void {
  takeoverHandler = handler;
}

type WatcherCleanupFn = () => void;
let clearWatcherPermStateRef: WatcherCleanupFn | null = null;

export function registerWatcherCleanup(fn: WatcherCleanupFn): void {
  clearWatcherPermStateRef = fn;
}

type ScannerDismissFn = (sessionId: string) => void;
let scannerDismissRef: ScannerDismissFn | null = null;

export function registerScannerDismiss(fn: ScannerDismissFn): void {
  scannerDismissRef = fn;
}

type VoidFn = () => void;
let watcherDismissAsUserRef: VoidFn | null = null;

export function registerWatcherDismissAsUser(fn: VoidFn): void {
  watcherDismissAsUserRef = fn;
}

// ---------- per-session perm-denied flag (prevents queued canUseTool from showing dialogs after deny) ----------
const permDenied = new Set<string>();

export function isPermDenied(sessionId: string): boolean {
  return permDenied.has(sessionId);
}

export function clearPermDenied(sessionId: string): void {
  permDenied.delete(sessionId);
}

// ---------- stop old session on switch ----------
export function stopOldSession(sessionsFile: string, newSessionId?: string): void {
  const oldId = loadActiveSessionId(sessionsFile);
  if (oldId && oldId !== newSessionId) {
    if (isSessionBusy(oldId)) {
      // Keep work running, just suppress messages and auto-allow permissions
      suppressSessionMessages(oldId);
      setSessionAutoAllow(oldId);
      allowAllPending();
    } else {
      resetSessionAutoAllow(oldId);
      denyAllPending();
    }
  }
  // Unsuppress new session in case it was running in background
  if (newSessionId) {
    unsuppressSessionMessages(newSessionId);
  }
}

// ---------- project list display ----------
const I = "\u00a0\u00a0\u00a0";
export function buildProjectListDisplay(): { text: string; buttons: Array<Array<{ text: string; callback_data: string }>> } {
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "+ New Project", callback_data: "proj:add" }],
  ];

  const projects = discoverProjects();

  if (projects.length === 0) {
    return { text: "No projects found.", buttons };
  }

  const blocks: string[] = [];
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const name = escapeHtml(p.projectName);
    const timeAgo = formatTimeAgo(p.lastModified);
    const count = p.sessionCount > 5 ? "5+" : String(p.sessionCount);
    const safeName = p.projectName.replace(/[^a-zA-Z0-9_]/g, "_");

    const info = `\u2022 <b>${name}</b>\n${I}${count} sessions  \u00b7  <code>${timeAgo}</code>`;
    const cmd = `<blockquote>/show_sessions_${safeName}</blockquote>`;
    blocks.push(info + "\n" + cmd);
  }

  return { text: blocks.join("\n\n"), buttons };
}

// ---------- callback dispatch table ----------
type CallbackHandler = (data: string, chatId: number, messageId: number, ctx: HandlerContext) => Promise<void>;

const callbackRoutes: Array<[string, CallbackHandler]> = [
  ["proj:", handleProjectCallback],
  ["newsess:", handleNewSessionCallback],
  ["sessdel:", handleSessionDeleteCallback],
  ["sess:", handleSessionCallback],
  ["ask:", handleAskCallback],
  ["perm:", handlePermCallback],
  ["model:", handleModelCallback],
  ["takeover:", handleTakeoverCallback],
];

// ---------- main callback handler ----------
export async function handleCallbackQuery(callback: CallbackQuery, ctx: HandlerContext): Promise<void> {
  const user = callback.from;
  silentCatch("callback", "answerCallbackQuery", answerCallbackQuery(ctx.telegram, callback.id));

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

    const route = callbackRoutes.find(([prefix]) => data.startsWith(prefix));
    if (route) return route[1](data, chatId, messageId, ctx);
  } catch (err) {
    logger.error("callback", `Error in handleCallbackQuery: ${errorMessage(err)}`, err);
    await sendMessage(ctx.telegram, chatId, `Error: ${escapeHtml(errorMessage(err))}`, { replyToMessageId: messageId });
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
  if (parts.length < 4) { logger.warn("callback", `malformed ask data: ${data}`); return; }
  const id = parts[1];
  const label = parts.slice(3).join(":");
  const pending = pendingAsk.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    pendingAsk.delete(id);
    pending.resolve({ answer: label });
  }
  let displayText: string;
  if (label) {
    displayText = `Selected: ${label}`;
  } else {
    const meta = pending?.meta;
    if (meta) {
      const quoted = `${meta.question}\n${meta.options.map(o => `- ${o}`).join("\n")}`;
      displayText = `<blockquote>${escapeHtml(quoted)}</blockquote>\nAnswer skipped`;
    } else {
      displayText = "Answer skipped";
    }
  }
  silentCatch("callback", "editAskResponse", editMessageText(ctx.telegram, chatId, messageId, displayText, label ? undefined : { parseMode: "HTML" }));
}

// ---------- perm callback ----------
async function handlePermCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  // Formats: perm:<id>:allow | perm:<id>:deny | perm:<id>:tool | perm:<id>:yolo
  const parts = data.split(":");
  if (parts.length < 3) { logger.warn("callback", `malformed perm data: ${data}`); return; }
  const id = parts[1];
  const decision = parts[2];
  const pending = pendingPerm.get(id);
  let label = decision;

  if (pending) {
    clearTimeout(pending.timer);
    pendingPerm.delete(id);
    const { sessionId, toolName } = pending.meta;

    if (decision === "tool") {
      setSessionToolAllow(sessionId, toolName);
      pending.resolve("tool");
    } else if (decision === "yolo") {
      setSessionAutoAllow(sessionId);
      pending.resolve("yolo");
    } else if (decision === "allow") {
      pending.resolve("allow");
    } else {
      pending.resolve("deny");
    }
    // Message deletion + status append is handled by handler's canUseTool
    return;
  }

  // Orphaned callback (no pending entry) — just clean up the message
  silentCatch("callback", "editPermResponse", editMessageText(ctx.telegram, chatId, messageId, label));
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
  silentCatch("callback", "editModelResponse", editMessageText(ctx.telegram, chatId, messageId, `Model: ${model}`));
}

// ---------- takeover callback ----------
async function handleTakeoverCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext,
): Promise<void> {
  const action = data.slice("takeover:".length);

  if (action === "dismiss") {
    watcherDismissAsUserRef?.();
    return;
  }

  // action is sessionId — takeover handler will update the notification
  const sessionId = action;

  if (!takeoverHandler) {
    logger.error("callback", "takeover handler not registered");
    silentCatch("callback", "editTakeoverFailed",
      editMessageText(ctx.telegram, chatId, messageId, "Takeover failed: handler not registered"));
    return;
  }

  try {
    await takeoverHandler(sessionId, chatId, messageId, ctx);
  } catch (err) {
    logger.error("callback", `takeover error: ${errorMessage(err)}`);
    silentCatch("callback", "editTakeoverError",
      editMessageText(ctx.telegram, chatId, messageId, `Takeover failed: ${escapeHtml(errorMessage(err))}`));
  }
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
      const projDisplay = buildProjectListDisplay();
      await editMessageText(ctx.telegram, chatId, messageId, projDisplay.text, {
        parseMode: "HTML",
        replyMarkup: { inline_keyboard: projDisplay.buttons },
      });
    } catch (err) { logger.debug("callback", `editMessageText projects: ${errorMessage(err)}`); }
    return;
  }

  if (action === "add") {
    registerPendingInput(chatId, "new_project");
    silentCatch("callback", "deleteMessage proj:add", deleteMessage(ctx.telegram, chatId, messageId));
    await sendMessage(ctx.telegram, chatId, "Enter project path (e.g. <code>myapp</code> or <code>work/myapp</code>):", {
      parseMode: "HTML",
      replyMarkup: { force_reply: true, selective: true },
    });
    return;
  }

  if (action === "close") {
    silentCatch("callback", "deleteMessage proj:close", deleteMessage(ctx.telegram, chatId, messageId));
    return;
  }

  if (action.startsWith("new:")) {
    const dir = action.slice("new:".length);
    const projectPath = decodeProjectPath(dir);
    stopOldSession(ctx.sessionsFile);
    createNewSession(ctx.sessionsFile, projectPath);
    const name = projectPath.split("/").pop() || projectPath;
    silentCatch("callback", "deleteMessage proj:new", deleteMessage(ctx.telegram, chatId, messageId));
    await sendMessage(ctx.telegram, chatId, `New session in ${name}`, { replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile) });
    return;
  }

  const encodedDir = action;
  const sessions = discoverProjectSessions(encodedDir, 5);
  const activeId = loadActiveSessionId(ctx.sessionsFile);
  const projectName = sessions.length > 0 ? sessions[0].projectName : encodedDir;
  const display = buildProjectSessionDisplay(sessions, activeId, projectName, encodedDir);

  try {
    await editMessageText(ctx.telegram, chatId, messageId, display.text, {
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: display.buttons },
    });
  } catch (err) { logger.debug("callback", `editMessageText projSessions: ${errorMessage(err)}`); }
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
    } catch (err) { logger.debug("callback", `editMessageText sessList: ${errorMessage(err)}`); }
    return;
  }

  if (action === "close") {
    silentCatch("callback", "deleteMessage sess:close", deleteMessage(ctx.telegram, chatId, messageId));
    return;
  }

  if (action === "new") {
    // Show interactive menu for new session creation
    const cwd = loadSessionCwd(ctx.sessionsFile);
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    if (cwd) {
      const name = cwd.split("/").pop() || cwd;
      buttons.push([{ text: `\ud83d\udcc1 ${name}`, callback_data: "newsess:current" }]);
    }
    buttons.push([{ text: "\ud83d\udcc1 Default workspace", callback_data: "newsess:default" }]);
    buttons.push([{ text: "\ud83d\udcc2 Other project...", callback_data: "newsess:custom" }]);
    buttons.push([{ text: "\u2716 Cancel", callback_data: "newsess:cancel" }]);
    try {
      await editMessageText(ctx.telegram, chatId, messageId, "Create new session in:", {
        replyMarkup: { inline_keyboard: buttons },
      });
    } catch (err) { logger.debug("callback", `editMessageText sess:new menu: ${errorMessage(err)}`); }
    return;
  }

  const session = findSession(action);
  if (!session) {
    await sendMessage(ctx.telegram, chatId, "Session not found.", { replyToMessageId: messageId });
    return;
  }

  // Stop old session's streaming and switch
  stopOldSession(ctx.sessionsFile, session.sessionId);

  saveActiveSessionId(ctx.sessionsFile, session.sessionId);
  saveSessionCwd(ctx.sessionsFile, session.project);

  const label = formatSessionLabel(session);
  const pages = readLastTurns(session.sessionId, 4);
  const text = pages.length > 0 ? `Switched to: ${label}\n\n${pages[0]}` : `Switched to: ${label}`;
  silentCatch("callback", "deleteMessage sessSwitch", deleteMessage(ctx.telegram, chatId, messageId));
  await sendMessage(ctx.telegram, chatId, text, {
    replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile),
    parseMode: pages.length > 0 ? "HTML" : undefined,
  });
}

// ---------- new session menu callback ----------
async function handleNewSessionCallback(
  data: string,
  chatId: number,
  messageId: number,
  ctx: HandlerContext
): Promise<void> {
  const action = data.slice("newsess:".length);

  if (action === "current") {
    const cwd = loadSessionCwd(ctx.sessionsFile);
    if (!cwd) {
      silentCatch("callback", "editNewSessNoCwd", editMessageText(ctx.telegram, chatId, messageId, "No project selected."));
      return;
    }
    stopOldSession(ctx.sessionsFile);
    createNewSession(ctx.sessionsFile, cwd);
    const name = cwd.split("/").pop() || cwd;
    silentCatch("callback", "deleteMessage newsess:current", deleteMessage(ctx.telegram, chatId, messageId));
    await sendMessage(ctx.telegram, chatId, `New session in ${name}`, { replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile) });
    return;
  }

  if (action === "default") {
    const cwd = defaultCwd();
    stopOldSession(ctx.sessionsFile);
    createNewSession(ctx.sessionsFile, cwd);
    silentCatch("callback", "deleteMessage newsess:default", deleteMessage(ctx.telegram, chatId, messageId));
    await sendMessage(ctx.telegram, chatId, "New session in RemoteCodeSessions", { replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile) });
    return;
  }

  if (action === "cancel") {
    consumePendingInput(chatId);
    silentCatch("callback", "deleteMessage newsess:cancel", deleteMessage(ctx.telegram, chatId, messageId));
    return;
  }

  if (action === "custom") {
    registerPendingInput(chatId, "new_session_dir");
    silentCatch("callback", "deleteMessage newsess:custom", deleteMessage(ctx.telegram, chatId, messageId));
    await sendMessage(ctx.telegram, chatId, "Enter directory path under <code>~/</code>\n(e.g. <code>myapp</code> or <code>work/myapp</code>)", {
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "\u2716 Cancel", callback_data: "newsess:cancel" }]] },
    });
    return;
  }
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

  silentCatch("callback", "deleteMessage sessDel", deleteMessage(ctx.telegram, chatId, messageId));
  await sendMessage(ctx.telegram, chatId, `Deleted: ${label}`, { replyMarkup: sessionsReplyKeyboard(ctx.sessionsFile) });
}
