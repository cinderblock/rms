import { beforeEach, describe, expect, test } from "bun:test";

import { type Db, SettingKey, openDatabase, setSetting } from "./db.ts";
import { decodeBase64 } from "./deviceauth.ts";
import { Registry } from "./registry.ts";
import { AUTH_TIMEOUT_MS, Session } from "./session.ts";

const T0 = 1_800_000_000_000;
const DEVICE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER = "9c8f1b2a-3d4e-4f50-8a61-b2c3d4e5f607";

const identity = {
  hostname: "steamboat",
  os: "linux",
  osVersion: "6.8.0",
  arch: "x86_64",
  user: "root",
  agentVersion: "0.1.0",
} as const;

async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    publicKeyB64: Buffer.from(raw).toString("base64"),
    async sign(message: Uint8Array<ArrayBuffer>): Promise<string> {
      return Buffer.from(
        await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message),
      ).toString("base64");
    },
  };
}

function harness(db: Db, registry: Registry, now = T0) {
  const sent: any[] = [];
  const closed: { code: number; reason: string }[] = [];
  const session = new Session(
    db,
    registry,
    {
      send: (frame) => void sent.push(frame),
      close: (code, reason) => void closed.push({ code, reason }),
    },
    now,
  );
  return { session, sent, closed };
}

let db: Db;
let registry: Registry;

beforeEach(() => {
  db = openDatabase(":memory:");
  setSetting(db, SettingKey.ServerName, "control");
  registry = new Registry();
});

function enroll(deviceId: string, publicKey: string) {
  db.query<never, [string, string, string, number]>(
    `INSERT INTO devices (id, public_key, display_name, identity, enrolled_at, enrolled_from_ip)
     VALUES (?, ?, 'steamboat', ?, ?, '127.0.0.1')`,
  ).run(deviceId, publicKey, JSON.stringify(identity), T0);
}

async function authenticate(h: ReturnType<typeof harness>, key: Awaited<ReturnType<typeof keypair>>, deviceId = DEVICE) {
  h.session.start();
  const nonce = h.sent[0].challenge.nonce;
  await h.session.handleMessage(
    JSON.stringify({
      type: "auth",
      response: { deviceId, signature: await key.sign(decodeBase64(nonce)), identity },
    }),
    T0 + 50,
  );
}

describe("handshake", () => {
  test("sends a challenge on start", () => {
    const h = harness(db, registry);
    h.session.start();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].type).toBe("challenge");
    expect(decodeBase64(h.sent[0].challenge.nonce)).toHaveLength(32);
  });

  test("a valid signature reaches ready and registers the device", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);
    const h = harness(db, registry);

    await authenticate(h, key);

    expect(h.sent[1]).toMatchObject({
      type: "ready",
      deviceId: DEVICE,
      serverName: "control",
    });
    expect(registry.isOnline(DEVICE)).toBe(true);
    expect(h.session.deviceId).toBe(DEVICE);
  });

  test("a bad signature closes the connection unauthorized", async () => {
    const real = await keypair();
    const attacker = await keypair();
    enroll(DEVICE, real.publicKeyB64);
    const h = harness(db, registry);

    await authenticate(h, attacker);

    expect(h.sent[1]).toMatchObject({ type: "error", code: "auth_failed" });
    expect(h.closed[0]?.code).toBe(4002);
    expect(registry.isOnline(DEVICE)).toBe(false);
  });

  // Re-authenticating would let a device swap identity on a connection the
  // registry has already keyed by the first one.
  test("authenticating twice is refused", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);
    const h = harness(db, registry);

    await authenticate(h, key);
    await h.session.handleMessage(
      JSON.stringify({
        type: "auth",
        response: { deviceId: DEVICE, signature: "A".repeat(88), identity },
      }),
      T0 + 100,
    );

    // sent is [challenge, ready, error] — the refusal is the last frame.
    expect(h.sent.at(-1)).toMatchObject({ type: "error", code: "auth_failed" });
    expect(h.closed).toHaveLength(1);
  });

  test("an unauthenticated connection is closed once the timeout passes", () => {
    const h = harness(db, registry);
    h.session.start();

    h.session.checkAuthTimeout(T0 + AUTH_TIMEOUT_MS - 1);
    expect(h.closed).toHaveLength(0);

    h.session.checkAuthTimeout(T0 + AUTH_TIMEOUT_MS);
    expect(h.closed[0]?.code).toBe(4001);
  });

  test("the timeout does not fire once authenticated", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);
    const h = harness(db, registry);

    await authenticate(h, key);
    h.session.checkAuthTimeout(T0 + AUTH_TIMEOUT_MS * 10);

    expect(h.closed).toHaveLength(0);
  });
});

