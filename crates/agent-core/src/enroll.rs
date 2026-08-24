//! Joining the fleet.
//!
//! One POST. The keypair is generated first and only persisted once the server
//! has accepted it — a key stored after a failed attempt would be a credential
//! the server has never heard of, and the agent would loop forever presenting it.

use serde::{Deserialize, Serialize};

use crate::identity::DeviceIdentity;
use crate::keys::{DeviceKey, KeyError};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollRequest<'a> {
    public_key: &'a str,
    passphrase: &'a str,
    identity: &'a DeviceIdentity,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub device_id: String,
    pub display_name: String,
    pub server_name: String,
    pub probable_reenrollment_of: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerError {
    error: String,
    message: String,
    #[serde(default)]
    retry_after: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum EnrollError {
    #[error("could not reach the control server: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("{0}")]
    Key(#[from] KeyError),

    #[error("the enrollment passphrase was not accepted")]
    InvalidPassphrase,

    #[error("this server is not accepting new devices right now")]
    Closed,

    /// Worth surfacing distinctly: on a shared passphrase this is the signal
    /// that someone is guessing, and the wait can be an hour.
    #[error("too many enrollment attempts; try again in {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },

    #[error("this device is already enrolled")]
    AlreadyEnrolled,

    #[error("the server rejected the request as malformed: {0}")]
    Rejected(String),

    #[error("unexpected response from {url}: HTTP {status}")]
    Unexpected { url: String, status: u16 },
}

/// Enroll this machine and persist the resulting key on success.
///
/// `base_url` is what the user typed — trailing slashes and all.
pub async fn enroll(
    client: &reqwest::Client,
    base_url: &str,
    passphrase: &str,
    agent_version: &str,
) -> Result<(EnrollResponse, DeviceKey), EnrollError> {
    let key = DeviceKey::generate();
    let identity = DeviceIdentity::collect(agent_version);
    let url = format!("{}/api/enroll", base_url.trim_end_matches('/'));

    let response = client
        .post(&url)
        .json(&EnrollRequest {
            public_key: &key.public_key_b64(),
            passphrase,
            identity: &identity,
        })
        .send()
        .await?;

    let status = response.status();

    if status.is_success() {
        let body: EnrollResponse = response.json().await?;
        // Only now is the key worth keeping.
        key.store()?;
        tracing::info!(
            device_id = %body.device_id,
            server = %body.server_name,
            "enrolled"
        );
        return Ok((body, key));
    }

    // Prefer the server's own error code; fall back to the status if the body
    // isn't the shape we expect, so a proxy's HTML error page doesn't turn into
    // a confusing parse failure.
    let Ok(err) = response.json::<ServerError>().await else {
        return Err(EnrollError::Unexpected {
            url,
            status: status.as_u16(),
        });
    };

    Err(match err.error.as_str() {
        "invalid_passphrase" => EnrollError::InvalidPassphrase,
        "enrollment_closed" => EnrollError::Closed,
        "rate_limited" => EnrollError::RateLimited {
            retry_after_secs: err.retry_after.unwrap_or(60),
        },
        "already_enrolled" => EnrollError::AlreadyEnrolled,
        "invalid_request" => EnrollError::Rejected(err.message),
        _ => EnrollError::Unexpected {
            url,
            status: status.as_u16(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_serializes_to_the_wire_shape_the_server_validates() {
        let key = DeviceKey::generate();
        let identity = DeviceIdentity::collect("0.1.0");
        let public = key.public_key_b64();

        let json = serde_json::to_value(EnrollRequest {
            public_key: &public,
            passphrase: "k7m9-x2qp-4rtv-8wny-3jdc",
            identity: &identity,
        })
        .unwrap();

        assert_eq!(json["publicKey"].as_str().unwrap().len(), 44);
        assert_eq!(json["passphrase"], "k7m9-x2qp-4rtv-8wny-3jdc");
        assert!(json["identity"]["hostname"].is_string());
        assert!(json["identity"]["agentVersion"].is_string());
    }

    #[test]
    fn response_parses_camel_case_and_a_null_reenrollment() {
        let body: EnrollResponse = serde_json::from_str(
            r#"{"deviceId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301",
                "displayName":"steamboat","serverName":"control",
                "probableReenrollmentOf":null}"#,
        )
        .unwrap();

        assert_eq!(body.display_name, "steamboat");
        assert!(body.probable_reenrollment_of.is_none());
    }

    #[test]
    fn response_carries_a_reenrollment_link_when_the_server_sets_one() {
        let body: EnrollResponse = serde_json::from_str(
            r#"{"deviceId":"a","displayName":"b","serverName":"c",
                "probableReenrollmentOf":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}"#,
        )
        .unwrap();

        assert_eq!(
            body.probable_reenrollment_of.as_deref(),
            Some("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        );
    }

    #[test]
    fn server_error_retry_after_is_optional() {
        let err: ServerError =
            serde_json::from_str(r#"{"error":"invalid_passphrase","message":"nope"}"#).unwrap();
        assert!(err.retry_after.is_none());

        let limited: ServerError = serde_json::from_str(
            r#"{"error":"rate_limited","message":"slow down","retryAfter":300}"#,
        )
        .unwrap();
        assert_eq!(limited.retry_after, Some(300));
    }
}
