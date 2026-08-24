//! Delete this machine's device key from the OS keystore.
//!
//! Local-only: the server-side record survives and must be deleted separately.
//! After this the agent is unknown to itself and would have to enroll again.
//!
//! ```sh
//! cargo run -p rms-agent-core --example forget
//! ```

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match rms_agent_core::DeviceKey::load()? {
        Some(key) => {
            println!("removing device key {}", key.public_key_b64());
            rms_agent_core::DeviceKey::delete()?;
            println!("removed. this machine will need to enroll again.");
        }
        None => println!("no device key stored; nothing to do."),
    }
    Ok(())
}
