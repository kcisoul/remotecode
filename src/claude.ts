import { spawn, ChildProcess } from "child_process";
import { logger, errorMessage } from "./logger";

// Track active child process for cleanup on exit
let activeChild: ChildProcess | null = null;

function cleanup() {
  if (activeChild) {
    activeChild.kill("SIGKILL");
    activeChild = null;
  }
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);

export interface ClaudeOptions {
  timeoutMs?: number;
  imagePaths?: string[];
  cwd?: string;
  yolo?: boolean;
  onBusy?: () => Promise<void> | void;
}

function buildCmd(
  args: string[],
  prompt: string,
  yolo?: boolean,
): string[] {
  const cmd = [...args, "--print"];
  if (yolo) {
    cmd.push("--dangerously-skip-permissions");
  }
  cmd.push(prompt);
  return cmd;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function runClaude(
  args: string[],
  timeoutMs?: number,
  cwd?: string
): Promise<string> {
  const effectiveTimeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    logger.debug("claude", `spawn: claude ${args.map(a => a.includes("\n") ? JSON.stringify(a) : a).join(" ")}`);
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });
    activeChild = child;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Force kill after 3s if still alive
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000);
    }, effectiveTimeout);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
    }

    child.on("close", (code) => {
      finish();
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      logger.debug("claude", `exited code=${code} stdout=${stdout.length} stderr=${stderr.slice(0, 200)}`);

      if (code !== 0) {
        const detail = stderr || stdout || `exit code ${code}`;
        reject(new Error(`Claude failed: ${detail}`));
        return;
      }
      if (!stdout) {
        reject(new Error("Claude failed: empty response"));
        return;
      }
      resolve(stdout);
    });

    child.on("error", (err) => {
      finish();
      reject(new Error(`Claude failed: ${err.message}`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithFallback(
  prompt: string,
  sessionId: string,
  options: ClaudeOptions
): Promise<string> {
  const resumeArgs = buildCmd(["--resume", sessionId], prompt, options.yolo);
  try {
    return await runClaude(resumeArgs, options.timeoutMs, options.cwd);
  } catch (err) {
    const message = errorMessage(err);
    logger.debug("claude", `resume failed: ${message}`);
    if (!message.includes("No conversation found") && !message.includes("already in use") && !message.includes("empty response")) {
      throw err;
    }
    if (message.includes("No conversation found") || message.includes("empty response")) {
      logger.info("claude", `creating new session ${sessionId}`);
      const newArgs = buildCmd(["--session-id", sessionId], prompt, options.yolo);
      return await runClaude(newArgs, options.timeoutMs, options.cwd);
    }
  }

  // "already in use" - notify and retry up to 5 times
  await options.onBusy?.();
  for (let i = 0; i < 5; i++) {
    logger.warn("claude", `Session ${sessionId.slice(0, 8)} in use, retrying (${i + 1}/5)...`);
    await sleep(2000);
    try {
      return await runClaude(resumeArgs, options.timeoutMs, options.cwd);
    } catch (err) {
      if (!errorMessage(err).includes("already in use")) {
        throw err;
      }
    }
  }
  throw new Error("Session is busy \u2014 Claude Code is active on host. Try again later.");
}

export async function askClaude(
  prompt: string,
  sessionId: string,
  options: ClaudeOptions = {}
): Promise<string> {
  return runWithFallback(prompt, sessionId, options);
}
