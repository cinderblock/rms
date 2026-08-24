//! Update checking.
//!
//! There are deliberately three ways to trigger a check — an ambient timer, the
//! tray menu, and (from phase 3) a server push. They all land here. The
//! redundancy is the point: if any one trigger is broken by a bad release, the
//! others are still a way back in.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

/// How often to check when nobody asked us to.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Wait this long after launch before the first check, so a boot storm doesn't
/// have every machine hitting GitHub at once and so the tray is up first.
const STARTUP_DELAY: Duration = Duration::from_secs(30);

/// Why a check happened. Only used to decide how loudly to report the result:
/// if a human clicked the menu item they deserve an answer even when the answer
/// is "nothing to do".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Timer,
    Menu,
    /// The control server asked. Exists so a broken timer or a broken tray still
    /// leaves a way to push a fix.
    Server,
}

#[derive(Debug)]
pub enum Outcome {
    UpToDate,
    /// Installed; the caller is about to restart into `version`.
    Installed {
        version: String,
    },
}

/// Serializes checks so a menu click during a timer check can't start a second
/// download on top of the first.
#[derive(Default)]
pub struct UpdateGate(Arc<Mutex<()>>);

impl UpdateGate {
    pub fn new() -> Self {
        Self::default()
    }
}

pub async fn check(app: &AppHandle, trigger: Trigger) -> Result<Outcome, String> {
    // Clone the Arc out in one statement: holding the `State` guard across an
    // await would make this future non-Send and it would not compile as a command.
    let gate = app.state::<UpdateGate>().0.clone();
    let _held = match gate.try_lock_owned() {
        Ok(guard) => guard,
        Err(_) => return Err("An update check is already running.".into()),
    };

    let updater = app.updater().map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        tracing::info!(?trigger, "already up to date");
        return Ok(Outcome::UpToDate);
    };

    let version = update.version.clone();
    tracing::info!(?trigger, %version, "update available; downloading");

    let mut downloaded = 0usize;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk;
                if let Some(total) = total {
                    tracing::debug!(downloaded, total, "download progress");
                }
            },
            || tracing::info!("download complete; installing"),
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(Outcome::Installed { version })
}

/// Run a check and tell the user about it, then restart if we installed
/// something. Never panics and never propagates — an update failure must not
/// take down the agent, because the agent is how the *next* update arrives.
pub async fn check_and_report(app: AppHandle, trigger: Trigger) {
    match check(&app, trigger).await {
        Ok(Outcome::UpToDate) => {
            if trigger == Trigger::Menu {
                notify(
                    &app,
                    "Up to date",
                    &format!("Running v{}", app.package_info().version),
                );
            }
        }
        Ok(Outcome::Installed { version }) => {
            notify(
                &app,
                "Update installed",
                &format!("Restarting into v{version}."),
            );
            // Give the notification a moment to actually render before the
            // process goes away underneath it.
            tokio::time::sleep(Duration::from_secs(2)).await;
            app.restart();
        }
        Err(err) => {
            tracing::warn!(%err, ?trigger, "update check failed");
            if trigger == Trigger::Menu {
                notify(&app, "Update check failed", &err);
            }
        }
    }
}

/// Background timer. Lives for the life of the process.
pub fn spawn_timer(app: AppHandle, interval: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            check_and_report(app.clone(), Trigger::Timer).await;
            tokio::time::sleep(interval).await;
        }
    });
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!(%err, "could not show notification");
    }
}
