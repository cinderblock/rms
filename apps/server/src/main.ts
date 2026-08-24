import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createApp } from "./app.ts";
import { SettingKey, getSetting, openDatabase, setSetting } from "./db.ts";
import { generatePassphrase, generateToken, hashPassphrase } from "./secrets.ts";

/**
 * Entry point. First boot provisions the two secrets that bootstrap everything
 * else and prints them once, to stdout.
 *
 * Printing rather than storing is the point: the admin setup token is single-use
 * and short-lived, and "whoever reaches the URL first becomes the admin" is a
 * race the public internet wins. A token in the log the operator has to read
 * beats a landgrab.
 */

const DB_PATH = process.env.RMS_DB ?? "./data/rms.sqlite";
const PORT = Number(process.env.RMS_PORT ?? 8787);

/**
 * Number of reverse proxies in front. Must be set deliberately — see `ip.ts`
 * for why guessing is worse than ignoring the header.
 */
const TRUSTED_PROXY_HOPS = Number(process.env.RMS_TRUSTED_PROXY_HOPS ?? 0);

/** An unclaimed admin setup token expires rather than waiting forever. */
const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDatabase(DB_PATH);

if (getSetting(db, SettingKey.EnrollmentPassphraseHash) === null) {
  const passphrase = process.env.RMS_ENROLLMENT_PASSPHRASE ?? generatePassphrase();
  setSetting(db, SettingKey.EnrollmentPassphraseHash, await hashPassphrase(passphrase));
  setSetting(db, SettingKey.EnrollmentOpen, "1");
  setSetting(db, SettingKey.EnrollmentLockedUntil, "0");
  setSetting(db, SettingKey.ServerName, process.env.RMS_SERVER_NAME ?? "control");

  // Hashed like any other credential — a stolen database must not yield a
  // working admin-registration link.
  const setupToken = generateToken();
  setSetting(db, SettingKey.AdminSetupTokenHash, await hashPassphrase(setupToken));
  setSetting(
    db,
    SettingKey.AdminSetupTokenExpiresAt,
    String(Date.now() + SETUP_TOKEN_TTL_MS),
  );

  console.log("");
  console.log("  First boot — these are shown once.");
  console.log("");
  console.log(`  Enrollment passphrase : ${passphrase}`);
  console.log(`  Admin setup token     : ${setupToken}`);
  console.log("");
  console.log("  Register your passkey at /setup?token=<admin setup token>.");
  console.log("  The setup token expires in 24h and works exactly once.");
  console.log("  Give the enrollment passphrase to each machine you install on.");
  console.log("");
}

const app = createApp({ db, trustedProxyHops: TRUSTED_PROXY_HOPS });

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`rms-server listening on :${PORT} (db ${DB_PATH})`);
