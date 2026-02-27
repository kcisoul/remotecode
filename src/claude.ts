import * as fs from "fs";
import * as path from "path";
import { query, type SDKMessage, type SDKUserMessage, type PermissionResult, type Query } from "@anthropic-ai/claude-agent-sdk";
import { findSessionFilePath } from "./sessions";
import { logger, errorMessage } from "./logger";

// Ensure SDK subprocess can find `node` even when running as a daemon
// (daemon PATH may not include the node binary directory)
const nodeDir = path.dirname(process.execPath);
if (!process.env.PATH?.includes(nodeDir)) {
  process.env.PATH = `${nodeDir}:${process.env.PATH || ""}`;
}

// Remove CLAUDECODE env var to allow SDK to spawn Claude Code subprocess.
// When RemoteCode itself runs inside a Claude Code session (e.g. via `claude` CLI),
// this variable is inherited and blocks nested sessions.
delete process.env.CLAUDECODE;

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: unknown[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
  },
) => Promise<PermissionResult>;

export type { SDKMessage, PermissionResult, MessageContent };

export interface QueryOptions {
  sessionId: string | null;
  cwd: string;
  yolo: boolean;
  model?: string;
  canUseTool?: CanUseToolFn;
}

// ---------- message channel (async iterable for SDK streaming input mode) ----------

class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((value: void) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    this.queue.push(msg);
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    const self = this;
    return {
      async next(): Promise<IteratorResult<SDKUserMessage>> {
        while (!self.closed) {
          if (self.queue.length > 0) {
            return { value: self.queue.shift()!, done: false };
          }
          await new Promise<void>((resolve) => {
            self.waiter = resolve;
          });
        }
        return { value: undefined, done: true } as IteratorReturnResult<undefined>;
      },
    };
  }
}

type MessageContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
>;

function createUserMessage(content: MessageContent, sessionId: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content } as SDKUserMessage["message"],
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

// ---------- per-session state ----------

interface SessionState {
  q: Query;
  channel: MessageChannel;
  sessionId: string;
  canUseToolRef: { current: CanUseToolFn | undefined };
  turnLock: Promise<void>;
  releaseTurn: (() => void) | null;
  interrupted: boolean;
  stale: boolean;
  lastFileSize: number;
}

const sessions = new Map<string, SessionState>();

// ---------- external control ----------

export function closeSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    logger.debug("claude", `closing session ${sessionId.slice(0, 8)}`);
    s.channel.close();
    s.q.close();
    sessions.delete(sessionId);
  }
}

export function interruptSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    logger.debug("claude", `interrupting session ${sessionId.slice(0, 8)}`);
    s.interrupted = true;
    s.q.interrupt().catch(() => {});
  }
}

export function wasSessionInterrupted(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  const val = s.interrupted;
  s.interrupted = false;
  return val;
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function markSessionStale(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    logger.debug("claude", `marking session ${sessionId.slice(0, 8)} as stale (external changes detected)`);
    s.stale = true;
  }
}

// ---------- JSONL file size snapshot ----------

