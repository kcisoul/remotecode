import * as fs from "fs";
import { execSync } from "child_process";
import { input } from "@inquirer/prompts";
import axios from "axios";
import { whisperModelDir, whisperModelPath } from "./config";
import { printBanner, stopBannerResize } from "./banner";
import { errorMessage } from "./logger";

const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

export interface SttStatus {
  whisperCli: string | null;
  ffmpeg: string | null;
  model: string | null;
}

export function checkSttStatus(): SttStatus {
  const which = (cmd: string): string | null => {
    try {
      return execSync(`which ${cmd}`, { stdio: "pipe" }).toString().trim() || null;
    } catch {
      return null;
    }
  };

  const modelPath = whisperModelPath();
  return {
    whisperCli: which("whisper-cli"),
    ffmpeg: which("ffmpeg"),
    model: fs.existsSync(modelPath) ? modelPath : null,
  };
}

export function isSttReady(): boolean {
  const s = checkSttStatus();
  return !!(s.whisperCli && s.ffmpeg && s.model);
}

export function getSttSummary(): string {
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

  const missing: string[] = [];
  if (!status.whisperCli) missing.push("whisper-cli  (brew install whisper-cpp)");
  if (!status.ffmpeg) missing.push("ffmpeg       (brew install ffmpeg)");
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
    console.log("\nInstalling whisper-cpp...");
    try {
      execSync("brew install whisper-cpp", { stdio: "inherit" });
      console.log("whisper-cli installed.");
    } catch {
      console.error("Failed to install whisper-cpp. Install it manually: brew install whisper-cpp");
      return;
    }
  }

  // Install ffmpeg
  if (!status.ffmpeg) {
    console.log("\nInstalling ffmpeg...");
    try {
      execSync("brew install ffmpeg", { stdio: "inherit" });
      console.log("ffmpeg installed.");
    } catch {
      console.error("Failed to install ffmpeg. Install it manually: brew install ffmpeg");
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
