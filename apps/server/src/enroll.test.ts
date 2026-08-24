import { beforeEach, describe, expect, test } from "bun:test";

import { type Db, SettingKey, openDatabase, setSetting } from "./db.ts";
import { handleEnroll } from "./enroll.ts";
import { GLOBAL_MAX_FAILURES, PER_IP_MAX_FAILURES, PER_IP_WINDOW_MS } from "./ratelimit.ts";
import { hashPassphrase } from "./secrets.ts";

const PASSPHRASE = "k7m9-x2qp-4rtv-8wny-3jdc";
const T0 = 1_800_000_000_000;

function key(seed: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = seed & 0xff;
  bytes[1] = (seed >> 8) & 0xff;
  return Buffer.from(bytes).toString("base64");
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    publicKey: key(1),
    passphrase: PASSPHRASE,
    identity: {
      hostname: "steamboat",
      machineId: "8f1c1a4e-0e2b-4a3f-9c2d-1b6d0a7e5f10",
      os: "linux",
      osVersion: "6.8.0-generic",
      arch: "x86_64",
      user: "root",
      agentVersion: "0.1.0",
    },
    ...overrides,
  };
}

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  setSetting(db, SettingKey.EnrollmentPassphraseHash, await hashPassphrase(PASSPHRASE));
  setSetting(db, SettingKey.EnrollmentOpen, "1");
  setSetting(db, SettingKey.EnrollmentLockedUntil, "0");
  setSetting(db, SettingKey.ServerName, "control");
});

describe("happy path", () => {
  test("enrolls a device and returns an id", async () => {
    const result = await handleEnroll(db, request(), "10.0.0.1", T0);

    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.displayName).toBe("steamboat");
    expect(result.body.serverName).toBe("control");
    expect(result.body.probableReenrollmentOf).toBeNull();
  });

  test("the passphrase is case- and whitespace-insensitive", async () => {
    const result = await handleEnroll(
      db,
      request({ passphrase: `  ${PASSPHRASE.toUpperCase()}  ` }),
      "10.0.0.1",
      T0,
    );
    expect(result.status).toBe(200);
  });

  test("stores the identity block verbatim", async () => {
    await handleEnroll(db, request(), "10.0.0.1", T0);
    const row = db.query<{ identity: string }, []>("SELECT identity FROM devices").get();
    expect(JSON.parse(row!.identity).osVersion).toBe("6.8.0-generic");
  });
});

describe("rejections", () => {
  test("a wrong passphrase is 401 and enrolls nothing", async () => {
    const result = await handleEnroll(db, request({ passphrase: "wrong-wrong-wrong" }), "ip", T0);

    expect(result.status).toBe(401);
    if (result.status === 401) expect(result.body.error).toBe("invalid_passphrase");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!.n).toBe(0);
  });

  test("a malformed body is 400", async () => {
    const result = await handleEnroll(db, { nope: true }, "ip", T0);
    expect(result.status).toBe(400);
  });

  test("a short public key is rejected before it reaches the database", async () => {
    const short = Buffer.alloc(16).toString("base64");
    const result = await handleEnroll(db, request({ publicKey: short }), "ip", T0);
    expect(result.status).toBe(400);
  });

  test("re-sending the same key is 409, not a duplicate record", async () => {
    await handleEnroll(db, request(), "10.0.0.1", T0);
    const again = await handleEnroll(db, request(), "10.0.0.1", T0 + 1000);

    expect(again.status).toBe(409);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!.n).toBe(1);
  });

  test("enrollment closed is 403 even with the right passphrase", async () => {
    setSetting(db, SettingKey.EnrollmentOpen, "0");
    const result = await handleEnroll(db, request(), "10.0.0.1", T0);

    expect(result.status).toBe(403);
    if (result.status === 403) expect(result.body.error).toBe("enrollment_closed");
  });

  test("an unconfigured server refuses rather than accepting anything", async () => {
    const fresh = openDatabase(":memory:");
    setSetting(fresh, SettingKey.EnrollmentOpen, "1");
    const result = await handleEnroll(fresh, request(), "10.0.0.1", T0);
    expect(result.status).toBe(503);
  });
});

