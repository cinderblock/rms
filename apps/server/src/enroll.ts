import { EnrollRequest, type EnrollError, type EnrollResponse } from "@rmd/protocol";

import { type Db, SettingKey, getSetting } from "./db.ts";
import { checkEnrollmentAllowed, recordAttempt } from "./ratelimit.ts";
import { verifyPassphrase } from "./secrets.ts";

/**
 * `POST /api/enroll` — a machine joining the fleet.
 *
 * One round trip, so that installing on a machine you're standing at is
 * "install, type passphrase, done". The client has already generated its
 * keypair; the private half never leaves the host, and this endpoint only ever
 * sees the public half.
 */

export type EnrollOutcome =
  | { status: 200; body: EnrollResponse }
  | { status: 400 | 401 | 403 | 409 | 429 | 503; body: EnrollError };

export async function handleEnroll(
  db: Db,
  rawBody: unknown,
  ip: string,
  now: number,
): Promise<EnrollOutcome> {
  // Check the budget before touching argon2id. Verification is deliberately
  // expensive, so an unthrottled attacker could exhaust the CPU without ever
  // guessing anything.
  const decision = checkEnrollmentAllowed(db, ip, now);
  if (!decision.allowed) {
    if (decision.reason === "enrollment_closed") {
      recordAttempt(db, ip, now, false, "enrollment_closed");
      return {
        status: 403,
        body: { error: "enrollment_closed", message: "Enrollment is currently closed." },
      };
    }
    // Not recorded as a failure: it never reached the passphrase check, and
    // counting it would let a blocked caller extend their own lockout forever.
    return {
      status: 429,
      body: {
        error: "rate_limited",
        message: "Too many enrollment attempts.",
        retryAfter: decision.retryAfter,
      },
    };
  }

  const parsed = EnrollRequest.safeParse(rawBody);
  if (!parsed.success) {
    recordAttempt(db, ip, now, false, "invalid_request");
    return {
      status: 400,
      body: { error: "invalid_request", message: "Malformed enrollment request." },
    };
  }
  const { publicKey, passphrase, identity } = parsed.data;

  const hash = getSetting(db, SettingKey.EnrollmentPassphraseHash);
  if (hash === null) {
    recordAttempt(db, ip, now, false, "enrollment_closed");
    return {
      status: 503,
      body: { error: "enrollment_closed", message: "Server is not configured for enrollment." },
    };
  }

  if (!(await verifyPassphrase(passphrase, hash))) {
    recordAttempt(db, ip, now, false, "invalid_passphrase");
    // Says nothing about how wrong the passphrase was.
    return {
      status: 401,
      body: { error: "invalid_passphrase", message: "Enrollment passphrase is not valid." },
    };
  }

  // A retried request — the network dropped the response, most likely — must not
  // mint a second record for a device that is already enrolled.
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM devices WHERE public_key = ?")
    .get(publicKey);
  if (existing) {
    recordAttempt(db, ip, now, false, "already_enrolled");
    return {
      status: 409,
      body: { error: "already_enrolled", message: "This device key is already enrolled." },
    };
  }

  // A machine_id match means "this looks like a machine I already know" — a
  // reinstall, usually. It is recorded for a human to merge or delete, and never
  // acted on automatically: machine_id is client-asserted, so auto-replacing the
  // existing record would hand device takeover to anyone holding the passphrase.
  const priorId = identity.machineId
    ? (db
        .query<
          { id: string },
          [string]
        >("SELECT id FROM devices WHERE machine_id = ? ORDER BY enrolled_at DESC LIMIT 1")
        .get(identity.machineId)?.id ?? null)
    : null;

  const deviceId = crypto.randomUUID();

  db.query<
    never,
    [string, string, string, string, string | null, string | null, number, string]
  >(
    `INSERT INTO devices
       (id, public_key, display_name, identity, machine_id,
        probable_reenrollment_of, enrolled_at, enrolled_from_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    deviceId,
    publicKey,
    identity.hostname,
    JSON.stringify(identity),
    identity.machineId ?? null,
    priorId,
    now,
    ip,
  );

  recordAttempt(db, ip, now, true, null);

  return {
    status: 200,
    body: {
      deviceId,
      displayName: identity.hostname,
      serverName: getSetting(db, SettingKey.ServerName) ?? "control",
      probableReenrollmentOf: priorId,
    },
  };
}
