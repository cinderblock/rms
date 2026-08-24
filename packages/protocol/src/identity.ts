import { z } from "zod";

/**
 * What a device says about itself at registration.
 *
 * Every field here is **client-asserted and therefore untrusted**. It exists so
 * a human can recognise a machine in the UI and so the server can notice a
 * probable re-enrollment. None of it is ever an input to an authorization
 * decision — the device's Ed25519 public key is the identity, and these are
 * labels attached to it.
 */

export const Platform = z.enum(["windows", "linux", "macos"]);
export type Platform = z.infer<typeof Platform>;

export const Arch = z.enum(["x86_64", "aarch64"]);
export type Arch = z.infer<typeof Arch>;

export const DeviceIdentity = z.object({
  /** Max length is the DNS limit; hostnames longer than this aren't real. */
  hostname: z.string().min(1).max(253),

  /**
   * A stable per-installation machine identifier, where the OS offers one:
   *
   * - Windows — `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`
   * - Linux   — `/etc/machine-id` (fall back to `/var/lib/dbus/machine-id`)
   * - macOS   — IOKit `IOPlatformUUID`
   *
   * Optional because a container or a hardened image may have none, and a
   * missing value must not block enrollment.
   */
  machineId: z.string().min(1).max(128).optional(),

  os: Platform,
  /** OS build or release string, free-form: "26200", "6.8.0-generic", "15.3". */
  osVersion: z.string().max(128),
  arch: Arch,

  /** Account the agent process runs as — "SYSTEM", "root", "camer". */
  user: z.string().max(256),

  /** Semver of the agent at the moment it enrolled. */
  agentVersion: z.string().max(32),

  /**
   * Linux only (`/proc/sys/kernel/random/boot_id`). Changes every boot, so it's
   * useful for spotting a host that is silently restarting in a loop.
   */
  bootId: z.string().max(128).optional(),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentity>;
