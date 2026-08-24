import type { CommandVerb, ServerFrame } from "@rms/protocol";

/**
 * Who is connected right now.
 *
 * In memory on purpose: a live socket cannot outlive the process holding it, so
 * persisting this would only ever produce a list of devices that *were* online
 * before the last restart. `last_seen_at` in SQLite is the durable record; this
 * is the live one.
 */

export interface Connection {
  deviceId: string;
  connectedAt: number;
  send(frame: ServerFrame): void;
  close(code: number, reason: string): void;
}

/**
 * `error` is explicitly `| undefined` rather than merely optional: with
 * `exactOptionalPropertyTypes`, forwarding a parsed frame's absent field means
 * passing `undefined`, and the alternative is rebuilding the object field by
 * field at every call site.
 */
export interface CommandResult {
  ok: boolean;
  output?: unknown;
  error?: string | undefined;
}

export interface PendingCommand {
  verb: CommandVerb;
  deviceId: string;
  sentAt: number;
  resolve(result: CommandResult): void;
}

export class Registry {
  readonly #connections = new Map<string, Connection>();
  readonly #pending = new Map<string, PendingCommand>();

  /**
   * Register a newly authenticated connection, displacing any earlier one for
   * the same device.
   *
   * A device that drops off a network leaves a socket the server still thinks is
   * open — the far end is gone but nothing said so. When it reconnects, the new
   * connection is the real one, so the old is closed rather than kept. Without
   * this, a laptop moving between networks accumulates ghosts and commands get
   * routed to a socket nobody is reading.
   */
  add(connection: Connection): void {
    const existing = this.#connections.get(connection.deviceId);
    if (existing && existing !== connection) {
      existing.close(4004, "superseded by a newer connection");
    }
    this.#connections.set(connection.deviceId, connection);
  }

  /**
   * Remove a connection, but only if it is still the current one. A late close
   * event from a superseded socket must not evict the connection that replaced
   * it — that would silently mark a live device offline.
   */
  remove(connection: Connection): void {
    if (this.#connections.get(connection.deviceId) === connection) {
      this.#connections.delete(connection.deviceId);
    }
    this.#failPendingFor(connection.deviceId, "device disconnected");
  }

  get(deviceId: string): Connection | undefined {
    return this.#connections.get(deviceId);
  }

  isOnline(deviceId: string): boolean {
    return this.#connections.has(deviceId);
  }

  onlineDeviceIds(): string[] {
    return [...this.#connections.keys()];
  }

  get size(): number {
    return this.#connections.size;
  }

  trackCommand(id: string, command: PendingCommand): void {
    this.#pending.set(id, command);
  }

  /** Returns false when the id is unknown — a duplicate or very late result. */
  settleCommand(id: string, deviceId: string, result: CommandResult): boolean {
    const pending = this.#pending.get(id);
    // Check the device too: a command id is a capability, and one device must
    // not be able to answer for a command issued to another.
    if (!pending || pending.deviceId !== deviceId) return false;

    this.#pending.delete(id);
    pending.resolve(result);
    return true;
  }

  /** Fail commands that have been outstanding too long, so callers aren't hung. */
  expireCommands(now: number, timeoutMs: number): number {
    let expired = 0;
    for (const [id, pending] of this.#pending) {
      if (now - pending.sentAt >= timeoutMs) {
        this.#pending.delete(id);
        pending.resolve({ ok: false, error: "timed out" });
        expired += 1;
      }
    }
    return expired;
  }

  #failPendingFor(deviceId: string, reason: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.deviceId === deviceId) {
        this.#pending.delete(id);
        pending.resolve({ ok: false, error: reason });
      }
    }
  }
}
