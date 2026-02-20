import * as fs from "fs";
import { spawn, execSync } from "child_process";
import {
  loadConfig, getConfig, ensureConfigDir, pidFilePath, logFilePath, sessionsFilePath,
  readEnvLines, writeEnvLines, readKvFile,
} from "./config";
import { logger, errorMessage } from "./logger";
import {
  TelegramConfig,
  getUpdates,
  setMyCommands,
  deleteWebhook,
  Update,
  sendMessage,
} from "./telegram";
import { handleMessage } from "./handler";
import { handleCallbackQuery } from "./callbacks";
import { HandlerContext } from "./context";
import { startWatcher, stopWatcher } from "./watcher";
import { startUpdateChecker, stopUpdateChecker } from "./update";

// ---------- PID management ----------
export function readPid(): number | null {
  try {
    const content = fs.readFileSync(pidFilePath(), "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (pid === null) return { running: false, pid: null };
  if (isRunning(pid)) return { running: true, pid };
  // Stale PID file -- clean up
  try { fs.unlinkSync(pidFilePath()); } catch { /* ignore */ }
  return { running: false, pid: null };
}

function writePid(): void {
  fs.writeFileSync(pidFilePath(), String(process.pid), "utf-8");
}

function removePid(): void {
  try {
    const content = fs.readFileSync(pidFilePath(), "utf-8").trim();
    if (content === String(process.pid)) {
      fs.unlinkSync(pidFilePath());
    }
  } catch { /* ignore */ }
}

/** Kill any orphaned --daemon processes (PID file missing but process alive) */
export function killOrphanDaemons(): void {
  try {
    const out = execSync("ps -eo pid,args", { stdio: "pipe" }).toString();
    const myPid = process.pid;
    for (const line of out.split("\n")) {
      if (!line.includes("--daemon")) continue;
      if (!line.includes("remotecode") && !line.includes("index.js") && !line.includes("index.ts")) continue;
      const pid = parseInt(line.trim(), 10);
      if (isNaN(pid) || pid === myPid) continue;
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  Killed orphan daemon (pid ${pid})`);
      } catch { /* already dead */ }
    }
  } catch { /* ps failed -- ignore */ }
}

// ---------- Log management ----------
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

function setupLogging(): void {
  const logPath = logFilePath();
  let logStream = fs.createWriteStream(logPath, { flags: "a" });
  let byteCount = 0;
  try {
    byteCount = fs.statSync(logPath).size;
  } catch { /* file may not exist yet */ }

  function rotateIfNeeded(bytes: number): void {
    byteCount += bytes;
    if (byteCount >= LOG_MAX_BYTES) {
      logStream.end();
      try {
        fs.renameSync(logPath, logPath + ".old");
      } catch { /* ignore */ }
      logStream = fs.createWriteStream(logPath, { flags: "a" });
      byteCount = 0;
      patchWrite();
    }
  }

  function patchWrite(): void {
    process.stdout.write = (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
      const buf = Buffer.from(typeof chunk === "string" ? chunk : chunk.toString());
      logStream.write(buf);
      rotateIfNeeded(buf.length);
      return true;
    };

    process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
      const buf = Buffer.from(typeof chunk === "string" ? chunk : chunk.toString());
      logStream.write(buf);
      rotateIfNeeded(buf.length);
      return true;
    };
  }

  patchWrite();
}

// ---------- Bot commands ----------
async function registerCommands(config: TelegramConfig): Promise<void> {
  const commands = [
    { command: "start", description: "Welcome message and quick actions" },
    { command: "help", description: "Show help and commands" },
    { command: "sessions", description: "List local Claude Code sessions" },
    { command: "projects", description: "Browse sessions by project" },
    { command: "new", description: "New Claude session" },
    { command: "history", description: "Show last 10 turns of current session" },
    { command: "sync", description: "Toggle auto-sync notifications" },
  ];
  await setMyCommands(config, commands);
}

function saveChatId(sessionsFile: string, chatId: number): void {
  let lines = readEnvLines(sessionsFile);
  lines = lines.filter((l) => !l.trim().startsWith("REMOTECODE_CHAT_ID="));
  lines.push(`REMOTECODE_CHAT_ID=${chatId}`);
  writeEnvLines(sessionsFile, lines);
}

async function processUpdate(update: Update, ctx: HandlerContext): Promise<void> {
  try {
    const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
    if (chatId) saveChatId(ctx.sessionsFile, chatId);

    const from = update.message?.from || update.callback_query?.from;
    const msg = update.message;
    const content = msg?.text
      ? `text="${msg.text}"`
      : msg?.voice ? `voice ${msg.voice.duration || 0}s`
      : msg?.audio ? `audio "${msg.audio.file_name || "unknown"}"`
      : msg?.photo ? `photo${msg.caption ? ` "${msg.caption}"` : ""}`
      : msg?.document ? `document "${msg.document.file_name || "unknown"}"`
      : update.callback_query ? `callback "${update.callback_query.data || ""}"`
      : "unknown";
    logger.info("poll", `Update ${update.update_id} from=${from?.username || from?.id || "unknown"} ${content}`);
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, ctx);
    } else if (update.message) {
      await handleMessage(update.message, ctx);
    }
  } catch (err) {
    const errMsg = errorMessage(err);
    logger.error("poll", `Error processing update ${update.update_id}: ${errMsg}`);
    const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
    if (chatId) {
      try {
        await sendMessage(ctx.telegram, chatId, `Error: ${errMsg}`);
      } catch { /* ignore send failure */ }
    }
  }
}

async function pollLoop(telegramConfig: TelegramConfig, ctx: HandlerContext): Promise<void> {
  let offset = 0;
  let conflictCount = 0;
  const MAX_CONFLICT_RETRIES = 3;
  logger.info("poll", "Polling for updates...");

  while (true) {
    try {
      const updates = await getUpdates(telegramConfig, offset, 30);
      conflictCount = 0; // reset on success
      for (const update of updates) {
        offset = update.update_id + 1;
        processUpdate(update, ctx).catch((err) => {
          logger.error("poll", `Unhandled error: ${errorMessage(err)}`);
        });
      }
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("409")) {
        conflictCount++;
        logger.warn("poll", `Conflict detected (${conflictCount}/${MAX_CONFLICT_RETRIES}): another bot instance is polling.`);

        if (conflictCount >= MAX_CONFLICT_RETRIES) {
          logger.error("poll", "Max conflict retries reached. Notifying user and shutting down.");
          try {
            const chatId = Number(readKvFile(ctx.sessionsFile).REMOTECODE_CHAT_ID);
            if (chatId) {
              await sendMessage(telegramConfig, chatId,
                "⚠️ Another RemoteCode instance is already running with the same bot token.\n\n" +
                "This instance failed to start due to a polling conflict.\n" +
                "Please stop the other instance first, then run:\n" +
                "remotecode restart",
              );
            }
          } catch {
            // best-effort: chat ID may not exist yet
          }
          removePid();
          process.exit(1);
        }

        try {
          await deleteWebhook(telegramConfig);
        } catch {
          // ignore
        }
      } else {
        logger.error("poll", `Polling error: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

export function isPrivileged(): boolean {
  return process.getuid?.() === 0 || !!process.env.SUDO_USER;
}

// ---------- Daemon main ----------
export async function daemonMain(): Promise<void> {
  ensureConfigDir();
  setupLogging();
  writePid();

  const cfgPath = loadConfig();
  if (cfgPath) logger.info("config", `Loaded: ${cfgPath}`);
  const config = getConfig();

  if (config.yolo && isPrivileged()) {
    logger.error("daemon", "YOLO mode cannot run with root/sudo privileges (Claude Code restriction).");
    logger.error("daemon", "Either switch to a non-root user or set REMOTECODE_YOLO=false in config.");
    removePid();
    process.exit(1);
  }
  const telegramConfig: TelegramConfig = { botToken: config.botToken };

  logger.info("daemon", "RemoteCode daemon starting...");
  if (config.verbose) logger.info("daemon", "Verbose logging enabled");

  try {
    await deleteWebhook(telegramConfig);
    logger.debug("daemon", "Webhook cleared for long polling");
  } catch (err) {
    logger.warn("daemon", `Failed to clear webhook: ${errorMessage(err)}`);
  }

  try {
    await registerCommands(telegramConfig);
    logger.debug("daemon", "Bot commands registered");
  } catch (err) {
    logger.warn("daemon", `Failed to register bot commands: ${errorMessage(err)}`);
  }

  const sessionsFile = sessionsFilePath();
  const ctx: HandlerContext = {
    telegram: telegramConfig,
    sessionsFile,
    allowedIds: config.allowedUsers.ids,
    allowedNames: config.allowedUsers.usernames,
    yolo: config.yolo,
  };

  logger.info("daemon", "RemoteCode daemon ready.");
  startWatcher(telegramConfig, sessionsFile);
  startUpdateChecker();

  const shutdown = () => {
    stopWatcher();
    stopUpdateChecker();
    removePid();
    logger.info("daemon", "Daemon shutting down...");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await pollLoop(telegramConfig, ctx);
}

// ---------- Daemon spawn ----------
export async function spawnDaemon(): Promise<void> {
  const logPath = logFilePath();
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "--daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  fs.closeSync(logFd);

  const childPid = child.pid;
  if (!childPid) {
    console.error("Failed to spawn daemon.");
    process.exit(1);
  }

  // Wait a moment and verify the daemon is still running
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (isRunning(childPid)) {
    console.log(`  Daemon running in background (pid ${childPid})\n`);
  } else {
    console.error("  Daemon exited immediately. Check logs:");
    console.error(`  ${logPath}\n`);
    process.exit(1);
  }
}