describe("frames", () => {
  test("non-JSON closes the connection", async () => {
    const h = harness(db, registry);
    await h.session.handleMessage("{ not json", T0);
    expect(h.closed[0]?.code).toBe(4003);
  });

  test("an unrecognised frame type closes the connection", async () => {
    const h = harness(db, registry);
    await h.session.handleMessage(JSON.stringify({ type: "whatever" }), T0);
    expect(h.closed[0]?.code).toBe(4003);
  });

  test("ping is answered before authentication", async () => {
    const h = harness(db, registry);
    h.session.start();
    await h.session.handleMessage(JSON.stringify({ type: "ping" }), T0);

    expect(h.sent.at(-1)).toEqual({ type: "pong" });
    expect(h.closed).toHaveLength(0);
  });

  test("a result before authentication is refused", async () => {
    const h = harness(db, registry);
    h.session.start();
    await h.session.handleMessage(
      JSON.stringify({ type: "result", id: crypto.randomUUID(), ok: true }),
      T0,
    );

    expect(h.sent.at(-1)).toMatchObject({ type: "error", code: "unauthenticated" });
    expect(h.closed[0]?.code).toBe(4002);
  });

  test("a result settles a tracked command", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);
    const h = harness(db, registry);
    await authenticate(h, key);

    let settled: unknown;
    const id = crypto.randomUUID();
    registry.trackCommand(id, {
      verb: "ping",
      deviceId: DEVICE,
      sentAt: T0,
      resolve: (value) => void (settled = value),
    });

    await h.session.handleMessage(
      JSON.stringify({ type: "result", id, ok: true, output: "pong" }),
      T0 + 200,
    );

    expect(settled).toEqual({ ok: true, output: "pong", error: undefined });
  });

  // A result racing its own timeout is normal. Closing the connection over it
  // would turn a slow command into a reconnect loop.
  test("an unmatched result is ignored rather than fatal", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);
    const h = harness(db, registry);
    await authenticate(h, key);

    await h.session.handleMessage(
      JSON.stringify({ type: "result", id: crypto.randomUUID(), ok: true }),
      T0 + 200,
    );

    expect(h.closed).toHaveLength(0);
    expect(registry.isOnline(DEVICE)).toBe(true);
  });
});

describe("lifecycle", () => {
  test("closing removes the device from the registry", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);
    const h = harness(db, registry);

    await authenticate(h, key);
    h.session.handleClose();

    expect(registry.isOnline(DEVICE)).toBe(false);
  });

  test("closing twice is harmless", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);
    const h = harness(db, registry);

    await authenticate(h, key);
    h.session.handleClose();
    h.session.handleClose();

    expect(registry.size).toBe(0);
  });

  test("closing a never-authenticated session is harmless", () => {
    const h = harness(db, registry);
    h.session.start();
    h.session.handleClose();

    expect(registry.size).toBe(0);
  });

  test("a second connection for the same device supersedes the first", async () => {
    const key = await keypair();
    enroll(DEVICE, key.publicKeyB64);

    const first = harness(db, registry);
    await authenticate(first, key);

    const second = harness(db, registry, T0 + 1000);
    await authenticate(second, key);

    expect(first.closed[0]?.code).toBe(4004);
    expect(registry.isOnline(DEVICE)).toBe(true);
    expect(registry.size).toBe(1);
  });

  test("two different devices can be connected at once", async () => {
    const a = await keypair();
    const b = await keypair();
    enroll(DEVICE, a.publicKeyB64);
    enroll(OTHER, b.publicKeyB64);

    const first = harness(db, registry);
    await authenticate(first, a, DEVICE);
    const second = harness(db, registry);
    await authenticate(second, b, OTHER);

    expect(registry.size).toBe(2);
    expect(first.closed).toHaveLength(0);
  });
});
