import { describe, expect, test } from "bun:test";

import { type Connection, Registry } from "./registry.ts";

function fakeConnection(deviceId: string) {
  const sent: unknown[] = [];
  const closed: { code: number; reason: string }[] = [];

  const connection: Connection = {
    deviceId,
    connectedAt: 0,
    send: (frame) => void sent.push(frame),
    close: (code, reason) => void closed.push({ code, reason }),
  };

  return { connection, sent, closed };
}

describe("connections", () => {
  test("a device is online once added and offline once removed", () => {
    const registry = new Registry();
    const a = fakeConnection("device-a");

    registry.add(a.connection);
    expect(registry.isOnline("device-a")).toBe(true);
    expect(registry.onlineDeviceIds()).toEqual(["device-a"]);

    registry.remove(a.connection);
    expect(registry.isOnline("device-a")).toBe(false);
  });

  // A laptop that changes networks leaves a socket the server still thinks is
  // open. The reconnect is the real one.
  test("reconnecting displaces and closes the stale connection", () => {
    const registry = new Registry();
    const first = fakeConnection("device-a");
    const second = fakeConnection("device-a");

    registry.add(first.connection);
    registry.add(second.connection);

    expect(first.closed).toEqual([{ code: 4004, reason: "superseded by a newer connection" }]);
    expect(registry.get("device-a")).toBe(second.connection);
    expect(registry.size).toBe(1);
  });

  // The stale socket's close event arrives *after* the new one registered. If
  // remove() were unconditional it would mark a live device offline.
  test("a late close from a superseded connection does not evict its replacement", () => {
    const registry = new Registry();
    const first = fakeConnection("device-a");
    const second = fakeConnection("device-a");

    registry.add(first.connection);
    registry.add(second.connection);
    registry.remove(first.connection);

    expect(registry.isOnline("device-a")).toBe(true);
    expect(registry.get("device-a")).toBe(second.connection);
  });

  test("devices are tracked independently", () => {
    const registry = new Registry();
    const a = fakeConnection("device-a");
    const b = fakeConnection("device-b");

    registry.add(a.connection);
    registry.add(b.connection);
    registry.remove(a.connection);

    expect(registry.onlineDeviceIds()).toEqual(["device-b"]);
    expect(b.closed).toEqual([]);
  });
});

describe("pending commands", () => {
  const settled = () => {
    let result: unknown;
    return {
      resolve: (value: unknown) => void (result = value),
      get value() {
        return result;
      },
    };
  };

  test("a result settles the matching command", () => {
    const registry = new Registry();
    const sink = settled();
    registry.trackCommand("cmd-1", {
      verb: "ping",
      deviceId: "device-a",
      sentAt: 0,
      resolve: sink.resolve,
    });

    expect(registry.settleCommand("cmd-1", "device-a", { ok: true, output: "pong" })).toBe(true);
    expect(sink.value).toEqual({ ok: true, output: "pong" });
  });

  // A command id is a capability. One device answering for another's command
  // would let a compromised host forge results across the fleet.
  test("a different device cannot settle someone else's command", () => {
    const registry = new Registry();
    const sink = settled();
    registry.trackCommand("cmd-1", {
      verb: "ping",
      deviceId: "device-a",
      sentAt: 0,
      resolve: sink.resolve,
    });

    expect(registry.settleCommand("cmd-1", "device-b", { ok: true })).toBe(false);
    expect(sink.value).toBeUndefined();
  });

  test("settling twice is refused the second time", () => {
    const registry = new Registry();
    const sink = settled();
    registry.trackCommand("cmd-1", {
      verb: "ping",
      deviceId: "device-a",
      sentAt: 0,
      resolve: sink.resolve,
    });

    expect(registry.settleCommand("cmd-1", "device-a", { ok: true })).toBe(true);
    expect(registry.settleCommand("cmd-1", "device-a", { ok: true })).toBe(false);
  });

  test("an unknown command id is refused", () => {
    expect(new Registry().settleCommand("nope", "device-a", { ok: true })).toBe(false);
  });

  // Otherwise a caller waiting on a command hangs forever when the device drops.
  test("disconnecting fails that device's outstanding commands", () => {
    const registry = new Registry();
    const a = fakeConnection("device-a");
    const sink = settled();

    registry.add(a.connection);
    registry.trackCommand("cmd-1", {
      verb: "ping",
      deviceId: "device-a",
      sentAt: 0,
      resolve: sink.resolve,
    });
    registry.remove(a.connection);

    expect(sink.value).toEqual({ ok: false, error: "device disconnected" });
  });

  test("disconnecting leaves another device's commands alone", () => {
    const registry = new Registry();
    const a = fakeConnection("device-a");
    const sink = settled();

    registry.add(a.connection);
    registry.trackCommand("cmd-1", {
      verb: "ping",
      deviceId: "device-b",
      sentAt: 0,
      resolve: sink.resolve,
    });
    registry.remove(a.connection);

    expect(sink.value).toBeUndefined();
  });

  test("commands expire once they exceed the timeout", () => {
    const registry = new Registry();
    const fresh = settled();
    const stale = settled();

    registry.trackCommand("old", {
      verb: "ping",
      deviceId: "device-a",
      sentAt: 0,
      resolve: stale.resolve,
    });
    registry.trackCommand("new", {
      verb: "ping",
      deviceId: "device-a",
      sentAt: 9_000,
      resolve: fresh.resolve,
    });

    expect(registry.expireCommands(10_000, 5_000)).toBe(1);
    expect(stale.value).toEqual({ ok: false, error: "timed out" });
    expect(fresh.value).toBeUndefined();
  });
});
