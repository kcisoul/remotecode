import { TelegramConfig } from "./telegram";

export interface HandlerContext {
  telegram: TelegramConfig;
  sessionsFile: string;
  allowedIds: Set<number>;
  allowedNames: Set<string>;
  yolo: boolean;
}

export function isUserAllowed(
  userId?: number,
  username?: string,
  allowedIds?: Set<number>,
  allowedNames?: Set<string>
): boolean {
  if (userId !== undefined && allowedIds?.has(userId)) return true;
  if (username && allowedNames?.has(username.toLowerCase())) return true;
  return false;
}

// ---------- active query tracking (for watcher guard) ----------
export const activeQueries = new Set<string>();
