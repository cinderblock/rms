//! Command handling for the tray host.
//!
//! Wraps the built-in verbs and adds the ones that need something only this
//! process has. Today that is `update.check`, which needs the Tauri updater —
//! this is the server-push update trigger from the plan, the third of the three
//! independent ways an update can be started.

use std::sync::Arc;

use rms_agent_core::transport::{BuiltinHandler, CommandFuture, CommandHandler};
use tauri::AppHandle;

use crate::updater::{self, Trigger};

pub struct TrayCommandHandler {
    app: AppHandle,
    builtin: BuiltinHandler,
}

impl TrayCommandHandler {
    pub fn new(app: AppHandle, agent_version: String) -> Self {
        Self {
            app,
            builtin: BuiltinHandler { agent_version },
        }
    }

    /// The transport takes an `Arc<dyn CommandHandler>`; this is just the
    /// conversion, kept separate so `new` returns `Self` as clippy expects.
    pub fn shared(app: AppHandle, agent_version: String) -> Arc<dyn CommandHandler> {
        Arc::new(Self::new(app, agent_version))
    }
}

impl CommandHandler for TrayCommandHandler {
    fn handle(&self, verb: String, args: serde_json::Value) -> CommandFuture {
        if verb != "update.check" {
            return self.builtin.handle(verb, args);
        }

        let app = self.app.clone();
        Box::pin(async move {
            match updater::check(&app, Trigger::Server).await {
                Ok(updater::Outcome::UpToDate) => Ok(serde_json::json!({
                    "updated": false,
                    "version": app.package_info().version.to_string(),
                })),
                Ok(updater::Outcome::Installed { version }) => {
                    // Answer before restarting. The server asked for this, so it
                    // deserves to know it worked rather than just seeing the
                    // device drop off — which is indistinguishable from a crash.
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        app.restart();
                    });
                    Ok(serde_json::json!({ "updated": true, "version": version }))
                }
                Err(err) => Err(err),
            }
        })
    }
}
