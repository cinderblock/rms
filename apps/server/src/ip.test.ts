import { describe, expect, test } from "bun:test";

import { clientIp } from "./ip.ts";

const headers = (forwarded?: string) =>
  new Headers(forwarded === undefined ? {} : { "x-forwarded-for": forwarded });

describe("with no trusted proxies", () => {
  // The important case. If XFF were honoured here, an attacker would present a
  // fresh IP per request and the per-IP enrollment budget would do nothing.
  test("a spoofed X-Forwarded-For is ignored entirely", () => {
    expect(clientIp(headers("1.2.3.4"), "203.0.113.7", 0)).toBe("203.0.113.7");
  });

  test("falls back to a sentinel when the peer is unknown", () => {
    expect(clientIp(headers(), null, 0)).toBe("unknown");
  });
});

describe("behind one trusted proxy", () => {
  test("uses the entry the proxy appended, not the one the client claimed", () => {
    // Client sent "1.2.3.4"; Caddy appended what it actually saw.
    expect(clientIp(headers("1.2.3.4, 203.0.113.7"), "127.0.0.1", 1)).toBe("203.0.113.7");
  });

  test("a single-entry chain is the real client", () => {
    expect(clientIp(headers("203.0.113.7"), "127.0.0.1", 1)).toBe("203.0.113.7");
  });

  test("tolerates whitespace in the chain", () => {
    expect(clientIp(headers("  1.2.3.4 ,   203.0.113.7  "), "127.0.0.1", 1)).toBe("203.0.113.7");
  });

  test("no header at all falls back to the peer", () => {
    expect(clientIp(headers(), "127.0.0.1", 1)).toBe("127.0.0.1");
  });
});

describe("behind two trusted proxies", () => {
  test("indexes from the right by the number of hops configured", () => {
    expect(clientIp(headers("1.2.3.4, 203.0.113.7, 10.0.0.1"), "127.0.0.1", 2)).toBe("203.0.113.7");
  });

  // A chain shorter than configured means something is wrong with the
  // deployment. Reaching further left would read attacker-controlled entries,
  // so fall back to the peer instead.
  test("a chain shorter than the configured hops falls back to the peer", () => {
    expect(clientIp(headers("1.2.3.4"), "127.0.0.1", 2)).toBe("127.0.0.1");
  });

  test("an empty header value falls back to the peer", () => {
    expect(clientIp(headers(""), "127.0.0.1", 2)).toBe("127.0.0.1");
  });
});
