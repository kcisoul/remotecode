import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------- types ----------

interface SettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

interface CacheEntry {
  mtime: number;
  rules: ParsedRule[];
}

interface ParsedRule {
  kind: "allow" | "deny";
  toolName: string;
  specifier: string | null;   // null = bare tool match (e.g. "Read")
  prefixMatch: boolean;       // true when specifier ends with ":*"
}

// ---------- cache ----------

const cache = new Map<string, CacheEntry>();

function readSettingsFile(filePath: string): ParsedRule[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cache.delete(filePath);
    return [];
  }

  const mtime = stat.mtimeMs;
  const cached = cache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.rules;

  let json: SettingsFile;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    cache.delete(filePath);
    return [];
  }

  const rules: ParsedRule[] = [];
  for (const entry of json.permissions?.deny ?? []) {
    const parsed = parseRule(entry, "deny");
    if (parsed) rules.push(parsed);
  }
  for (const entry of json.permissions?.allow ?? []) {
    const parsed = parseRule(entry, "allow");
    if (parsed) rules.push(parsed);
  }

  cache.set(filePath, { mtime, rules });
  return rules;
}

// ---------- rule parsing ----------

/**
 * Parse a permission rule string like "Read", "Bash(git:*)", "Bash(python3:*)"
 * into a structured form.
 */
function parseRule(raw: string, kind: "allow" | "deny"): ParsedRule | null {
  // Match "Tool(specifier)" format
  const m = raw.match(/^([A-Za-z_]+)\((.+)\)$/);
  if (m) {
    const toolName = m[1];
    let specifier = m[2];
    let prefixMatch = false;
    if (specifier.endsWith(":*")) {
      prefixMatch = true;
      specifier = specifier.slice(0, -2); // remove ":*"
    }
    return { kind, toolName, specifier, prefixMatch };
  }

  // Bare tool name like "Read", "Write"
  if (/^[A-Za-z_]+$/.test(raw)) {
    return { kind, toolName: raw, specifier: null, prefixMatch: false };
  }

  return null;
}

// ---------- rule loading ----------

/**
 * Load all permission rules from CLI settings files.
 * Files checked (in order):
 *   1. ~/.claude/settings.json (global)
 *   2. {cwd}/.claude/settings.json (project shared)
 *   3. {cwd}/.claude/settings.local.json (project local)
 * Later files' rules are appended, so project rules can override global ones.
 */
export function loadPermissionRules(cwd?: string): ParsedRule[] {
  const rules: ParsedRule[] = [];

  // Global settings
  const globalPath = path.join(os.homedir(), ".claude", "settings.json");
  rules.push(...readSettingsFile(globalPath));

  if (cwd) {
    // Project shared settings
    rules.push(...readSettingsFile(path.join(cwd, ".claude", "settings.json")));
    // Project local settings
    rules.push(...readSettingsFile(path.join(cwd, ".claude", "settings.local.json")));
  }

  return rules;
}

// ---------- matching ----------

/**
 * Extract the first "word" (command name) from a Bash command string.
 * Handles leading env vars (FOO=bar cmd ...) and path prefixes.
 */
function extractCommand(command: string): string {
  let cmd = command.trimStart();
  // Skip env var assignments at the start (e.g. "DEBUG=1 python3 ...")
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(cmd)) {
    cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  // Extract first word (the command itself)
  const firstWord = cmd.split(/\s/)[0] || "";
  // Strip path prefix (e.g. /usr/bin/python3 → python3)
  return firstWord.split("/").pop() || firstWord;
}

function matchRule(rule: ParsedRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false;

  // Bare tool match (e.g. "Read" matches all Read tool uses)
  if (rule.specifier === null) return true;

  // Tool with specifier — currently only Bash uses specifiers
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return false;

    if (rule.prefixMatch) {
      // "Bash(git:*)" → command starts with "git"
      const cmdName = extractCommand(command);
      return cmdName === rule.specifier || command.trimStart().startsWith(rule.specifier);
    } else {
      // Exact match: "Bash(git -C /path log)" → command === "git -C /path log"
      return command.trim() === rule.specifier;
    }
  }

  return false;
}

/**
 * Check CLI settings.json permissions for a given tool invocation.
 * @returns "allow" if explicitly allowed, "deny" if explicitly denied, null if no match
 */
export function matchCliPermissions(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): "allow" | "deny" | null {
  const rules = loadPermissionRules(cwd);

  // Check deny rules first (deny takes precedence)
  for (const rule of rules) {
    if (rule.kind === "deny" && matchRule(rule, toolName, input)) {
      return "deny";
    }
  }

  // Then check allow rules
  for (const rule of rules) {
    if (rule.kind === "allow" && matchRule(rule, toolName, input)) {
      return "allow";
    }
  }

  return null;
}
