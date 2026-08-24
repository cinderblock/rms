import { z } from "zod";

import { AuthChallenge, AuthResponse } from "./enrollment.ts";

/**
 * The live session: what flows over the WebSocket once a device is enrolled.
 *
 * The device dials out. Nothing listens on the managed host, so there is no
 * inbound firewall hole to open and no port to expose — and the fact that the
 * socket is up *is* the online signal, so nothing has to poll to know whether a
 * machine is alive.
 *
 *   device                                        server
 *     │──── connect ─────────────────────────────▶│
 *     │◀─── { type: "challenge", … } ─────────────│
 *     │──── { type: "auth", … } ─────────────────▶│  verify
 *     │◀─── { type: "ready", … } ─────────────────│  (or "error", then close)
 *     │                                           │
 *     │◀─── { type: "command", … } ───────────────│
 *     │──── { type: "result", … } ───────────────▶│
 *
 * Frames are a discriminated union on `type`, so an unknown frame is a parse
 * failure rather than something silently ignored. Both directions get parsed;
 * a server is no more entitled to send a malformed frame than a device is.
 */

/** Correlates a command with its result. Server-generated. */
export const CommandId = z.uuid();

/**
 * The command catalogue. Deliberately a closed enum rather than free-form shell:
 * every verb here is something the agent knows how to do and can refuse. Adding
 * arbitrary execution is a decision to take on its own, not a side effect of
 * making the transport flexible.
 *
 * `scope` is what decides which process runs it — see the session-boundary note
 * in `plans/architecture.md`. `session` verbs need the interactive desktop and
 * are routed to the tray; if nobody is logged in they fail fast rather than hang.
 */
export const CommandVerb = z.enum([
  /** Liveness. Always available. */
  "ping",
  /** Ask the agent to check for an update now. */
  "update.check",
  /** Report OS/agent version and uptime. */
  "system.info",
]);
export type CommandVerb = z.infer<typeof CommandVerb>;

// ---------------------------------------------------------------- server → device

export const ChallengeFrame = z.object({
  type: z.literal("challenge"),
  challenge: AuthChallenge,
});

export const ReadyFrame = z.object({
  type: z.literal("ready"),
  deviceId: z.uuid(),
  serverName: z.string(),
  /**
   * How often the server expects to hear from this device. The client uses it
   * to size its own keepalive rather than hard-coding a guess that might not
   * match whatever proxy is in the middle.
   */
  heartbeatSeconds: z.number().int().positive(),
});

export const CommandFrame = z.object({
  type: z.literal("command"),
  id: CommandId,
  verb: CommandVerb,
  /** Verb-specific payload. Validated by the handler for that verb. */
  args: z.record(z.string(), z.unknown()).default({}),
});

export const ErrorFrame = z.object({
  type: z.literal("error"),
  code: z.enum([
    "unauthenticated",
    "auth_failed",
    "auth_timeout",
    "malformed_frame",
    "superseded",
  ]),
  message: z.string(),
});

export const PongFrame = z.object({ type: z.literal("pong") });

export const ServerFrame = z.discriminatedUnion("type", [
  ChallengeFrame,
  ReadyFrame,
  CommandFrame,
  ErrorFrame,
  PongFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// ---------------------------------------------------------------- device → server

export const AuthFrame = z.object({
  type: z.literal("auth"),
  response: AuthResponse,
});

export const ResultFrame = z.object({
  type: z.literal("result"),
  id: CommandId,
  ok: z.boolean(),
  /** Present when `ok`. */
  output: z.unknown().optional(),
  /** Present when not `ok`. Human-readable; not a code the server branches on. */
  error: z.string().optional(),
});

export const PingFrame = z.object({ type: z.literal("ping") });

export const ClientFrame = z.discriminatedUnion("type", [AuthFrame, ResultFrame, PingFrame]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/**
 * Server expects a frame at least this often. The client pings on a shorter
 * interval; anything longer and the connection is treated as dead, because a
 * TCP connection can stay "open" long after the far end has gone.
 */
export const HEARTBEAT_SECONDS = 30;

/**
 * WebSocket close codes. 4000+ is the application-defined range.
 *
 * Distinguishing these matters to the client's reconnect logic: a network blip
 * should be retried, but `unauthorized` means the device has been revoked and
 * retrying forever is just noise in the server's logs.
 */
export const CloseCode = {
  AuthTimeout: 4001,
  Unauthorized: 4002,
  MalformedFrame: 4003,
  /** Another connection authenticated as this device; this one is stale. */
  Superseded: 4004,
} as const;
