import * as path from "path";
import { query, type SDKMessage, type SDKUserMessage, type PermissionResult, type Query } from "@anthropic-ai/claude-agent-sdk";
import { findSessionFilePath } from "./sessions";
import { logger } from "./logger";

// Ensure SDK subprocess can find `node` even when running as a daemon
// (daemon PATH may not include the node binary directory)
const nodeDir = path.dirname(process.execPath);
if (!process.env.PATH?.includes(nodeDir)) {
  process.env.PATH = `${nodeDir}:${process.env.PATH || ""}`;
}

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

export type { SDKMessage, PermissionResult };

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
        return { value: undefined as unknown as SDKUserMessage, done: true };
      },
    };
  }
}

function createUserMessage(content: string, sessionId: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content } as SDKUserMessage["message"],
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

// ---------- persistent session state ----------

interface ActiveSession {
  q: Query;
  channel: MessageChannel;
  sessionId: string;
  canUseToolRef: { current: CanUseToolFn | undefined };
}

let activeSession: ActiveSession | null = null;

// Turn lock: ensures only one readUntilResult is active at a time
let turnLock: Promise<void> = Promise.resolve();
let releaseTurn: (() => void) | null = null;

// Flags for detecting interrupt / external close
let queryInterrupted = false;
let closedExternally = false;

// ---------- external control ----------

export function closeActiveQuery(): void {
  if (activeSession) {
    logger.debug("claude", `closing query for session ${activeSession.sessionId.slice(0, 8)}`);
    closedExternally = true;
    activeSession.channel.close();
    activeSession.q.close();
    activeSession = null;
  }
}

export function interruptActiveQuery(): void {
  if (activeSession) {
    logger.debug("claude", `interrupting query for session ${activeSession.sessionId.slice(0, 8)}`);
    queryInterrupted = true;
    activeSession.q.interrupt().catch(() => {});
  }
}

export function wasInterrupted(): boolean {
  const val = queryInterrupted;
  queryInterrupted = false;
  return val;
}

export function wasClosedExternally(): boolean {
  const val = closedExternally;
  closedExternally = false;
  return val;
}

// ---------- main query function ----------

export async function* querySession(
  prompt: string,
  options: QueryOptions,
): AsyncGenerator<SDKMessage> {
  // Wait for any previous turn to complete
  await turnLock;
  turnLock = new Promise((r) => { releaseTurn = r; });

  try {
    const sameSession = activeSession && activeSession.sessionId === options.sessionId;

    if (sameSession) {
      logger.debug("claude", `reusing query for session ${options.sessionId?.slice(0, 8)}`);

      // Update canUseTool reference for new message's context
      activeSession!.canUseToolRef.current = options.canUseTool;

      // Update model if needed
      if (options.model) {
        try { await activeSession!.q.setModel(options.model); } catch { /* ignore */ }
      }

      // Feed new message via channel
      activeSession!.channel.push(createUserMessage(prompt, options.sessionId!));

      yield* readUntilResult();
    } else {
      // Close old query if switching sessions
      closeActiveQuery();

      const sessionId = options.sessionId!;
      const hasFile = !!findSessionFilePath(sessionId);

      logger.debug(
        "claude",
        `new query: session=${sessionId.slice(0, 8)} resume=${hasFile} model=${options.model || "default"}`,
      );

      // Mutable canUseTool reference so handler can update per-message
      const canUseToolRef: { current: CanUseToolFn | undefined } = {
        current: options.canUseTool,
      };
      const wrappedCanUseTool: CanUseToolFn = (toolName, input, opts) => {
        if (!canUseToolRef.current) {
          return Promise.resolve({ behavior: "deny" as const, message: "No handler" });
        }
        return canUseToolRef.current(toolName, input, opts);
      };

      // Create message channel (streaming input mode) and push first message
      const channel = new MessageChannel();
      channel.push(createUserMessage(prompt, sessionId));

      const q = query({
        prompt: channel,
        options: {
          ...(hasFile
            ? { resume: sessionId }
            : { sessionId }),
          cwd: options.cwd,
          model: options.model,
          permissionMode: options.yolo ? "bypassPermissions" : undefined,
          allowDangerouslySkipPermissions: options.yolo || undefined,
          canUseTool: wrappedCanUseTool,
        },
      });

      activeSession = { q, channel, sessionId, canUseToolRef };

      yield* readUntilResult();
    }
  } finally {
    if (releaseTurn) {
      releaseTurn();
      releaseTurn = null;
    }
  }
}

// Read messages from the persistent query until a result message is received.
// Uses .next() instead of for-await to avoid calling .return() on the generator,
// which would close the persistent query.
async function* readUntilResult(): AsyncGenerator<SDKMessage> {
  if (!activeSession) return;
  const q = activeSession.q;

  while (true) {
    let result: IteratorResult<SDKMessage, void>;
    try {
      result = await q.next();
    } catch (err) {
      if (closedExternally) {
        // Session was switched externally - exit gracefully
        closedExternally = false;
        return;
      }
      logger.error("claude", `query read error: ${err}`);
      activeSession = null;
      throw err;
    }

    if (result.done) {
      logger.debug("claude", "query iterator ended unexpectedly");
      activeSession = null;
      return;
    }

    yield result.value;

    if (result.value.type === "result") {
      return;
    }
  }
}
