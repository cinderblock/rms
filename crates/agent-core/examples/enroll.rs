//! Enroll this machine against a running control server.
//!
//! A development tool, and the cheapest way to prove that the Rust client and
//! the TypeScript server actually agree on the wire format — unit tests on each
//! side can both be self-consistently wrong.
//!
//! ```sh
//! RMS_SERVER=http://127.0.0.1:8787 RMS_ENROLL_PASSPHRASE=... \
//!   cargo run -p rms-agent-core --example enroll
//! ```
//!
//! The passphrase comes from the environment rather than argv, because argv is
//! readable by any process on the machine.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = std::env::var("RMS_SERVER").map_err(|_| "set RMS_SERVER")?;
    let passphrase =
        std::env::var("RMS_ENROLL_PASSPHRASE").map_err(|_| "set RMS_ENROLL_PASSPHRASE")?;

    let identity = rms_agent_core::DeviceIdentity::collect(env!("CARGO_PKG_VERSION"));
    println!("identity: {}", serde_json::to_string_pretty(&identity)?);

    let client = reqwest::Client::new();
    match rms_agent_core::enroll(&client, &server, &passphrase, env!("CARGO_PKG_VERSION")).await {
        Ok((response, key)) => {
            println!(
                "enrolled as {} ({})",
                response.display_name, response.device_id
            );
            println!("server: {}", response.server_name);
            println!("public key: {}", key.public_key_b64());
            if let Some(prior) = response.probable_reenrollment_of {
                println!("probable re-enrollment of: {prior}");
            }
        }
        Err(err) => {
            eprintln!("enrollment failed: {err}");
            std::process::exit(1);
        }
    }

    Ok(())
}
