export function parseTruthyEnv(val: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    (val || "").trim().toLowerCase()
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isVerbose(): boolean {
  return parseTruthyEnv(process.env.REMOTECODE_VERBOSE);
}

function formatTag(tag: string): string {
  return `[${tag}]`;
}

function formatLevel(level: string): string {
  return `[${level}]`;
}

export const logger = {
  debug(tag: string, msg: string): void {
    if (isVerbose()) {
      console.log(`${new Date().toISOString()} ${formatLevel("DEBUG")}${formatTag(tag)} ${msg}`);
    }
  },
  info(tag: string, msg: string): void {
    console.log(`${new Date().toISOString()} ${formatLevel("INFO")}${formatTag(tag)} ${msg}`);
  },
  warn(tag: string, msg: string): void {
    console.error(`${new Date().toISOString()} ${formatLevel("WARN")}${formatTag(tag)} ${msg}`);
  },
  error(tag: string, msg: string, err?: unknown): void {
    console.error(`${new Date().toISOString()} ${formatLevel("ERROR")}${formatTag(tag)} ${msg}`);
    if (err && isVerbose()) console.error(err);
  },
};
