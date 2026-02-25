import type { MessageContent } from "./claude";
import type { HandlerContext } from "./context";

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

export function isSessionYolo(sessionId: string): boolean {
  return sessionYolo.get(sessionId) === true;
}

export function isToolAllowed(sessionId: string, toolName: string): boolean {
  return sessionAutoAllowTools.get(sessionId)?.has(toolName) === true;
}

// ---------- session message suppression (for session switch) ----------
const suppressedSessions = new Set<string>();

export function suppressSessionMessages(sessionId: string): void {
  suppressedSessions.add(sessionId);
}

export function unsuppressSessionMessages(sessionId: string): void {
  suppressedSessions.delete(sessionId);
}

export function isSessionSuppressed(sessionId: string): boolean {
  return suppressedSessions.has(sessionId);
}

export function clearSuppression(sessionId: string): void {
  suppressedSessions.delete(sessionId);
}

// ---------- query cleanup timeouts (prevent stale guard removal) ----------
const queryCleanupTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export function setCleanupTimeout(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
  queryCleanupTimeouts.set(sessionId, timer);
}

export function getCleanupTimeout(sessionId: string): ReturnType<typeof setTimeout> | undefined {
  return queryCleanupTimeouts.get(sessionId);
}

export function clearCleanupTimeout(sessionId: string): void {
  const timer = queryCleanupTimeouts.get(sessionId);
  if (timer) clearTimeout(timer);
  queryCleanupTimeouts.delete(sessionId);
}

// ---------- message queue ----------
export interface QueuedMessage {
  prompt: MessageContent;
  chatId: number;
  messageId: number;
  ctx: HandlerContext;
  voiceMode?: boolean;
  quiet?: boolean;
}

const messageQueue = new Map<string, QueuedMessage[]>();
const processingTurns = new Set<string>();

export function enqueue(sessionId: string, msg: QueuedMessage): void {
  const queue = messageQueue.get(sessionId) ?? [];
  queue.push(msg);
  messageQueue.set(sessionId, queue);
}

export function clearQueue(sessionId: string): void {
  messageQueue.delete(sessionId);
}

export function hasQueuedMessages(sessionId: string): boolean {
  const queue = messageQueue.get(sessionId);
  return !!queue && queue.length > 0;
}

/** Safely dequeue the next message. Returns null if queue is empty. */
export function drainNext(sessionId: string): QueuedMessage | null {
  const queue = messageQueue.get(sessionId);
  if (!queue || queue.length === 0) return null;
  const next = queue.shift()!;
  if (queue.length === 0) messageQueue.delete(sessionId);
  return next;
}

export function isSessionBusy(sessionId: string): boolean {
  return processingTurns.has(sessionId);
}

export function markProcessing(sessionId: string): void {
  processingTurns.add(sessionId);
}

export function clearProcessing(sessionId: string): void {
  processingTurns.delete(sessionId);
}
