import { z } from "zod";
import { DeviceIdentity } from "./identity.ts";

/**
 * Enrollment: how a machine joins the fleet.
 *
 * The flow is deliberately one round trip, so that installing on a machine you
 * are physically standing at is "install, type passphrase, done" with no detour
 * through the management UI.
 *
 *   client                                   server
 *     │  generate Ed25519 keypair              │
 *     │  (private key never leaves the host)   │
 *     │──── POST /api/enroll ─────────────────▶│  verify passphrase (argon2id)
 *     │     { publicKey, passphrase, identity }│  rate-limit by IP + globally
 *     │                                        │  record pubkey as permanent
 *     │◀─── { deviceId, … } ───────────────────│  flag if it looks like a re-enroll
 *     │  persist deviceId; discard passphrase  │
 *
 * From here on the passphrase is irrelevant to this device: it authenticates by
 * signing a server nonce with its private key. Rotating the passphrase does not
 * disturb devices that already enrolled.
 */

/** Ed25519 public key: 32 raw bytes, base64 — always 44 characters. */
export const PublicKeyB64 = z.base64().length(44);

/** Ed25519 signature: 64 raw bytes, base64 — always 88 characters. */
export const SignatureB64 = z.base64().length(88);

/**
 * Default generated passphrase is six diceware words (~77 bits). An
 * admin-supplied phrase is allowed but must clear this entropy floor — a shared
 * secret that is reused across every machine and never expires has to be strong
 * on its own, because nothing else is protecting it.
 */
export const DEFAULT_PASSPHRASE_WORDS = 6;
export const MIN_PASSPHRASE_ENTROPY_BITS = 60;

export const EnrollRequest = z.object({
  publicKey: PublicKeyB64,
  /**
   * The shared enrollment passphrase. Never logged, never stored, and accepted
   * at this endpoint and nowhere else. It authorizes *joining the fleet* — it is
   * not a command-execution credential.
   */
  passphrase: z.string().min(1).max(512),
  identity: DeviceIdentity,
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  deviceId: z.uuid(),
  /** What the server will call this device until renamed — usually the hostname. */
  displayName: z.string(),
  /** Lets the client confirm it enrolled where it meant to. */
  serverName: z.string(),
  /**
   * Set when an existing device reported the same `machineId`. The server still
   * creates a **new** record; merging is an explicit admin action.
   *
   * Auto-merging here would let anyone holding the passphrase silently take over
   * an existing device's record, since `machineId` is client-asserted.
   */
  probableReenrollmentOf: z.uuid().nullable(),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

export const EnrollErrorCode = z.enum([
  "invalid_request",
  /** Wrong passphrase. Deliberately says nothing about how wrong. */
  "invalid_passphrase",
  /** Enrollment is toggled off, or its open window has expired. */
  "enrollment_closed",
  /** Too many attempts from this IP, or the global failure budget is spent. */
  "rate_limited",
  /** This exact public key is already enrolled — a retried request, most likely. */
  "already_enrolled",
]);
export type EnrollErrorCode = z.infer<typeof EnrollErrorCode>;

export const EnrollError = z.object({
  error: EnrollErrorCode,
  message: z.string(),
  /** Seconds to wait, on `rate_limited`. */
  retryAfter: z.number().int().nonnegative().optional(),
});
export type EnrollError = z.infer<typeof EnrollError>;

/**
 * Session auth, used on every WebSocket connect after enrollment.
 *
 * Challenge–response rather than a bearer token: there is no long-lived secret
 * in flight to intercept, and revoking a device is just deleting its public key.
 */
export const AuthChallenge = z.object({
  /** 32 random bytes, base64. Single-use, short-lived. */
  nonce: z.base64().length(44),
  /** Server clock, so a client can warn about skew rather than fail opaquely. */
  serverTime: z.iso.datetime(),
});
export type AuthChallenge = z.infer<typeof AuthChallenge>;

export const AuthResponse = z.object({
  deviceId: z.uuid(),
  /** Signature over the raw nonce bytes. */
  signature: SignatureB64,
  /**
   * Resent on every connect so the dashboard reflects reality after an OS
   * upgrade, a rename, or an agent update — without a re-enrollment.
   */
  identity: DeviceIdentity,
});
export type AuthResponse = z.infer<typeof AuthResponse>;
