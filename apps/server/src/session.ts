import {
  ClientFrame,
  CloseCode,
  HEARTBEAT_SECONDS,
  type ServerFrame,
} from "@rms/protocol";

import type { Db } from "./db.ts";
import { type Challenge, issueChallenge, serverName, verifyResponse } from "./deviceauth.ts";
import type { Connection, Registry } from "./registry.ts";

/**
 * One device's WebSocket session, as a state machine independent of any
 * particular socket implementation.
 *
 * Kept transport-agnostic so it can be driven directly in tests. A session whose
 * only test path is "spin up a real server and hope" is a session whose failure
 * modes never get tested — and the interesting ones here are all failures:
 * authenticating twice, sending commands before authenticating, timing out
 * mid-handshake.
 */

/** How long a connection may sit unauthenticated before it is closed. */
export const AUTH_TIMEOUT_MS = 10_000;

type State =
  | { phase: "awaiting-auth"; challenge: Challenge }
  | { phase: "ready"; deviceId: string };

export interface SessionHooks {
  send(frame: ServerFrame): void;
  close(code: number, reason: string): void;
}

export class Session {
  #state: State;
  readonly #db: Db;
  readonly #registry: Registry;
  readonly #hooks: SessionHooks;
  #connection: Connection | null = null;

  constructor(db: Db, registry: Registry, hooks: SessionHooks, now: number) {
    this.#db = db;
    this.#registry = registry;
    this.#hooks = hooks;
    this.#state = { phase: "awaiting-auth", challenge: issueChallenge(now) };
  }

  /** Send the challenge. Call once, immediately after the socket opens. */
  start(): void {
    if (this.#state.phase !== "awaiting-auth") return;
    this.#hooks.send({
      type: "challenge",
      challenge: {
        nonce: this.#state.challenge.nonce,
        serverTime: this.#state.challenge.serverTime,
      },
    });
  }

  get deviceId(): string | null {
    return this.#state.phase === "ready" ? this.#state.deviceId : null;
  }

  async handleMessage(raw: string, now: number): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return this.#fail(CloseCode.MalformedFrame, "malformed_frame", "Frame was not JSON.");
    }

    const frame = ClientFrame.safeParse(parsedJson);
    if (!frame.success) {
      return this.#fail(CloseCode.MalformedFrame, "malformed_frame", "Unrecognised frame.");
    }

    switch (frame.data.type) {
      case "auth":
        return await this.#handleAuth(frame.data.response, now);

      case "ping":
        // Answered before authentication too: it proves liveness, reveals
        // nothing, and lets a client detect a dead link during a slow handshake.
        return this.#hooks.send({ type: "pong" });

      case "result": {
        if (this.#state.phase !== "ready") {
          return this.#fail(
            CloseCode.Unauthorized,
            "unauthenticated",
            "Authenticate before sending results.",
          );
        }
        // An unmatched result is ignored rather than fatal — a result racing a
        // timeout is normal, and killing the connection over it would turn a
        // slow command into a disconnect loop.
        this.#registry.settleCommand(frame.data.id, this.#state.deviceId, {
          ok: frame.data.ok,
          output: frame.data.output,
          error: frame.data.error,
        });
        return;
      }
    }
  }

  /** Called when the socket closes for any reason. Safe to call more than once. */
  handleClose(): void {
    if (this.#connection) {
      this.#registry.remove(this.#connection);
      this.#connection = null;
    }
  }

  /** Close the connection if it never authenticated. Driven by a timer. */
  checkAuthTimeout(now: number): void {
    if (this.#state.phase !== "awaiting-auth") return;
    if (now - this.#state.challenge.issuedAt < AUTH_TIMEOUT_MS) return;

    this.#fail(CloseCode.AuthTimeout, "auth_timeout", "Did not authenticate in time.");
  }

  async #handleAuth(response: unknown, now: number): Promise<void> {
    if (this.#state.phase !== "awaiting-auth") {
      // Re-authenticating mid-session would let a device swap identity on a
      // connection the registry has already keyed by the first one.
      return this.#fail(CloseCode.Unauthorized, "auth_failed", "Already authenticated.");
    }

    const challenge = this.#state.challenge;
    const outcome = await verifyResponse(this.#db, challenge, response, now);

    if (!outcome.ok) {
      // The nonce is spent either way. A challenge that survives a failed
      // attempt is one an attacker gets unlimited tries against.
      return this.#fail(CloseCode.Unauthorized, "auth_failed", `Authentication failed.`);
    }

    this.#state = { phase: "ready", deviceId: outcome.deviceId };

    this.#connection = {
      deviceId: outcome.deviceId,
      connectedAt: now,
      send: (frame) => this.#hooks.send(frame),
      close: (code, reason) => this.#hooks.close(code, reason),
    };
    this.#registry.add(this.#connection);

    this.#hooks.send({
      type: "ready",
      deviceId: outcome.deviceId,
      serverName: serverName(this.#db),
      heartbeatSeconds: HEARTBEAT_SECONDS,
    });
  }

  #fail(code: number, errorCode: "auth_failed" | "auth_timeout" | "malformed_frame" | "unauthenticated", message: string): void {
    this.#hooks.send({ type: "error", code: errorCode, message });
    this.#hooks.close(code, message);
  }
}