describe("re-enrollment detection", () => {
  test("a matching machineId flags the prior device instead of replacing it", async () => {
    const first = await handleEnroll(db, request(), "10.0.0.1", T0);
    expect(first.status).toBe(200);
    if (first.status !== 200) return;

    // Same machine, reinstalled: same machineId, brand new keypair.
    const second = await handleEnroll(db, request({ publicKey: key(2) }), "10.0.0.1", T0 + 5000);

    expect(second.status).toBe(200);
    if (second.status !== 200) return;
    expect(second.body.probableReenrollmentOf).toBe(first.body.deviceId);
    expect(second.body.deviceId).not.toBe(first.body.deviceId);

    // Both records survive. Merging is the admin's call, never automatic —
    // machineId is client-asserted, so auto-replacing would be device takeover.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!.n).toBe(2);
  });

  test("a device without a machineId is never linked to anything", async () => {
    await handleEnroll(db, request(), "10.0.0.1", T0);

    const identity = { ...request().identity } as Record<string, unknown>;
    delete identity.machineId;
    const result = await handleEnroll(
      db,
      request({ publicKey: key(3), identity }),
      "10.0.0.1",
      T0 + 1000,
    );

    expect(result.status).toBe(200);
    if (result.status === 200) expect(result.body.probableReenrollmentOf).toBeNull();
  });
});

describe("rate limiting", () => {
  test("per-IP failures eventually return 429 with a Retry-After", async () => {
    for (let i = 0; i < PER_IP_MAX_FAILURES; i++) {
      const r = await handleEnroll(db, request({ passphrase: "nope-nope-nope-nope" }), "10.0.0.9", T0 + i);
      expect(r.status).toBe(401);
    }

    const blocked = await handleEnroll(db, request(), "10.0.0.9", T0 + 100);
    expect(blocked.status).toBe(429);
    if (blocked.status === 429) {
      expect(blocked.body.error).toBe("rate_limited");
      expect(blocked.body.retryAfter).toBeGreaterThan(0);
    }
  });

  test("the limit is per-IP, so one bad host doesn't lock out a good one", async () => {
    for (let i = 0; i < PER_IP_MAX_FAILURES; i++) {
      await handleEnroll(db, request({ passphrase: "nope-nope-nope-nope" }), "10.0.0.9", T0 + i);
    }

    const other = await handleEnroll(db, request(), "10.0.0.10", T0 + 100);
    expect(other.status).toBe(200);
  });

  test("the window slides — failures age out", async () => {
    for (let i = 0; i < PER_IP_MAX_FAILURES; i++) {
      await handleEnroll(db, request({ passphrase: "nope-nope-nope-nope" }), "10.0.0.9", T0 + i);
    }
    expect((await handleEnroll(db, request(), "10.0.0.9", T0 + 100)).status).toBe(429);

    const later = await handleEnroll(db, request(), "10.0.0.9", T0 + PER_IP_WINDOW_MS + 1000);
    expect(later.status).toBe(200);
  });

  test("a blocked caller cannot extend their own lockout by retrying", async () => {
    for (let i = 0; i < PER_IP_MAX_FAILURES; i++) {
      await handleEnroll(db, request({ passphrase: "nope-nope-nope-nope" }), "10.0.0.9", T0 + i);
    }

    const first = await handleEnroll(db, request(), "10.0.0.9", T0 + 100);
    // Hammering while blocked must not push the window forward.
    for (let i = 0; i < 20; i++) {
      await handleEnroll(db, request(), "10.0.0.9", T0 + 200 + i);
    }
    const after = await handleEnroll(db, request(), "10.0.0.9", T0 + 500);

    expect(first.status).toBe(429);
    expect(after.status).toBe(429);
    if (first.status === 429 && after.status === 429) {
      expect(after.body.retryAfter!).toBeLessThanOrEqual(first.body.retryAfter!);
    }
  });

  test("a distributed attempt trips the global budget and suspends enrollment", async () => {
    // Each IP stays under the per-IP cap, so only the global budget catches this.
    let attempts = 0;
    for (let ip = 0; attempts < GLOBAL_MAX_FAILURES; ip++) {
      for (let i = 0; i < PER_IP_MAX_FAILURES - 1 && attempts < GLOBAL_MAX_FAILURES; i++) {
        await handleEnroll(
          db,
          request({ passphrase: "nope-nope-nope-nope" }),
          `10.1.0.${ip}`,
          T0 + attempts,
        );
        attempts++;
      }
    }

    // A previously untouched IP with the correct passphrase is now refused.
    const clean = await handleEnroll(db, request(), "10.9.9.9", T0 + 10_000);
    expect(clean.status).toBe(429);
  });
});
