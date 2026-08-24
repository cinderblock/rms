//! Deriving the WebSocket endpoint from the configured server URL.
//!
//! Small enough to look obvious and fiddly enough to get wrong, so it is its own
//! function with its own tests. The security-relevant part is the scheme:
//! `https` must become `wss` and never silently fall back to plaintext, because
//! a downgrade here would put a device's signed handshake on the wire in clear.

pub const AGENT_PATH: &str = "/api/agent";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EndpointError {
    #[error("server URL is empty")]
    Empty,
    #[error("server URL must start with http:// or https://, got {0:?}")]
    UnsupportedScheme(String),
}

/// `https://control.example.com` → `wss://control.example.com/api/agent`
///
/// `http` is accepted because local development runs without TLS, but it maps to
/// `ws` — it is never upgraded to `wss` on the caller's behalf, and `https` is
/// never downgraded.
pub fn agent_ws_url(base_url: &str) -> Result<String, EndpointError> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err(EndpointError::Empty);
    }

    // Match the scheme *before* trimming trailing slashes. Doing it the other
    // way round turns "https://" into "https:", which then fails the prefix
    // check and gets reported as an unsupported scheme — a misleading error for
    // what is actually a missing host.
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("wss", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("ws", rest)
    } else {
        return Err(EndpointError::UnsupportedScheme(trimmed.to_owned()));
    };

    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return Err(EndpointError::Empty);
    }

    Ok(format!("{scheme}://{rest}{AGENT_PATH}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_becomes_wss() {
        assert_eq!(
            agent_ws_url("https://control.example.com").unwrap(),
            "wss://control.example.com/api/agent"
        );
    }

    #[test]
    fn http_becomes_ws_for_local_development() {
        assert_eq!(
            agent_ws_url("http://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787/api/agent"
        );
    }

    #[test]
    fn trailing_slashes_and_whitespace_are_tolerated() {
        assert_eq!(
            agent_ws_url("  https://control.example.com///  ").unwrap(),
            "wss://control.example.com/api/agent"
        );
    }

    #[test]
    fn a_base_path_is_preserved() {
        assert_eq!(
            agent_ws_url("https://example.com/rms").unwrap(),
            "wss://example.com/rms/api/agent"
        );
    }

    // A silent downgrade would put a device's signed handshake on the wire in
    // clear. Anything that isn't recognisably http(s) is an error, not a guess.
    #[test]
    fn an_unknown_scheme_is_rejected_rather_than_guessed() {
        assert!(matches!(
            agent_ws_url("control.example.com"),
            Err(EndpointError::UnsupportedScheme(_))
        ));
        assert!(matches!(
            agent_ws_url("ftp://control.example.com"),
            Err(EndpointError::UnsupportedScheme(_))
        ));
        // Already-ws URLs are rejected too: the config field is documented as a
        // base HTTP URL, and accepting both invites one that works for
        // enrollment and not the socket, or vice versa.
        assert!(matches!(
            agent_ws_url("wss://control.example.com"),
            Err(EndpointError::UnsupportedScheme(_))
        ));
    }

    #[test]
    fn an_empty_url_is_rejected() {
        assert_eq!(agent_ws_url(""), Err(EndpointError::Empty));
        assert_eq!(agent_ws_url("   "), Err(EndpointError::Empty));
        assert_eq!(agent_ws_url("https://"), Err(EndpointError::Empty));
    }
}
