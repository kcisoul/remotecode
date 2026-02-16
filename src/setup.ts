import * as fs from "fs";
import { input, confirm } from "@inquirer/prompts";
import { globalConfigPath, ensureConfigDir, readKvFile, writeEnvLines } from "./config";
import { printBanner, stopBannerResize } from "./banner";
import { parseTruthyEnv, errorMessage } from "./logger";
import { getMe } from "./telegram";
import { isSttReady, isMacOS, cmdSetupStt } from "./stt";

async function promptAndValidateToken(defaultToken?: string): Promise<string> {
  while (true) {
    const token = await input({
      message: "TELEGRAM_BOT_TOKEN",
      default: defaultToken || undefined,
      required: true,
      validate: (v) => (v.trim() ? true : "Bot token is required."),
    });
    const trimmed = token.trim();
    try {
      const bot = await getMe({ botToken: trimmed });
      console.log(`\u2713 Bot: @${bot.username} (${bot.first_name})`);
      return trimmed;
    } catch (err) {
      console.log(`\u2717 Invalid token: ${errorMessage(err)}`);
      defaultToken = undefined;
    }
  }
}

async function promptSttSetup(): Promise<void> {
  if (!isMacOS()) return;
  if (!isSttReady()) {
    console.log();
    const setupStt = await confirm({ message: "Setup STT (speech-to-text)?", default: true });
    if (setupStt) {
      await cmdSetupStt();
    }
  }
}

export async function runSetupIfNeeded(): Promise<void> {
  ensureConfigDir();
  const configPath = globalConfigPath();
  if (fs.existsSync(configPath)) return;

  printBanner(["No config found. Let's get started."]);
  stopBannerResize();

  const botToken = await promptAndValidateToken();

  const allowedUsers = await input({
    message: "REMOTECODE_ALLOWED_USERS (comma-separated user IDs or @usernames)",
    required: true,
    validate: (v) => (v.trim() ? true : "At least one user ID or @username is required."),
  });

  console.log("");
  console.log("  YOLO mode:");
  console.log("    Y = All actions run without permission prompts");
  console.log("    N = Actions requiring approval will be pending (currently not supported)");
  console.log("");
  const yolo = await confirm({
    message: "REMOTECODE_YOLO (recommended: Y)",
    default: true,
  });

  const lines: string[] = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `REMOTECODE_ALLOWED_USERS=${allowedUsers.trim()}`,
    `REMOTECODE_YOLO=${yolo ? "true" : "false"}`,
  ];

  writeEnvLines(configPath, lines);
  console.log(`\nConfig saved to ${configPath}`);

  await promptSttSetup();
}

export async function runConfigEditor(): Promise<boolean> {
  ensureConfigDir();
  const configPath = globalConfigPath();
  const current = readKvFile(configPath);

  printBanner(["Config: " + configPath]);
  stopBannerResize();

  const botToken = await promptAndValidateToken(current.TELEGRAM_BOT_TOKEN);

  const allowedUsers = await input({
    message: "REMOTECODE_ALLOWED_USERS",
    default: current.REMOTECODE_ALLOWED_USERS || "",
    required: true,
    validate: (v) => (v.trim() ? true : "At least one user ID or @username is required."),
  });

  console.log("");
  console.log("  YOLO mode:");
  console.log("    Y = All actions run without permission prompts");
  console.log("    N = Actions requiring approval will be pending (currently not supported)");
  console.log("");
  const currentYolo = parseTruthyEnv(current.REMOTECODE_YOLO);
  const yolo = await confirm({
    message: "REMOTECODE_YOLO (recommended: Y)",
    default: currentYolo,
  });

  const lines: string[] = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `REMOTECODE_ALLOWED_USERS=${allowedUsers.trim()}`,
    `REMOTECODE_YOLO=${yolo ? "true" : "false"}`,
  ];

  // Detect changes
  const oldLines = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf-8").trimEnd()
    : "";
  const newContent = lines.join("\n").trimEnd();
  const changed = oldLines !== newContent;

  writeEnvLines(configPath, lines);
  console.log(`\nConfig saved to ${configPath}`);

  await promptSttSetup();

  return changed;
}
