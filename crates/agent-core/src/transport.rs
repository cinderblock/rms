//! The client-dialed control connection.
//!
//! The device dials out and holds the socket open. Nothing listens on a managed
//! host, so there is no inbound firewall hole and no port to expose — and the
//! socket being up *is* the online signal, so the server never has to poll to
//! know whether a machine is alive.
//!
//! This module owns the connect → authenticate → serve loop and the reconnect
//! policy. What a command actually *does* is deliberately not here: that is
//! [`CommandHandler`], supplied by whoever hosts this crate (the tray today, the
//! privileged service from phase 4).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{SinkExt as _, StreamExt as _};
use tokio_tungstenite::tungstenite::Message;

use crate::backoff::{self, Backoff};
use crate::config::AgentConfig;
use crate::endpoint::agent_ws_url;
use crate::frames::{AuthResponse, ClientFrame, ServerFrame};
use crate::identity::DeviceIdentity;
use crate::keys::DeviceKey;

pub type CommandFuture = Pin<Box<dyn Future<Output = Result<serde_json::Value, String>> + Send>>;

/// Executes a command verb. Returning `Err` produces a failed result frame
/// rather than dropping the connection — one bad command must not cost the
/// server its only channel to the machine.
pub trait CommandHandler: Send + Sync + 'static {
    fn handle(&self, verb: String, args: serde_json::Value) -> CommandFuture;
}

/// Handles the verbs that need no host cooperation. Hosts wrap this and add
/// their own — the tray adds `update.check`, which needs the Tauri updater.
pub struct BuiltinHandler {
    pub agent_version: String,
}

impl CommandHandler for BuiltinHandler {
    fn handle(&self, verb: String, _args: serde_json::Value) -> CommandFuture {
        let version = self.agent_version.clone();
        Box::pin(async move {
            match verb.as_str() {
                "ping" => Ok(serde_json::json!("pong")),
                "system.info" => Ok(serde_json::to_value(DeviceIdentity::collect(&version))
                    .map_err(|err| err.to_string())?),
                other => Err(format!("unsupported verb: {other}")),
            }
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("{0}")]
    Endpoint(#[from] crate::endpoint::EndpointError),
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("connection closed before the handshake completed")]
    ClosedDuringHandshake,
    #[error("server rejected this device: {0}")]
    Unauthorized(String),
    #[error("protocol error: {0}")]
    Protocol(String),
}

impl TransportError {
    /// Whether this is worth retrying soon. A revoked device retrying every few
    /// seconds achieves nothing but noise in the server's logs.
    fn is_authorization_failure(&self) -> bool {
        matches!(self, Self::Unauthorized(_))
    }
}

/// Connect once, serve until the connection ends, then return.
pub async fn run_session(
    config: &AgentConfig,
    key: &DeviceKey,
    handler: &Arc<dyn CommandHandler>,
    agent_version: &str,
) -> Result<(), TransportError> {
    let url = agent_ws_url(&config.server_url)?;
    tracing::debug!(%url, "connecting");

    let (mut socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|err| TransportError::Connect(err.to_string()))?;

    // --- handshake ---------------------------------------------------------

    let challenge = match next_frame(&mut socket).await? {
        Some(ServerFrame::Challenge { challenge }) => challenge,
        Some(ServerFrame::Error { code, message }) => {
            return Err(TransportError::Unauthorized(format!("{code}: {message}")));
        }
        Some(other) => {
            return Err(TransportError::Protocol(format!(
                "expected a challenge first, got {other:?}"
            )));
        }
        None => return Err(TransportError::ClosedDuringHandshake),
    };

    let nonce = BASE64
        .decode(&challenge.nonce)
        .map_err(|_| TransportError::Protocol("challenge nonce was not base64".into()))?;

    send(
        &mut socket,
        &ClientFrame::Auth {
            response: AuthResponse {
                device_id: config.device_id.clone(),
                signature: key.sign_b64(&nonce),
                identity: DeviceIdentity::collect(agent_version),
            },
        },
    )
    .await?;

    let heartbeat = match next_frame(&mut socket).await? {
        Some(ServerFrame::Ready {
            server_name,
            heartbeat_seconds,
            ..
        }) => {
            tracing::info!(server = %server_name, "connected");
            Duration::from_secs(heartbeat_seconds.max(5))
        }
        Some(ServerFrame::Error { code, message }) => {
            return Err(TransportError::Unauthorized(format!("{code}: {message}")));
        }
        Some(other) => {
            return Err(TransportError::Protocol(format!(
                "expected ready, got {other:?}"
            )));
        }
        None => return Err(TransportError::ClosedDuringHandshake),
    };

    // --- serve -------------------------------------------------------------

    // Ping at half the server's expected interval, so one lost ping does not
    // look like a dead connection.
    let mut ticker = tokio::time::interval(heartbeat / 2);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // the first tick completes immediately

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                send(&mut socket, &ClientFrame::Ping).await?;
            }
            frame = next_frame(&mut socket) => {
                match frame? {
                    None => {
                        tracing::info!("connection closed by the server");
                        return Ok(());
                    }
                    Some(ServerFrame::Command { id, verb, args }) => {
                        // Run inline rather than spawning: commands are rare and
                        // ordering is easier to reason about, and a spawned task
                        // would outlive the socket it needs to answer on.
                        let outcome = handler.handle(verb.clone(), args).await;
                        let reply = match outcome {
                            Ok(output) => ClientFrame::Result {
                                id, ok: true, output: Some(output), error: None,
                            },
                            Err(error) => {
                                tracing::warn!(%verb, %error, "command failed");
                                ClientFrame::Result { id, ok: false, output: None, error: Some(error) }
                            }
                        };
                        send(&mut socket, &reply).await?;
                    }
                    Some(ServerFrame::Error { code, message }) => {
                        return Err(TransportError::Unauthorized(format!("{code}: {message}")));
                    }
                    // Pong, and anything a newer server introduces, are ignored
                    // rather than fatal.
                    Some(_) => {}
                }
            }
        }
    }
}

