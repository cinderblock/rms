import { type Db, SettingKey, getSetting, setSetting } from "./db.ts";

/**
 * Rate limiting for enrollment.
 *
 * The enrollment passphrase is shared, reusable and long-lived. That is a
 * deliberate convenience trade, and this file is most of what pays for it: an
 * unthrottled endpoint guarding a single reusable secret is a brute-force
 * target, so the limiter is load-bearing, not decorative.
 *
 * Two independent budgets:
 *
 *   per-IP    — stops one host hammering the endpoint
 *   global    — stops a distributed attempt from spreading under the per-IP cap
 *
 * Blowing the global budget suspends enrollment for everyone. That is a
 * self-inflicted denial of service if someone attacks you, which is the correct
 * trade here: a suspended enrollment endpoint is an inconvenience, and a
 * guessed passphrase is an attacker in your fleet. The lock expires on its own
 * so you cannot be permanently locked out of your own tooling.
 */

export const PER_IP_MAX_FAILURES = 5;
export const PER_IP_WINDOW_MS = 15 * 60 * 1000;

export const GLOBAL_MAX_FAILURES = 20;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const GLOBAL_LOCK_MS = 60 * 60 * 1000;

/** Attempts older than this are pruned; they inform neither budget. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type LimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited"; retryAfter: number }
  | { allowed: false; reason: "enrollment_closed" };

export function checkEnrollmentAllowed(db: Db, ip: string, now: number): LimitDecision {
  if (getSetting(db, SettingKey.EnrollmentOpen) === "0") {
    return { allowed: false, reason: "enrollment_closed" };
  }

  const lockedUntil = Number(getSetting(db, SettingKey.EnrollmentLockedUntil) ?? 0);
  if (lockedUntil > now) {
    return {
      allowed: false,
      reason: "rate_limited",
      retryAfter: Math.ceil((lockedUntil - now) / 1000),
    };
  }

  const ipFailures = countFailures(db, now - PER_IP_WINDOW_MS, ip);
  if (ipFailures >= PER_IP_MAX_FAILURES) {
    const oldest = oldestFailureAt(db, now - PER_IP_WINDOW_MS, ip);
    // Retry when the oldest failure ages out of the window, not a flat cooldown:
    // this makes the limiter a true sliding window rather than a fixed one that
    // hands an attacker a fresh budget on every boundary.
    const retryAfter = oldest === null ? 60 : Math.max(1, Math.ceil((oldest + PER_IP_WINDOW_MS - now) / 1000));
    return { allowed: false, reason: "rate_limited", retryAfter };
  }

  return { allowed: true };
}

export function recordAttempt(
  db: Db,
  ip: string,
  now: number,
  succeeded: boolean,
  outcome: string | null,
): void {
  db.query<never, [string, number, number, string | null]>(
    "INSERT INTO enrollment_attempts (ip, at, succeeded, outcome) VALUES (?, ?, ?, ?)",
  ).run(ip, now, succeeded ? 1 : 0, outcome);

  if (!succeeded && countFailures(db, now - GLOBAL_WINDOW_MS, null) >= GLOBAL_MAX_FAILURES) {
    setSetting(db, SettingKey.EnrollmentLockedUntil, String(now + GLOBAL_LOCK_MS));
  }

  db.query<never, [number]>("DELETE FROM enrollment_attempts WHERE at < ?").run(now - RETENTION_MS);
}

/** Clears an automatic lockout. The manual on/off switch is left alone. */
export function clearGlobalLock(db: Db): void {
  setSetting(db, SettingKey.EnrollmentLockedUntil, "0");
}

function countFailures(db: Db, since: number, ip: string | null): number {
  const row =
    ip === null
      ? db
          .query<
            { n: number },
            [number]
          >("SELECT COUNT(*) AS n FROM enrollment_attempts WHERE at >= ? AND succeeded = 0")
          .get(since)
      : db
          .query<
            { n: number },
            [number, string]
          >("SELECT COUNT(*) AS n FROM enrollment_attempts WHERE at >= ? AND ip = ? AND succeeded = 0")
          .get(since, ip);
  return row?.n ?? 0;
}

function oldestFailureAt(db: Db, since: number, ip: string): number | null {
  const row = db
    .query<
      { at: number },
      [number, string]
    >("SELECT MIN(at) AS at FROM enrollment_attempts WHERE at >= ? AND ip = ? AND succeeded = 0")
    .get(since, ip);
  return row?.at ?? null;
}
