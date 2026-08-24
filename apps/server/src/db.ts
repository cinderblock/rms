import { Database } from "bun:sqlite";

/**
 * Schema and migrations.
 *
 * Migrations are an append-only list. Each entry runs exactly once, inside a
 * transaction, and `user_version` records how far we've got. Never edit a
 * migration that has shipped — add another one.
 */

const MIGRATIONS: readonly string[] = [
  // 1 — settings, devices, and the enrollment audit trail.
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE devices (
    id                        TEXT PRIMARY KEY,
    -- Base64 Ed25519 public key. UNIQUE is what makes a retried enrollment
    -- idempotent rather than a way to accumulate duplicate records.
    public_key                TEXT NOT NULL UNIQUE,
    display_name              TEXT NOT NULL,
    -- Whole client-asserted identity block, verbatim, as JSON. Denormalised on
    -- purpose: it is a snapshot of what the device claimed, not a source of truth.
    identity                  TEXT NOT NULL,
    -- Pulled out of the identity blob only so it can be indexed.
    machine_id                TEXT,
    probable_reenrollment_of  TEXT REFERENCES devices(id) ON DELETE SET NULL,
    enrolled_at               INTEGER NOT NULL,
    enrolled_from_ip          TEXT NOT NULL,
    -- NULL until a human has looked at this device in the UI and dismissed it.
    acknowledged_at           INTEGER,
    last_seen_at              INTEGER
  ) STRICT;

  CREATE INDEX devices_machine_id ON devices(machine_id);

  -- Every attempt, good or bad. Doubles as the rate limiter's state and as the
  -- audit trail for "who has been trying to join my fleet".
  CREATE TABLE enrollment_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT NOT NULL,
    at         INTEGER NOT NULL,
    succeeded  INTEGER NOT NULL,
    -- Failure reason, or NULL on success. Never contains the passphrase.
    outcome    TEXT
  ) STRICT;

  CREATE INDEX enrollment_attempts_at ON enrollment_attempts(at);
  CREATE INDEX enrollment_attempts_ip_at ON enrollment_attempts(ip, at);
  `,
];

export type Db = Database;

export function openDatabase(path: string): Db {
  const db = new Database(path, { create: true, strict: true });

  // WAL keeps reads from blocking the write that records an enrollment.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  let version = current?.user_version ?? 0;

  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) break;

    db.transaction(() => {
      db.exec(sql);
      // PRAGMA does not accept bound parameters, and `version` is a loop counter
      // over a literal array — never user input.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();

    version += 1;
  }
}

export function getSetting(db: Db, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.query<never, [string, string]>(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export const SettingKey = {
  /** argon2id hash of the shared enrollment passphrase. */
  EnrollmentPassphraseHash: "enrollment.passphrase_hash",
  /** "1" or "0" — the admin's manual switch. */
  EnrollmentOpen: "enrollment.open",
  /**
   * Epoch ms until which enrollment is suspended by the global failure budget.
   * Distinct from the manual switch so an automatic lockout can expire on its
   * own without silently re-opening something the admin turned off by hand.
   */
  EnrollmentLockedUntil: "enrollment.locked_until",
  /**
   * argon2id hash of the one-time admin setup token. Deleted the moment the
   * first passkey is registered, which is what makes `/setup` single-use.
   */
  AdminSetupTokenHash: "admin.setup_token_hash",
  /** Epoch ms. An unused setup token should not stay valid indefinitely. */
  AdminSetupTokenExpiresAt: "admin.setup_token_expires_at",
  /** Human-facing name, echoed back so a client can confirm where it landed. */
  ServerName: "server.name",
} as const;