/// Connect, serve, reconnect, forever.
pub async fn run_forever(
    config: AgentConfig,
    key: DeviceKey,
    handler: Arc<dyn CommandHandler>,
    agent_version: String,
) -> ! {
    let mut backoff = Backoff::new();

    loop {
        match run_session(&config, &key, &handler, &agent_version).await {
            Ok(()) => {
                // A clean close is normal — a server restart, say. The session
                // was authenticated, so start over from the short delay.
                backoff.reset();
            }
            Err(err) => {
                if err.is_authorization_failure() {
                    tracing::error!(%err, "device is not authorized; backing off");
                    backoff.set(backoff::UNAUTHORIZED);
                } else {
                    tracing::warn!(%err, "connection failed");
                }
            }
        }

        let delay = backoff.next_delay();
        tracing::debug!(?delay, "reconnecting after delay");
        tokio::time::sleep(delay).await;
    }
}

// ---------------------------------------------------------------- plumbing

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Next application frame, or `None` once the socket closes.
///
/// Non-text frames are skipped rather than treated as protocol errors: the
/// library answers control frames itself, and a stray binary frame is not worth
/// dropping a connection over.
async fn next_frame(socket: &mut Socket) -> Result<Option<ServerFrame>, TransportError> {
    loop {
        let Some(message) = socket.next().await else {
            return Ok(None);
        };

        match message.map_err(|err| TransportError::Connect(err.to_string()))? {
            Message::Text(text) => {
                return serde_json::from_str(&text)
                    .map(Some)
                    .map_err(|err| TransportError::Protocol(err.to_string()));
            }
            Message::Close(_) => return Ok(None),
            _ => continue,
        }
    }
}

async fn send(socket: &mut Socket, frame: &ClientFrame) -> Result<(), TransportError> {
    let json =
        serde_json::to_string(frame).map_err(|err| TransportError::Protocol(err.to_string()))?;
    socket
        .send(Message::Text(json.into()))
        .await
        .map_err(|err| TransportError::Connect(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn builtin_handler_answers_ping() {
        let handler = BuiltinHandler {
            agent_version: "0.1.0".into(),
        };
        let result = handler.handle("ping".into(), serde_json::Value::Null).await;
        assert_eq!(result.unwrap(), serde_json::json!("pong"));
    }

    #[tokio::test]
    async fn builtin_handler_reports_system_info() {
        let handler = BuiltinHandler {
            agent_version: "0.1.0".into(),
        };
        let value = handler
            .handle("system.info".into(), serde_json::Value::Null)
            .await
            .unwrap();

        assert!(value["hostname"].is_string());
        assert_eq!(value["agentVersion"], "0.1.0");
    }

    /// An unknown verb must fail the *command*, not the connection — otherwise a
    /// server rolling out a new verb would disconnect every older agent.
    #[tokio::test]
    async fn an_unknown_verb_is_a_failed_command_not_an_error() {
        let handler = BuiltinHandler {
            agent_version: "0.1.0".into(),
        };
        let result = handler
            .handle("definitely.not.a.verb".into(), serde_json::Value::Null)
            .await;

        assert!(result.unwrap_err().contains("unsupported verb"));
    }

    #[test]
    fn authorization_failures_are_distinguished_from_network_failures() {
        assert!(TransportError::Unauthorized("revoked".into()).is_authorization_failure());
        assert!(!TransportError::Connect("dns".into()).is_authorization_failure());
        assert!(!TransportError::ClosedDuringHandshake.is_authorization_failure());
    }
}
