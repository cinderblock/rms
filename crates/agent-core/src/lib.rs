//! Shared agent logic: device identity, the keypair, and enrollment.
//!
//! This lives in its own crate rather than inside the tray app because of where
//! the project is going. Today the tray hosts it in-process; from phase 4 the
//! privileged `agentd` service hosts it instead and the tray becomes an IPC
//! client that only executes user-session work. Keeping the boundary explicit
//! from the start means that move is a relocation, not a rewrite.
//!
//! See `plans/architecture.md` → "Three-process model on a managed host".

pub mod backoff;
pub mod config;
pub mod endpoint;
pub mod enroll;
pub mod frames;
pub mod identity;
pub mod keys;

pub use backoff::Backoff;
pub use config::{AgentConfig, ConfigError, is_enrolled};
pub use endpoint::agent_ws_url;
pub use enroll::{EnrollError, EnrollResponse, enroll};
pub use frames::{AuthResponse, ClientFrame, ServerFrame};
pub use identity::DeviceIdentity;
pub use keys::{DeviceKey, KeyError};