function getJsonlFileSize(sessionId: string): number {
  const filePath = findSessionFilePath(sessionId);
  if (!filePath) return 0;
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

// ---------- session creation helper ----------

function initNewSession(
  prompt: MessageContent,
  sessionId: string,
  options: QueryOptions,
  resume: boolean,
): SessionState {
  logger.debug(
    "claude",
    `new session: ${sessionId.slice(0, 8)} resume=${resume} model=${options.model || "default"}`,
  );

  const canUseToolRef: { current: CanUseToolFn | undefined } = {
    current: options.canUseTool,
  };
  const wrappedCanUseTool: CanUseToolFn = (toolName, input, opts) => {
    if (!canUseToolRef.current) {
      return Promise.resolve({ behavior: "deny" as const, message: "No handler" });
    }
    return canUseToolRef.current(toolName, input, opts);
  };

  const channel = new MessageChannel();
  channel.push(createUserMessage(prompt, sessionId));

  const q = query({
    prompt: channel,
    options: {
      ...(resume ? { resume: sessionId } : { sessionId }),
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.yolo ? "bypassPermissions" : undefined,
      allowDangerouslySkipPermissions: options.yolo || undefined,
      canUseTool: wrappedCanUseTool,
      stderr: (data: string) => {
        logger.debug("claude", `[stderr:${sessionId.slice(0, 8)}] ${data.trimEnd()}`);
      },
    },
  });

  const newSession: SessionState = {
    q,
    channel,
    sessionId,
    canUseToolRef,
    turnLock: Promise.resolve(),
    releaseTurn: null,
    interrupted: false,
    stale: false,
    lastFileSize: 0,
  };

  sessions.set(sessionId, newSession);
  newSession.turnLock = new Promise((r) => { newSession.releaseTurn = r; });
  return newSession;
}

// ---------- main query function ----------

export async function* querySession(
  prompt: MessageContent,
  options: QueryOptions,
): AsyncGenerator<SDKMessage> {
  const sessionId = options.sessionId!;
  let session = sessions.get(sessionId);

  // Stale session: external changes detected, recreate to pick up new JSONL context
  if (session && !session.stale) {
    // Check if JSONL file grew since last turn (host CLI wrote new messages)
    const currentSize = getJsonlFileSize(sessionId);
    if (currentSize > 0 && session.lastFileSize > 0 && currentSize !== session.lastFileSize) {
      logger.debug("claude", `JSONL size changed for ${sessionId.slice(0, 8)} (${session.lastFileSize} → ${currentSize}), marking stale`);
      session.stale = true;
    }
  }
  if (session?.stale) {
    logger.debug("claude", `recreating stale session ${sessionId.slice(0, 8)}`);
    session.channel.close();
    session.q.close();
    sessions.delete(sessionId);
    session = undefined;
  }

  if (session) {
    // Wait for session's turn lock
    await session.turnLock;
    session.turnLock = new Promise((r) => { session!.releaseTurn = r; });

    logger.debug("claude", `reusing session ${sessionId.slice(0, 8)}`);

    // Update canUseTool reference for new message's context
    session.canUseToolRef.current = options.canUseTool;

    // Update model if needed
    if (options.model) {
      try { await session.q.setModel(options.model); } catch (err) { logger.debug("claude", `setModel: ${errorMessage(err)}`); }
    }

    // Feed new message via channel
    session.channel.push(createUserMessage(prompt, sessionId));

    try {
      yield* readUntilResult(sessionId);
    } finally {
      session.lastFileSize = getJsonlFileSize(sessionId);
      if (session.releaseTurn) {
        session.releaseTurn();
        session.releaseTurn = null;
      }
    }
  } else {
    const hasFile = !!findSessionFilePath(sessionId);
    let newSession = initNewSession(prompt, sessionId, options, hasFile);

    try {
      yield* readUntilResult(sessionId);
    } catch (err) {
      if (!hasFile) throw err;
      // Resume failed (e.g. corrupted JSONL) — retry as fresh session
      logger.warn("claude", `resume failed for ${sessionId.slice(0, 8)}, retrying as new session`);
      newSession = initNewSession(prompt, sessionId, options, false);
      yield* readUntilResult(sessionId);
    } finally {
      newSession.lastFileSize = getJsonlFileSize(sessionId);
      if (newSession.releaseTurn) {
        newSession.releaseTurn();
        newSession.releaseTurn = null;
      }
    }
  }
}

// Read messages from the persistent query until a result message is received.
// Uses .next() instead of for-await to avoid calling .return() on the generator,
// which would close the persistent query.
async function* readUntilResult(sessionId: string): AsyncGenerator<SDKMessage> {
  const s = sessions.get(sessionId);
  if (!s) return;

  while (true) {
    let result: IteratorResult<SDKMessage, void>;
    try {
      result = await s.q.next();
    } catch (err) {
      // Session may have been closed externally
      if (!sessions.has(sessionId)) return;
      logger.error("claude", `session ${sessionId.slice(0, 8)} read error: ${err}`);
      sessions.delete(sessionId);
      throw err;
    }

    if (result.done) {
      logger.debug("claude", `session ${sessionId.slice(0, 8)} iterator ended`);
      sessions.delete(sessionId);
      return;
    }

    yield result.value;

    if (result.value.type === "result") {
      return;
    }
  }
}
