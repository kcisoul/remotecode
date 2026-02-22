import * as path from "path";
import { query, type SDKMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
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
  abortController?: AbortController;
  canUseTool?: CanUseToolFn;
}

export async function* querySession(
  prompt: string,
  options: QueryOptions,
): AsyncGenerator<SDKMessage> {
  const hasFile = options.sessionId
    ? !!findSessionFilePath(options.sessionId)
    : false;

  logger.debug(
    "claude",
    `query: session=${options.sessionId?.slice(0, 8) || "new"} resume=${hasFile} model=${options.model || "default"}`,
  );

  const q = query({
    prompt,
    options: {
      ...(hasFile
        ? { resume: options.sessionId! }
        : options.sessionId
          ? { sessionId: options.sessionId }
          : {}),
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.yolo ? "bypassPermissions" : undefined,
      allowDangerouslySkipPermissions: options.yolo || undefined,
      canUseTool: options.canUseTool,
      abortController: options.abortController,
    },
  });

  for await (const msg of q) {
    yield msg;
  }
}
