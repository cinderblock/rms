import { Hono } from "hono";
import { getConnInfo } from "hono/bun";

import type { Db } from "./db.ts";
import { handleEnroll } from "./enroll.ts";
import { clientIp } from "./ip.ts";

export interface AppOptions {
  db: Db;
  /**
   * How many reverse proxies sit in front of this server. 0 means ignore
   * `X-Forwarded-For` entirely — the safe default, because trusting it when
   * nothing is stripping it defeats per-IP rate limiting outright.
   */
  trustedProxyHops: number;
  /** Injectable so tests can advance time without sleeping. */
  now?: () => number;
}

export function createApp({ db, trustedProxyHops, now = Date.now }: AppOptions): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/enroll", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_request" as const, message: "Body must be JSON." },
        400,
      );
    }

    let peer: string | null = null;
    try {
      peer = getConnInfo(c).remote.address ?? null;
    } catch {
      // No connection info under `app.request()` in tests, and none behind some
      // deployments. `clientIp` copes; enrollment shouldn't 500 over it.
    }

    const ip = clientIp(c.req.raw.headers, peer, trustedProxyHops);
    const result = await handleEnroll(db, body, ip, now());

    if (result.status === 429 && result.body.retryAfter !== undefined) {
      c.header("Retry-After", String(result.body.retryAfter));
    }

    return c.json(result.body, result.status);
  });

  return app;
}
