//! The session wire format, Rust side.
//!
//! Mirrors `packages/protocol/src/session.ts`. Until the JSON-Schema → `typify`
//! generation lands (see `plans/architecture.md`), these are hand-written and
//! the [`tests`] module below is what stops them drifting: every literal here is
//! asserted against the exact strings the server emits and accepts.

use serde::{Deserialize, Serialize};

use crate::identity::DeviceIdentity;

/// Server expects a frame at least this often. Overridden by the value the
/// server sends in `ready`.
pub const DEFAULT_HEARTBEAT_SECONDS: u64 = 30;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Challenge {
        challenge: Challenge,
    },
    Ready {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "serverName")]
        server_name: String,
        #[serde(rename = "heartbeatSeconds")]
        heartbeat_seconds: u64,
    },
    Command {
        id: String,
        verb: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    Error {
        code: String,
        message: String,
    },
    Pong,
    /// Anything the server adds later. Being permissive in this one place means
    /// a newer server does not knock older agents off the fleet — which matters
    /// a great deal when the agent is how you'd push the fix.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Challenge {
    pub nonce: String,
    #[serde(rename = "serverTime")]
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Auth {
        response: AuthResponse,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub device_id: String,
    pub signature: String,
    pub identity: DeviceIdentity,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> DeviceIdentity {
        DeviceIdentity {
            hostname: "steamboat".into(),
            machine_id: None,
            os: "linux".into(),
            os_version: "6.8".into(),
            arch: "x86_64".into(),
            user: "root".into(),
            agent_version: "0.1.0".into(),
            boot_id: None,
        }
    }

    #[test]
    fn parses_a_challenge() {
        let frame: ServerFrame = serde_json::from_str(
            r#"{"type":"challenge","challenge":{"nonce":"abc","serverTime":"2026-08-24T17:00:00Z"}}"#,
        )
        .unwrap();

        match frame {
            ServerFrame::Challenge { challenge } => assert_eq!(challenge.nonce, "abc"),
            other => panic!("expected challenge, got {other:?}"),
        }
    }

    #[test]
    fn parses_ready_with_camel_case_fields() {
        let frame: ServerFrame = serde_json::from_str(
            r#"{"type":"ready","deviceId":"d","serverName":"control","heartbeatSeconds":30}"#,
        )
        .unwrap();

        match frame {
            ServerFrame::Ready {
                device_id,
                server_name,
                heartbeat_seconds,
            } => {
                assert_eq!(device_id, "d");
                assert_eq!(server_name, "control");
                assert_eq!(heartbeat_seconds, 30);
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_command_with_default_args() {
        let frame: ServerFrame =
            serde_json::from_str(r#"{"type":"command","id":"1","verb":"ping"}"#).unwrap();

        match frame {
            ServerFrame::Command { verb, args, .. } => {
                assert_eq!(verb, "ping");
                assert!(args.is_null());
            }
            other => panic!("expected command, got {other:?}"),
        }
    }

    /// The compatibility property. A server that learns a new frame type must
    /// not disconnect every agent that predates it — the agent is the thing
    /// that would carry the fix.
    #[test]
    fn an_unrecognised_frame_type_is_not_an_error() {
        let frame: ServerFrame =
            serde_json::from_str(r#"{"type":"something_new","whatever":1}"#).unwrap();
        assert!(matches!(frame, ServerFrame::Unknown));
    }

    #[test]
    fn auth_serializes_to_the_shape_the_server_parses() {
        let json = serde_json::to_value(ClientFrame::Auth {
            response: AuthResponse {
                device_id: "d".into(),
                signature: "s".into(),
                identity: identity(),
            },
        })
        .unwrap();

        assert_eq!(json["type"], "auth");
        assert_eq!(json["response"]["deviceId"], "d");
        assert_eq!(json["response"]["signature"], "s");
        assert_eq!(json["response"]["identity"]["hostname"], "steamboat");
    }

    #[test]
    fn ping_is_a_bare_tagged_object() {
        let json = serde_json::to_string(&ClientFrame::Ping).unwrap();
        assert_eq!(json, r#"{"type":"ping"}"#);
    }

    #[test]
    fn a_successful_result_omits_the_error_field() {
        let json = serde_json::to_value(ClientFrame::Result {
            id: "1".into(),
            ok: true,
            output: Some(serde_json::json!("pong")),
            error: None,
        })
        .unwrap();

        assert_eq!(json["ok"], true);
        assert_eq!(json["output"], "pong");
        // Absent, not null — the server's schema marks it optional.
        assert!(json.get("error").is_none());
    }

    #[test]
    fn a_failed_result_omits_the_output_field() {
        let json = serde_json::to_value(ClientFrame::Result {
            id: "1".into(),
            ok: false,
            output: None,
            error: Some("boom".into()),
        })
        .unwrap();

        assert_eq!(json["error"], "boom");
        assert!(json.get("output").is_none());
    }
}
