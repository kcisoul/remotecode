import * as fs from "fs";
import { execSync } from "child_process";
import { input } from "@inquirer/prompts";
import axios from "axios";
import { whisperModelDir, whisperModelPath } from "./config";
import { printBanner, stopBannerResize } from "./banner";
import { errorMessage } from "./logger";

const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

const WHISPER_CLI_NAMES = ["whisper-cli", "whisper-cpp", "whisper"];

export interface SttStatus {
  whisperCli: string | null;
  ffmpeg: string | null;
  model: string | null;
}

function whichCmd(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { stdio: "pipe" }).toString().trim() || null;
  } catch {
    return null;
  }
}

function findWhisperCli(): string | null {
  for (const name of WHISPER_CLI_NAMES) {
    const found = whichCmd(name);
    if (found) return found;
  }
  return null;
}

interface PkgManager {
  name: string;
  whisperCmd: string;
  ffmpegCmd: string;
}

function detectPkgManager(): PkgManager | null {
  if (whichCmd("brew")) return { name: "brew", whisperCmd: "brew install whisper-cpp", ffmpegCmd: "brew install ffmpeg" };
  if (whichCmd("apt-get")) return { name: "apt", whisperCmd: "sudo apt-get install -y whisper.cpp", ffmpegCmd: "sudo apt-get install -y ffmpeg" };
  if (whichCmd("dnf")) return { name: "dnf", whisperCmd: "sudo dnf install -y whisper-cpp", ffmpegCmd: "sudo dnf install -y ffmpeg" };
  if (whichCmd("yum")) return { name: "yum", whisperCmd: "sudo yum install -y whisper-cpp", ffmpegCmd: "sudo yum install -y ffmpeg" };
  if (whichCmd("pacman")) return { name: "pacman", whisperCmd: "sudo pacman -S --noconfirm whisper.cpp", ffmpegCmd: "sudo pacman -S --noconfirm ffmpeg" };
  if (whichCmd("apk")) return { name: "apk", whisperCmd: "apk add whisper-cpp", ffmpegCmd: "apk add ffmpeg" };
  return null;
}

export function checkSttStatus(): SttStatus {
  const modelPath = whisperModelPath();
  return {
    whisperCli: findWhisperCli(),
    ffmpeg: whichCmd("ffmpeg"),
    model: fs.existsSync(modelPath) ? modelPath : null,
  };
}

export function isSttReady(): boolean {
  const s = checkSttStatus();
  return !!(s.whisperCli && s.ffmpeg && s.model);
}

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function getSttSummary(): string {
  if (!isMacOS()) return "not supported (macOS only)";
  const s = checkSttStatus();
  if (s.whisperCli && s.ffmpeg && s.model) return "enabled";
  const missing: string[] = [];
  if (!s.whisperCli) missing.push("whisper-cli");
  if (!s.ffmpeg) missing.push("ffmpeg");
  if (!s.model) missing.push("model");
  return `not configured (missing: ${missing.join(", ")})`;
}

export function getSttDetailLines(): string[] {
  const s = checkSttStatus();
  if (!(s.whisperCli && s.ffmpeg && s.model)) return [];
  return [
    "--- STT",
    "whisper: " + s.whisperCli,
    "ffmpeg:  " + s.ffmpeg,
    "model:   " + s.model,
  ];
}

export async function cmdSetupStt(): Promise<void> {
  if (!isMacOS()) {
    console.log("STT is currently only supported on macOS.");
    return;
  }

  const status = checkSttStatus();

  if (status.whisperCli && status.ffmpeg && status.model) {
    printBanner([
      "STT is already enabled.",
      "",
      "  whisper: " + status.whisperCli,
      "  ffmpeg:  " + status.ffmpeg,
      "  model:   " + status.model,
    ]);
    return;
  }

  printBanner(["Setup STT (Speech-to-Text)"]);
  stopBannerResize();

  const pkg = detectPkgManager();

  const missing: string[] = [];
  if (!status.whisperCli) missing.push(`whisper-cli  (${pkg ? pkg.whisperCmd : "install whisper.cpp manually"})`);
  if (!status.ffmpeg) missing.push(`ffmpeg       (${pkg ? pkg.ffmpegCmd : "install ffmpeg manually"})`);
  if (!status.model) missing.push("ggml-small.bin (download from HuggingFace)");

  console.log("Missing components:");
  for (const m of missing) console.log(`  - ${m}`);
  console.log();

  const confirm = await input({
    message: "Install missing components? (Y/n)",
    default: "Y",
  });
  if (confirm.trim().toLowerCase() === "n") {
    console.log("Aborted.");
    return;
  }

  // Install whisper-cli
  if (!status.whisperCli) {
    if (!pkg) {
      console.error("No supported package manager found. Install whisper.cpp manually and ensure whisper-cli is in PATH.");
      return;
    }
    console.log(`\nInstalling whisper-cpp via ${pkg.name}...`);
    try {
      execSync(pkg.whisperCmd, { stdio: "inherit" });
      console.log("whisper-cli installed.");
    } catch {
      console.error(`Failed to install whisper-cpp. Install it manually: ${pkg.whisperCmd}`);
      return;
    }
  }

  // Install ffmpeg
  if (!status.ffmpeg) {
    if (!pkg) {
      console.error("No supported package manager found. Install ffmpeg manually.");
      return;
    }
    console.log(`\nInstalling ffmpeg via ${pkg.name}...`);
    try {
      execSync(pkg.ffmpegCmd, { stdio: "inherit" });
      console.log("ffmpeg installed.");
    } catch {
      console.error(`Failed to install ffmpeg. Install it manually: ${pkg.ffmpegCmd}`);
      return;
    }
  }

  // Download model
  if (!status.model) {
    const modelDir = whisperModelDir();
    fs.mkdirSync(modelDir, { recursive: true });
    const modelPath = whisperModelPath();
    const tmpPath = modelPath + ".tmp";

    console.log("\nDownloading ggml-small.bin...");
    try {
      const response = await axios.get(MODEL_URL, { responseType: "stream" });
      const contentLength = parseInt(response.headers["content-length"] || "0", 10);
      const writer = fs.createWriteStream(tmpPath);

      let downloaded = 0;
      response.data.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (contentLength > 0) {
          const pct = Math.floor((downloaded / contentLength) * 100);
          process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
        }
      });

      response.data.pipe(writer);
      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      console.log();

      fs.renameSync(tmpPath, modelPath);
      console.log(`Model saved to ${modelPath}`);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      console.error(`Failed to download model: ${errorMessage(err)}`);
      return;
    }
  }

  console.log("\nSTT enabled. Send a voice message to your bot!");
}
