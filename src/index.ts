#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { ensureConfigDir, loadConfig, getConfig, globalConfigDir } from "./config";
import { printBanner, stopBannerResize } from "./banner";
import { errorMessage } from "./logger";
import { runSetupIfNeeded } from "./setup";
import { cmdSetupStt } from "./stt";
import { daemonMain, isDaemonRunning, spawnDaemon } from "./daemon";
import { cmdStart, cmdStop, cmdRestart, cmdStatus, cmdLogs, cmdConfig } from "./cli";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Internal flag: run as daemon process
  if (args.includes("--daemon")) {
    await daemonMain();
    return;
  }

  // Verbose flag
  if (args.includes("-v") || args.includes("--verbose")) {
    process.env.REMOTECODE_VERBOSE = "1";
  }

  const command = args.find((a) => !a.startsWith("-")) || "";

  switch (command) {
    case "start":
      await cmdStart();
      break;

    case "stop":
      await cmdStop();
      break;

    case "restart":
      await cmdRestart();
      break;

    case "status":
      cmdStatus();
      break;

    case "logs": {
      const levelIdx = args.indexOf("--level");
      const tagIdx = args.indexOf("--tag");
      const nIdx = args.indexOf("-n");
      let lines = 50;
      let follow = true;
      if (nIdx !== -1 && args[nIdx + 1]) {
        const n = parseInt(args[nIdx + 1], 10);
        if (!isNaN(n) && n > 0) lines = n;
        follow = false; // -n implies static output
      }
      cmdLogs({
        follow,
        lines,
        level: levelIdx !== -1 ? (args[levelIdx + 1] || "").toUpperCase() : null,
        tag: tagIdx !== -1 ? (args[tagIdx + 1] || "") : null,
      });
      break;
    }

    case "config":
      await cmdConfig();
      break;

    case "setup-stt":
      await cmdSetupStt();
      break;

    case "": {
      // Default: first run -> setup + start; already running -> status; not running -> start
      ensureConfigDir();
      const configPath = path.join(globalConfigDir(), "config");
      const isFirstRun = !fs.existsSync(configPath);

      if (isFirstRun) {
        await runSetupIfNeeded();
        stopBannerResize();
        loadConfig();
        getConfig();
        await spawnDaemon();
        cmdStatus();
        cmdLogs({ follow: true, lines: 10, level: null, tag: null });
      } else {
        const { running } = isDaemonRunning();
        if (running) {
          cmdStatus();
        } else {
          const cfgPath = loadConfig();
          getConfig();
          if (cfgPath) printBanner(["Config: " + cfgPath]);
          await spawnDaemon();
          cmdStatus();
          cmdLogs({ follow: true, lines: 10, level: null, tag: null });
        }
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log("Usage: remotecode [start|stop|restart|status|logs|config|setup-stt]");
      process.exit(1);
  }
}

main().catch((err) => {
  // User cancelled with Ctrl+C -- exit silently
  if (errorMessage(err).includes("User force closed the prompt")) {
    process.exit(0);
  }
  console.error(`Fatal error: ${errorMessage(err)}`);
  process.exit(1);
});
