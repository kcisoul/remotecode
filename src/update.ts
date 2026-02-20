import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { sessionsFilePath, readKvFile, readEnvLines, writeEnvLines } from "./config";
import { logger } from "./logger";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@kcisoul/remotecode/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------- version helpers ----------

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function getCurrentVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------- cache ----------

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

/**
 * Read cached update info from KV file. No network call.
 */
export function getCachedUpdateInfo(): UpdateInfo | null {
  try {
    const kv = readKvFile(sessionsFilePath());
    const latestVersion = kv.REMOTECODE_LATEST_VERSION;
    if (!latestVersion) return null;
    const currentVersion = getCurrentVersion();
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    };
  } catch {
    return null;
  }
}

// ---------- network check ----------

/**
 * Check npm registry for latest version and cache the result.
 * Never throws.
 */
export async function checkForUpdate(force?: boolean): Promise<UpdateInfo | null> {
  try {
    if (!force) {
      const kv = readKvFile(sessionsFilePath());
      const lastCheck = parseInt(kv.REMOTECODE_VERSION_CHECK_TIME || "0", 10);
      if (Date.now() - lastCheck < CHECK_INTERVAL_MS) {
        return getCachedUpdateInfo();
      }
    }

    const resp = await axios.get(NPM_REGISTRY_URL, { timeout: 10000 });
    const latestVersion: string = resp.data?.version;
    if (!latestVersion || typeof latestVersion !== "string") return null;

    // Write cache
    const sessFile = sessionsFilePath();
    let lines = readEnvLines(sessFile);
    lines = lines.filter(
      (l) =>
        !l.trim().startsWith("REMOTECODE_LATEST_VERSION=") &&
        !l.trim().startsWith("REMOTECODE_VERSION_CHECK_TIME="),
    );
    lines.push(`REMOTECODE_LATEST_VERSION=${latestVersion}`);
    lines.push(`REMOTECODE_VERSION_CHECK_TIME=${Date.now()}`);
    writeEnvLines(sessFile, lines);

    const currentVersion = getCurrentVersion();
    const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

    logger.debug("update", `checked: current=${currentVersion} latest=${latestVersion} update=${updateAvailable}`);
    return { currentVersion, latestVersion, updateAvailable };
  } catch (err) {
    logger.debug("update", `check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------- daemon background checker ----------

let updateTimer: ReturnType<typeof setInterval> | null = null;

export function startUpdateChecker(): void {
  // Immediate check on daemon start (no Telegram notification, just cache)
  checkForUpdate();

  // Periodic check every 24 hours
  updateTimer = setInterval(() => {
    checkForUpdate();
  }, CHECK_INTERVAL_MS);
}

export function stopUpdateChecker(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

// ---------- tip for error messages ----------

export function getUpdateTip(): string {
  const info = getCachedUpdateInfo();
  if (!info?.updateAvailable) return "";
  return `\n\nTip: RemoteCode v${info.latestVersion} is available. Run: npm i -g @kcisoul/remotecode`;
}
