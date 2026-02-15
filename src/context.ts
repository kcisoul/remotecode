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

// ---------- session locks ----------
const sessionLocks = new Map<string, Promise<void>>();
export const activeCalls = new Set<string>();

export function withSessionLock<T>(lockId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(lockId) || Promise.resolve();
  const next = prev.then(
    () => { activeCalls.add(lockId); return fn(); },
    () => { activeCalls.add(lockId); return fn(); },
  ).finally(() => { activeCalls.delete(lockId); });
  sessionLocks.set(lockId, next.then(() => {}, () => {}));
  return next;
}
