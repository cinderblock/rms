// Release builds have no console window — this is a background agent, not a CLI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray;
mod updater;

use serde::Serialize;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use updater::{Trigger, UpdateGate};

#[derive(Serialize)]
struct Status {
    version: String,
    autostart: bool,
    /// Set in phase 3, when there is actually a server to be connected to.
    server: Option<String>,
}

#[tauri::command]
fn get_status(app: AppHandle) -> Status {
    Status {
        version: app.package_info().version.to_string(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        server: None,
    }
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<String, String> {
    match updater::check(&app, Trigger::Menu).await? {
        updater::Outcome::UpToDate => Ok("Up to date.".into()),
        updater::Outcome::Installed { version } => {
            let msg = format!("Installed v{version}. Restarting…");
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                app.restart();
            });
            Ok(msg)
        }
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let auto = app.autolaunch();
    if enabled {
        auto.enable().map_err(|e| e.to_string())
    } else {
        auto.disable().map_err(|e| e.to_string())
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("RMD_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Someone launched us again — most likely by double-clicking the
            // shortcut while we were already in the tray. Surface the window
            // rather than silently doing nothing.
            if let Some(window) = app.get_webview_window("status") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(UpdateGate::new())
        .invoke_handler(tauri::generate_handler![
            get_status,
            check_for_updates,
            set_autostart
        ])
        .on_window_event(|window, event| {
            // Closing the status window must not exit the agent; it is a
            // background process that happens to have a window.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            tray::build(&handle)?;

            // Managed devices should come back after a reboot without anyone
            // logging in to press anything.
            if let Err(err) = handle.autolaunch().enable() {
                tracing::warn!(%err, "could not enable autostart");
            }

            updater::spawn_timer(handle, updater::DEFAULT_INTERVAL);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build application")
        .run(|_app, event| {
            // Without this, macOS quits the process when the last window
            // closes — which for a tray agent means "immediately".
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                && code.is_none()
            {
                api.prevent_exit();
            }
        });
}
