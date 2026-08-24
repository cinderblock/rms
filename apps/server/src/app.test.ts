import { beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "./app.ts";
import { type Db, SettingKey, openDatabase, setSetting } from "./db.ts";
import { hashPassphrase } from "./secrets.ts";

const PASSPHRASE = "k7m9-x2qp-4rtv-8wny-3jdc";

const body = (overrides: Record<string, unknown> = {}) => ({
  publicKey: Buffer.alloc(32).toString("base64"),
  passphrase: PASSPHRASE,
  identity: {
    hostname: "steamboat",
    os: "linux",
    osVersion: "6.8.0",
    arch: "x86_64",
    user: "root",
    agentVersion: "0.1.0",
  },
  ...overrides,
});

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = openDatabase(":memory:");
  setSetting(db, SettingKey.EnrollmentPassphraseHash, await hashPassphrase(PASSPHRASE));
  setSetting(db, SettingKey.EnrollmentOpen, "1");
  setSetting(db, SettingKey.EnrollmentLockedUntil, "0");
  setSetting(db, SettingKey.ServerName, "control");
  app = createApp({ db, trustedProxyHops: 0 });
});

const post = (payload: unknown) =>
  app.request("/api/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

describe("HTTP surface", () => {
  test("health check responds", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("a valid enrollment returns 200 and a device id", async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deviceId: string };
    expect(json.deviceId).toBeString();
  });

  test("a wrong passphrase is 401", async () => {
    const res = await post(body({ passphrase: "definitely-not-right" }));
    expect(res.status).toBe(401);
  });

  test("a non-JSON body is 400, not a 500", async () => {
    const res = await app.request("/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  test("429 carries a Retry-After header", async () => {
    for (let i = 0; i < 6; i++) await post(body({ passphrase: "wrong-wrong-wrong" }));

    const res = await post(body());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("the passphrase is never echoed back in any response", async () => {
    for (const payload of [body(), body({ passphrase: "wrong-wrong-wrong" }), { junk: 1 }]) {
      const res = await post(payload);
      expect(await res.text()).not.toContain(PASSPHRASE);
    }
  });
});
