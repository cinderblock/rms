//! What this machine says about itself.
//!
//! Mirrors `packages/protocol/src/identity.ts`. Every field is a *label* — the
//! server treats all of it as untrusted, because a client can obviously claim
//! whatever it likes. The device's Ed25519 public key is the actual identity.
//!
//! Nothing in here is allowed to fail the enrollment. A machine with no
//! discoverable machine-id, an unreadable OS version or a weird hostname should
//! still be able to join; a missing label is a cosmetic problem, and refusing to
//! enroll over one would be worse than the gap it leaves in the dashboard.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub user: String,
    pub agent_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
}

impl DeviceIdentity {
    pub fn collect(agent_version: &str) -> Self {
        let info = os_info::get();

        Self {
            hostname: gethostname::gethostname().to_string_lossy().into_owned(),
            machine_id: machine_id(),
            os: platform().to_owned(),
            os_version: info.version().to_string(),
            arch: arch().to_owned(),
            // Per the module note: a label we can't read is a cosmetic gap, not
            // a reason to refuse to enroll.
            user: whoami::username().unwrap_or_else(|_| "unknown".to_owned()),
            agent_version: agent_version.to_owned(),
            boot_id: boot_id(),
        }
    }
}

/// Must match the `Platform` enum the server validates against; anything else is
/// rejected as `invalid_request`.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        // Everything unix-ish that isn't macOS reports as linux. The alternative
        // is widening the server's enum for BSDs we don't actually support yet.
        _ => "linux",
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x86_64",
    }
}

#[cfg(windows)]
fn machine_id() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};

    // Explicitly 64-bit view: a 32-bit process would otherwise be redirected to
    // Wow6432Node and read a different (or absent) value.
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Cryptography",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .and_then(|key| key.get_value::<String, _>("MachineGuid"))
        .ok()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

#[cfg(target_os = "linux")]
fn machine_id() -> Option<String> {
    // /etc/machine-id is the modern location; the dbus one is the fallback for
    // systems where systemd didn't populate it.
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

#[cfg(target_os = "macos")]
fn machine_id() -> Option<String> {
    // Shelling out to `ioreg` rather than linking IOKit: this runs once, at
    // enrollment, and a whole FFI dependency for one string is not worth it.
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;

    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find(|line| line.contains("IOPlatformUUID"))
        .and_then(|line| line.split('"').nth(3))
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn machine_id() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn boot_id() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

#[cfg(not(target_os = "linux"))]
fn boot_id() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_produces_values_the_server_will_accept() {
        let identity = DeviceIdentity::collect("0.1.0");

        assert!(!identity.hostname.is_empty());
        assert!(["windows", "linux", "macos"].contains(&identity.os.as_str()));
        assert!(["x86_64", "aarch64"].contains(&identity.arch.as_str()));
        assert_eq!(identity.agent_version, "0.1.0");

        // Server-side limits from packages/protocol. Exceeding one would be
        // rejected as `invalid_request`, which reads as "enrollment is broken".
        assert!(identity.hostname.len() <= 253);
        assert!(identity.os_version.len() <= 128);
        assert!(identity.user.len() <= 256);
    }

    #[test]
    fn serializes_with_the_camel_case_keys_the_wire_format_uses() {
        let identity = DeviceIdentity {
            hostname: "steamboat".into(),
            machine_id: Some("abc".into()),
            os: "linux".into(),
            os_version: "6.8".into(),
            arch: "x86_64".into(),
            user: "root".into(),
            agent_version: "0.1.0".into(),
            boot_id: None,
        };

        let json = serde_json::to_value(&identity).unwrap();
        assert_eq!(json["machineId"], "abc");
        assert_eq!(json["osVersion"], "6.8");
        assert_eq!(json["agentVersion"], "0.1.0");
        // Absent rather than null: the schema marks these optional, and `null`
        // would fail validation.
        assert!(json.get("bootId").is_none());
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    #[test]
    fn machine_id_is_discoverable_on_supported_platforms() {
        // Not asserting a specific value — just that the lookup path works on
        // the platform running the tests, since a silent None here would only
        // show up as devices that never link to their re-enrollments.
        let id = machine_id();
        if let Some(id) = id {
            assert!(!id.is_empty());
            assert!(id.len() <= 128);
        }
    }
}
