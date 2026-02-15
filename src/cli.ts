import * as fs from "fs";
import * as path from "path";
import { loadConfig, getConfig, ensureConfigDir, globalConfigDir, pidFilePath, logFilePath, sessionsFilePath } from "./config";
import { printBanner, stopBannerResize } from "./banner";
import { formatTimeAgo } from "./session-ui";
import { loadActiveSessionId, loadSessionCwd, findSession } from "./sessions";
import { runSetupIfNeeded, runConfigEditor } from "./setup";
import { getSttSummary, getSttDetailLines } from "./stt";
import { isDaemonRunning, killOrphanDaemons, spawnDaemon } from "./daemon";

// ---------- Subcommands ----------
export async function cmdStart(): Promise<void> {
  const { running, pid } = isDaemonRunning();
  if (running) {
    printBanner(["Already running (pid " + pid + ").", "Use 'remotecode restart' to restart."]);
    process.exit(1);
  }
  // runSetupIfNeeded prints its own banner on first run
  const needsSetup = !fs.existsSync(path.join(globalConfigDir(), "config"));
  await runSetupIfNeeded();
  stopBannerResize();
  const configPath = loadConfig();
  getConfig();
  if (!needsSetup && configPath) printBanner(["Config: " + configPath]);
  killOrphanDaemons();
  await spawnDaemon();
  cmdStatus();
  cmdLogs({ follow: true, lines: 10, level: null, tag: null });
}

export async function cmdStop(): Promise<void> {
  const { running, pid } = isDaemonRunning();
  if (!running || pid === null) {
    // PID file missing -- try to kill orphans
    killOrphanDaemons();
    return;
  }
  process.kill(pid, "SIGTERM");
  // Wait for process to exit
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await isStillRunning(pid))) {
      console.log(`RemoteCode stopped (pid ${pid}).`);
      killOrphanDaemons(); // clean up any other orphans
      return;
    }
  }
  console.error(`Process ${pid} did not exit in time. Sending SIGKILL...`);
  try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  killOrphanDaemons();
  console.log("RemoteCode killed.");
}

function isStillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cmdRestart(): Promise<void> {
  const { running } = isDaemonRunning();
  if (running) {
    await cmdStop();
  }
  await cmdStart();
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function cmdStatus(): void {
  const { running, pid } = isDaemonRunning();
  if (!running || pid === null) {
    printBanner([
      "Status:  not running",
      "STT:     " + getSttSummary(),
      ...getSttDetailLines(),
      "--- Commands",
      "start              Start the daemon",
      "stop               Stop the daemon",
      "restart            Restart the daemon",
      "status             Show status",
      "logs               Follow logs (default: -f)",
      "  -n N             Show last N lines (static)",
      "  --level LEVEL    Filter by DEBUG|INFO|WARN|ERROR",
      "  --tag TAG        Filter by component tag",
      "config             Edit configuration",
      "setup-stt          Setup STT (speech-to-text)",
    ]);
    return;
  }

  let uptime = "unknown";
  try {
    const pidStat = fs.statSync(pidFilePath());
    uptime = formatUptime(Date.now() - pidStat.mtimeMs);
  } catch { /* ignore */ }

  const sessionsFile = sessionsFilePath();
  const activeId = loadActiveSessionId(sessionsFile);
  const session = activeId ? findSession(activeId) : null;

  const sessionLines: string[] = [];
  if (session) {
    const label = session.projectName + (session.slug ? ` (${session.slug})` : "");
    sessionLines.push("Session: " + label);
    sessionLines.push("CWD:     " + session.project);
    const lastMsg = session.lastMessage || session.firstMessage;
    if (lastMsg) {
      const preview = lastMsg.length > 50 ? lastMsg.slice(0, 47) + "..." : lastMsg;
      sessionLines.push("Last:    " + preview + " (" + formatTimeAgo(session.lastModified) + ")");
    }
  } else if (activeId) {
    sessionLines.push("Session: new (awaiting first message)");
    const cwd = loadSessionCwd(sessionsFile);
    if (cwd) sessionLines.push("CWD:     " + cwd);
  } else {
    sessionLines.push("Session: none");
  }

  printBanner([
    "Status:  running (pid " + pid + ")",
    "Uptime:  " + uptime,
    "Log:     " + logFilePath(),
    "STT:     " + getSttSummary(),
    ...getSttDetailLines(),
    "--- Session",
    ...sessionLines,
    "--- Commands",
    "start              Start the daemon",
    "stop               Stop the daemon",
    "restart            Restart the daemon",
    "status             Show status",
    "logs               Follow logs (default: -f)",
    "  -n N             Show last N lines (static)",
    "  --level LEVEL    Filter by DEBUG|INFO|WARN|ERROR",
    "  --tag TAG        Filter by component tag",
    "config             Edit configuration",
    "setup-stt          Setup STT (speech-to-text)",
  ]);
}

// ---------- Log viewer ----------
const LOG_LINE_RE = /^(\S+)\s+\[(DEBUG|INFO|WARN|ERROR)\](\[\w+\])\s+(.*)$/;

function colorizeLine(line: string): string {
  if (!process.stdout.isTTY) return line;
  const m = line.match(LOG_LINE_RE);
  if (!m) return line;
  const [, ts, level, tag, msg] = m;
  const dim = "\x1b[2m";
  const r = "\x1b[0m";
  const levelColors: Record<string, string> = {
    DEBUG: "\x1b[2m",       // dim
    INFO:  "\x1b[36m",      // cyan
    WARN:  "\x1b[33m",      // yellow
    ERROR: "\x1b[31m",      // red
  };
  const lc = levelColors[level] || "";
  return `${dim}${ts}${r} ${lc}[${level}]${r}${dim}${tag}${r} ${msg}`;
}

interface LogsOptions {
  lines: number;
  follow: boolean;
  level: string | null;
  tag: string | null;
}

function matchesFilter(line: string, opts: LogsOptions): boolean {
  if (!opts.level && !opts.tag) return true;
  const m = line.match(LOG_LINE_RE);
  if (!m) return !opts.level && !opts.tag; // non-structured lines: show only if no filters
  if (opts.level && m[2].toUpperCase() !== opts.level) return false;
  if (opts.tag && m[3] !== `[${opts.tag}]`) return false;
  return true;
}

export function cmdLogs(opts: LogsOptions): void {
  const logPath = logFilePath();
  if (!fs.existsSync(logPath)) {
    console.log("No log file found.");
    return;
  }

  if (!opts.follow) {
    // Static: read last N matching lines
    const allLines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    const filtered = allLines.filter((l) => matchesFilter(l, opts));
    const tail = filtered.slice(-opts.lines);
    for (const line of tail) console.log(colorizeLine(line));
    return;
  }

  // Follow mode: dump last N matching lines, then tail
  const allLines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
  const filtered = allLines.filter((l) => matchesFilter(l, opts));
  const initial = filtered.slice(-opts.lines);
  for (const line of initial) console.log(colorizeLine(line));

  // Watch for new data
  let offset = fs.statSync(logPath).size;
  let lineBuf = "";

  const watcher = fs.watch(logPath, () => {
    let size: number;
    try { size = fs.statSync(logPath).size; } catch { return; }
    if (size <= offset) { offset = size; return; } // file was truncated/rotated
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(logPath, "r");
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    const raw = lineBuf + buf.toString("utf-8");
    const lines = raw.split("\n");
    lineBuf = lines.pop() || "";
    for (const line of lines) {
      if (line && matchesFilter(line, opts)) console.log(colorizeLine(line));
    }
  });

  process.on("SIGINT", () => { watcher.close(); process.exit(0); });
  process.on("SIGTERM", () => { watcher.close(); process.exit(0); });
}

export async function cmdConfig(): Promise<void> {
  await runConfigEditor();
  const { running } = isDaemonRunning();
  if (running) {
    await cmdStop();
  }
  loadConfig();
  getConfig();
  await spawnDaemon();
  cmdStatus();
  cmdLogs({ follow: true, lines: 10, level: null, tag: null });
}
