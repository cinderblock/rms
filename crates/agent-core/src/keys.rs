//! The device keypair.
//!
//! This is the *only* thing that actually identifies a machine to the control
//! server. The enrollment passphrase buys exactly one thing — the right to
//! register this public key once — and is discarded immediately afterwards.
//!
//! The private key never leaves the host and is never transmitted. It lives in
//! the OS keystore (DPAPI / Keychain / Secret Service) rather than a file,
//! because a file is trivially readable by anything running as the same user and
//! ends up in backups.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, Signer as _, SigningKey};

const KEYRING_SERVICE: &str = "rms-agent";
const KEYRING_USER: &str = "device-key";

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("could not reach the OS keystore: {0}")]
    Keystore(#[from] keyring::Error),
    #[error("stored device key is malformed; the agent must re-enroll")]
    Malformed,
}

pub struct DeviceKey {
    signing: SigningKey,
}

impl DeviceKey {
    /// Generate a fresh identity. Does not persist — call [`DeviceKey::store`]
    /// only once enrollment has actually succeeded, so a failed attempt doesn't
    /// leave a key behind that the server has never heard of.
    ///
    /// Seeded straight from the OS CSPRNG via `getrandom` rather than through
    /// `rand`: `ed25519-dalek` and `rand` track `rand_core` on independent
    /// schedules, and a mismatch between them is a confusing trait error for
    /// something this simple. 32 OS-random bytes *are* an Ed25519 private key.
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).expect("OS random number generator is unavailable");

        Self {
            signing: SigningKey::from_bytes(&seed),
        }
    }

    pub fn load() -> Result<Option<Self>, KeyError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;

        let stored = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(err) => return Err(err.into()),
        };

        let bytes = BASE64.decode(&stored).map_err(|_| KeyError::Malformed)?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| KeyError::Malformed)?;

        Ok(Some(Self {
            signing: SigningKey::from_bytes(&bytes),
        }))
    }

    pub fn store(&self) -> Result<(), KeyError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
        entry.set_password(&BASE64.encode(self.signing.to_bytes()))?;
        Ok(())
    }

    /// Removes the key. The device is then unknown to itself and would have to
    /// enroll again; the server-side record is unaffected and should be deleted
    /// separately.
    pub fn delete() -> Result<(), KeyError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Base64 of the 32 raw public key bytes — 44 characters, which is exactly
    /// what the server's schema requires.
    pub fn public_key_b64(&self) -> String {
        BASE64.encode(self.signing.verifying_key().to_bytes())
    }

    /// Signs a server-issued nonce. Base64 of 64 raw bytes — 88 characters.
    pub fn sign_b64(&self, message: &[u8]) -> String {
        let signature: Signature = self.signing.sign(message);
        BASE64.encode(signature.to_bytes())
    }
}

impl std::fmt::Debug for DeviceKey {
    /// Hand-written so a stray `{:?}` in a log line can never print the private
    /// half.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKey")
            .field("public_key", &self.public_key_b64())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier as _, VerifyingKey};

    #[test]
    fn public_key_is_44_base64_characters() {
        // The server schema pins this length; drifting would mean every
        // enrollment fails validation rather than failing loudly here.
        assert_eq!(DeviceKey::generate().public_key_b64().len(), 44);
    }

    #[test]
    fn signature_is_88_base64_characters() {
        assert_eq!(DeviceKey::generate().sign_b64(b"nonce").len(), 88);
    }

    #[test]
    fn signatures_verify_against_the_advertised_public_key() {
        let key = DeviceKey::generate();
        let nonce = b"a server-issued challenge";

        let public = BASE64.decode(key.public_key_b64()).unwrap();
        let public: [u8; 32] = public.try_into().unwrap();
        let verifying = VerifyingKey::from_bytes(&public).unwrap();

        let signature = BASE64.decode(key.sign_b64(nonce)).unwrap();
        let signature: [u8; 64] = signature.try_into().unwrap();

        assert!(
            verifying
                .verify(nonce, &Signature::from_bytes(&signature))
                .is_ok()
        );
        assert!(
            verifying
                .verify(b"a different challenge", &Signature::from_bytes(&signature))
                .is_err()
        );
    }

    #[test]
    fn generated_keys_are_distinct() {
        assert_ne!(
            DeviceKey::generate().public_key_b64(),
            DeviceKey::generate().public_key_b64()
        );
    }

    #[test]
    fn debug_never_prints_the_private_half() {
        let key = DeviceKey::generate();
        let rendered = format!("{key:?}");

        assert!(rendered.contains(&key.public_key_b64()));
        assert!(!rendered.contains(&BASE64.encode(key.signing.to_bytes())));
    }
}
