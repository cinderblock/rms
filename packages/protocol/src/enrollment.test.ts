import { describe, expect, test } from "bun:test";

import { AuthChallenge, EnrollError, EnrollRequest, EnrollResponse } from "./enrollment.ts";

/** 32 zero bytes, base64 — a structurally valid Ed25519 public key. */
const PUBKEY = Buffer.alloc(32).toString("base64");
/** 64 zero bytes, base64 — a structurally valid Ed25519 signature. */
const SIGNATURE = Buffer.alloc(64).toString("base64");

const identity = {
  hostname: "steamboat",
  machineId: "8f1c1a4e-0e2b-4a3f-9c2d-1b6d0a7e5f10",
  os: "linux",
  osVersion: "6.8.0-generic",
  arch: "x86_64",
  user: "root",
  agentVersion: "0.1.0",
} as const;

describe("EnrollRequest", () => {
  test("accepts a well-formed registration", () => {
    const parsed = EnrollRequest.parse({
      publicKey: PUBKEY,
      passphrase: "correct horse battery staple pencil sharpener",
      identity,
    });
    expect(parsed.identity.hostname).toBe("steamboat");
  });

  test("optional identity fields may be omitted", () => {
    const { machineId, ...withoutMachineId } = identity;
    expect(() =>
      EnrollRequest.parse({
        publicKey: PUBKEY,
        passphrase: "x",
        identity: withoutMachineId,
      }),
    ).not.toThrow();
  });

  // A key of the wrong length is not an Ed25519 key. Catching it at the schema
  // means the verifier downstream never sees input it has to defend against.
  test("rejects a public key that is not 32 bytes", () => {
    const short = Buffer.alloc(16).toString("base64");
    expect(() =>
      EnrollRequest.parse({ publicKey: short, passphrase: "x", identity }),
    ).toThrow();
  });

  test("rejects a public key that is not base64", () => {
    expect(() =>
      EnrollRequest.parse({ publicKey: "!".repeat(44), passphrase: "x", identity }),
    ).toThrow();
  });

  test("rejects an empty passphrase", () => {
    expect(() =>
      EnrollRequest.parse({ publicKey: PUBKEY, passphrase: "", identity }),
    ).toThrow();
  });

  test("rejects an unknown platform", () => {
    expect(() =>
      EnrollRequest.parse({
        publicKey: PUBKEY,
        passphrase: "x",
        identity: { ...identity, os: "solaris" },
      }),
    ).toThrow();
  });
});

describe("EnrollResponse", () => {
  test("probableReenrollmentOf is nullable but required", () => {
    const parsed = EnrollResponse.parse({
      deviceId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      displayName: "steamboat",
      serverName: "control",
      probableReenrollmentOf: null,
    });
    expect(parsed.probableReenrollmentOf).toBeNull();
  });

  test("rejects a deviceId that is not a uuid", () => {
    expect(() =>
      EnrollResponse.parse({
        deviceId: "steamboat",
        displayName: "steamboat",
        serverName: "control",
        probableReenrollmentOf: null,
      }),
    ).toThrow();
  });
});

describe("EnrollError", () => {
  test("carries retryAfter when rate limited", () => {
    const parsed = EnrollError.parse({
      error: "rate_limited",
      message: "Too many attempts.",
      retryAfter: 300,
    });
    expect(parsed.retryAfter).toBe(300);
  });

  test("rejects an error code outside the enum", () => {
    expect(() => EnrollError.parse({ error: "teapot", message: "no" })).toThrow();
  });
});

describe("AuthChallenge", () => {
  test("accepts an ISO timestamp and a 32-byte nonce", () => {
    expect(() =>
      AuthChallenge.parse({
        nonce: Buffer.alloc(32).toString("base64"),
        serverTime: "2026-08-24T17:00:00Z",
      }),
    ).not.toThrow();
  });

  test("rejects a non-ISO timestamp", () => {
    expect(() =>
      AuthChallenge.parse({
        nonce: Buffer.alloc(32).toString("base64"),
        serverTime: "Mon Aug 24 2026",
      }),
    ).toThrow();
  });

  test("signature length is 88 base64 characters", () => {
    expect(SIGNATURE).toHaveLength(88);
  });
});
