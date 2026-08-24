import { beforeEach, describe, expect, test } from "bun:test";

import { type Db, openDatabase } from "./db.ts";
import { NONCE_TTL_MS, decodeBase64, issueChallenge, verifyResponse } from "./deviceauth.ts";

const T0 = 1_800_000_000_000;

const identity = {
  hostname: "steamboat",
  machineId: "8f1c1a4e-0e2b-4a3f-9c2d-1b6d0a7e5f10",
  os: "linux",
  osVersion: "6.8.0-generic",
  arch: "x86_64",
  user: "root",
  agentVersion: "0.1.0",
} as const;

/** A real Ed25519 keypair, so these tests exercise actual crypto. */
async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;

  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    publicKeyB64: Buffer.from(raw).toString("base64"),
    async sign(message: Uint8Array<ArrayBuffer>): Promise<string> {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message);
      return Buffer.from(sig).toString("base64");
    },
  };
}

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

function enroll(deviceId: string, publicKey: string) {
  db.query<never, [string, string, string, number]>(
    `INSERT INTO devices (id, public_key, display_name, identity, enrolled_at, enrolled_from_ip)
     VALUES (?, ?, 'steamboat', ?, ?, '127.0.0.1')`,
  ).run(deviceId, publicKey, JSON.stringify(identity), T0);
}

const DEVICE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("challenge", () => {
  test("issues a 32-byte nonce and an ISO timestamp", () => {
    const challenge = issueChallenge(T0);
    expect(decodeBase64(challenge.nonce)).toHaveLength(32);
    expect(challenge.serverTime).toBe(new Date(T0).toISOString());
  });

  test("every challenge is different", () => {
    const seen = new Set(Array.from({ length: 50 }, () => issueChallenge(T0).nonce));
    expect(seen.size).toBe(50);
  });
});

describe("verification", () => {
  test("a correctly signed nonce authenticates the device", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);

    const challenge = issueChallenge(T0);
    const signature = await key.sign(decodeBase64(challenge.nonce));

    const result = await verifyResponse(
      db,
      challenge,
      { deviceId: DEVICE, signature, identity },
      T0 + 100,
    );

    expect(result).toEqual({ ok: true, deviceId: DEVICE });
  });

  // The core property: holding a device's public key must not let you
  // impersonate it. Signing with a different key has to fail.
  test("a signature from a different key is rejected", async () => {
    const real = await keypair();
    const attacker = await keypair();
    enroll(DEVICE, real.publicKeyB64);

    const challenge = issueChallenge(T0);
    const signature = await attacker.sign(decodeBase64(challenge.nonce));

    const result = await verifyResponse(
      db,
      challenge,
      { deviceId: DEVICE, signature, identity },
      T0 + 100,
    );

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  // Replay: a signature captured from an earlier session is worthless against a
  // fresh nonce. This is the whole reason the server picks the challenge.
  test("a signature over a different nonce is rejected", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);

    const captured = issueChallenge(T0);
    const signature = await key.sign(decodeBase64(captured.nonce));

    const fresh = issueChallenge(T0 + 1000);
    const result = await verifyResponse(
      db,
      fresh,
      { deviceId: DEVICE, signature, identity },
      T0 + 1100,
    );

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("an expired challenge is refused before any crypto happens", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);

    const challenge = issueChallenge(T0);
    const signature = await key.sign(decodeBase64(challenge.nonce));

    const result = await verifyResponse(
      db,
      challenge,
      { deviceId: DEVICE, signature, identity },
      T0 + NONCE_TTL_MS + 1,
    );

    expect(result).toEqual({ ok: false, reason: "nonce_expired" });
  });

  test("an unknown device id is rejected", async () => {
    const key = await keypair();
    const challenge = issueChallenge(T0);
    const signature = await key.sign(decodeBase64(challenge.nonce));

    const result = await verifyResponse(
      db,
      challenge,
      { deviceId: DEVICE, signature, identity },
      T0 + 100,
    );

    expect(result).toEqual({ ok: false, reason: "unknown_device" });
  });

  test("a malformed body is rejected without touching the database", async () => {
    const result = await verifyResponse(db, issueChallenge(T0), { nope: true }, T0 + 100);
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  test("a garbage signature is a failed verification, not a crash", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);

    const challenge = issueChallenge(T0);
    const result = await verifyResponse(
      db,
      challenge,
      { deviceId: DEVICE, signature: "A".repeat(88), identity },
      T0 + 100,
    );

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("identity refresh", () => {
  test("a successful connect updates the stored identity and last_seen", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);

    const challenge = issueChallenge(T0);
    const signature = await key.sign(decodeBase64(challenge.nonce));

    // Same machine after an OS upgrade and a rename.
    const updated = { ...identity, hostname: "steamboat-2", osVersion: "6.11.0-generic" };
    await verifyResponse(db, challenge, { deviceId: DEVICE, signature, identity: updated }, T0 + 5);

    const row = db
      .query<{ identity: string; last_seen_at: number }, []>(
        "SELECT identity, last_seen_at FROM devices",
      )
      .get()!;

    expect(JSON.parse(row.identity).osVersion).toBe("6.11.0-generic");
    expect(row.last_seen_at).toBe(T0 + 5);
  });

  test("a failed connect leaves the stored identity alone", async () => {
    const real = await keypair();
    const attacker = await keypair();
    enroll(DEVICE, real.publicKeyB64);

    const challenge = issueChallenge(T0);
    const signature = await attacker.sign(decodeBase64(challenge.nonce));

    await verifyResponse(
      db,
      challenge,
      { deviceId: DEVICE, signature, identity: { ...identity, hostname: "pwned" } },
      T0 + 5,
    );

    const row = db.query<{ identity: string }, []>("SELECT identity FROM devices").get()!;
    expect(JSON.parse(row.identity).hostname).toBe("steamboat");
  });
});
