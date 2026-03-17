import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { printBanner } from "./banner";

const IS_MACOS = os.platform() === "darwin";
const IS_WINDOWS = os.platform() === "win32";
const IS_LINUX = os.platform() === "linux";

export async function cmdEnable(): Promise<void> {
  const exePath = getRemotecodePath();
  if (!exePath) {
    console.error("Error: Could not find 'remotecode' executable path.");
    process.exit(1);
  }

  if (IS_MACOS) {
    enableMacOS(exePath);
  } else if (IS_WINDOWS) {
    enableWindows(exePath);
  } else if (IS_LINUX) {
    enableLinux(exePath);
  } else {
    console.error(`Auto-start is not supported on ${os.platform()}.`);
    process.exit(1);
  }
}

export async function cmdDisable(): Promise<void> {
  if (IS_MACOS) {
    disableMacOS();
  } else if (IS_WINDOWS) {
    disableWindows();
  } else if (IS_LINUX) {
    disableLinux();
  } else {
    console.error(`Auto-start is not supported on ${os.platform()}.`);
    process.exit(1);
  }
}

function getRemotecodePath(): string | null {
  try {
    // If it's a global npm install, 'which remotecode' should work
    const which = execSync(IS_WINDOWS ? "where remotecode" : "which remotecode", { stdio: "pipe" }).toString().trim();
    if (which) return which.split("\n")[0].trim();
  } catch {
    // Fallback: check if we are running via node and the script path
    if (process.argv[1] && fs.existsSync(process.argv[1])) {
        return `${process.argv[0]} ${process.argv[1]}`;
    }
  }
  return null;
}

// ---------- macOS ----------
const MACOS_PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", "com.kcisoul.remotecode.plist");

function enableMacOS(exePath: string) {
  // If exePath contains spaces and it's not already multiple arguments, it might need to be split
  // However, if it's "node /path/to/script.js", we want both as separate strings.
  // A simple split by space is risky but for most cases works.
  // Better: if it's just a path, one string. If it's node + path, two strings.
  const args = exePath.startsWith(process.argv[0]) ? [process.argv[0], process.argv[1]] : [exePath];

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kcisoul.remotecode</string>
    <key>ProgramArguments</key>
    <array>
        ${args.map(arg => `<string>${arg}</string>`).join("\n        ")}
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>`;

  fs.mkdirSync(path.dirname(MACOS_PLIST_PATH), { recursive: true });
  fs.writeFileSync(MACOS_PLIST_PATH, plistContent);
  try {
    // Unload first just in case
    try { execSync(`launchctl unload "${MACOS_PLIST_PATH}"`, { stdio: "pipe" }); } catch { /* ignore */ }
    execSync(`launchctl load "${MACOS_PLIST_PATH}"`, { stdio: "inherit" });
    printBanner(["Auto-start enabled (macOS LaunchAgent)."]);
  } catch (e) {
    console.error("Failed to load LaunchAgent.");
  }
}

function disableMacOS() {
  if (fs.existsSync(MACOS_PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${MACOS_PLIST_PATH}"`, { stdio: "inherit" });
    } catch { /* ignore */ }
    fs.unlinkSync(MACOS_PLIST_PATH);
    printBanner(["Auto-start disabled."]);
  } else {
    console.log("Auto-start is not enabled.");
  }
}

// ---------- Windows ----------
function enableWindows(exePath: string) {
  // On Windows, if exePath has spaces, it MUST be quoted.
  // If it's "node script.js", it should be "\"C:\...\node.exe\" \"C:\...\script.js\""
  const formattedPath = exePath.startsWith(process.argv[0]) 
    ? `\\"${process.argv[0]}\\" \\"${process.argv[1]}\\"`
    : `\\"${exePath}\\"`;
  
  const regCommand = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "RemoteCode" /t REG_SZ /d "${formattedPath} start" /f`;
  try {
    execSync(regCommand, { stdio: "inherit" });
    printBanner(["Auto-start enabled (Windows Registry)."]);
  } catch (e) {
    console.error("Failed to update Windows Registry.");
  }
}

function disableWindows() {
  const regCommand = `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "RemoteCode" /f`;
  try {
    execSync(regCommand, { stdio: "inherit" });
    printBanner(["Auto-start disabled."]);
  } catch (e) {
    console.log("Auto-start is not enabled.");
  }
}

// ---------- Linux ----------
const LINUX_SERVICE_PATH = path.join(os.homedir(), ".config", "systemd", "user", "remotecode.service");

function enableLinux(exePath: string) {
    // systemd ExecStart wants full path and arguments
    const formattedPath = exePath.startsWith(process.argv[0])
        ? `"${process.argv[0]}" "${process.argv[1]}"`
        : `"${exePath}"`;

    const serviceContent = `[Unit]
Description=RemoteCode Daemon
After=network.target

[Service]
Type=simple
ExecStart=${formattedPath} start
Restart=on-failure

[Install]
WantedBy=default.target
`;

  fs.mkdirSync(path.dirname(LINUX_SERVICE_PATH), { recursive: true });
  fs.writeFileSync(LINUX_SERVICE_PATH, serviceContent);
  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync("systemctl --user enable remotecode", { stdio: "inherit" });
    printBanner(["Auto-start enabled (systemd user unit)."]);
  } catch (e) {
    console.error("Failed to enable systemd service.");
  }
}

function disableLinux() {
  if (fs.existsSync(LINUX_SERVICE_PATH)) {
    try {
      execSync("systemctl --user disable remotecode", { stdio: "inherit" });
    } catch { /* ignore */ }
    fs.unlinkSync(LINUX_SERVICE_PATH);
    try {
        execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    } catch { /* ignore */ }
    printBanner(["Auto-start disabled."]);
  } else {
    console.log("Auto-start is not enabled.");
  }
}
