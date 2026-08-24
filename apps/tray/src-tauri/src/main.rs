// Release builds have no console window — this is a background agent, not a CLI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod tray;
mod updater;

use serde::Serialize;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use updater::{Trigger, UpdateGate};

// camelCase to match what the frontend reads. Tauri handles the reverse
// direction for command *arguments* automatically, but not for return values.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    version: String,
    autostart: bool,
    enrolled: bool,
    server_url: Option<String>,
    server_name: Option<String>,
    device_id: Option<String>,
}

#[tauri::command]
fn get_status(app: AppHandle) -> Status {
    // A config that fails to parse is reported as "not enrolled" rather than
    // propagated: the status window is how the user would fix it, so it must
    // render regardless.
    let config = rms_agent_core::AgentConfig::load().ok().flatten();

    Status {
        version: app.package_info().version.to_string(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        enrolled: rms_agent_core::is_enrolled(),
        server_url: config.as_ref().map(|c| c.server_url.clone()),
        server_name: config.as_ref().map(|c| c.server_name.clone()),
        device_id: config.as_ref().map(|c| c.device_id.clone()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Enrolled {
    device_id: String,
    display_name: String,
    server_name: String,
    /// Surfaced so the user can go merge the records rather than quietly ending
    /// up with two entries for one machine.
    probable_reenrollment_of: Option<String>,
}

#[tauri::command]
async fn enroll(
    app: AppHandle,
    server_url: String,
    passphrase: String,
) -> Result<Enrolled, String> {
    let version = app.package_info().version.to_string();
    let client = reqwest::Client::new();

    let (response, _key) =
        rms_agent_core::enroll(&client, server_url.trim(), passphrase.trim(), &version)
            .await
            .map_err(|err| err.to_string())?;

    // Connect straight away rather than making the user restart the app to
    // finish joining a fleet.
    spawn_control_connection(&app);

    Ok(Enrolled {
        device_id: response.device_id,
        display_name: response.display_name,
        server_name: response.server_name,
        probable_reenrollment_of: response.probable_reenrollment_of,
    })
}

/// Forget this machine's enrollment locally. The server-side device record
/// survives and has to be removed there — saying so matters, because otherwise
/// re-enrolling silently leaves an orphan behind.
#[tauri::command]
fn unenroll() -> Result<(), String> {
    rms_agent_core::DeviceKey::delete().map_err(|err| err.to_string())?;
    rms_agent_core::AgentConfig::clear().map_err(|err| err.to_string())?;
    Ok(())
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

/// Start the control connection if this machine has enrolled.
///
/// Nothing is retried here when the device isn't enrolled: the connection can
/// only start once the user has been through the enrollment form, and the
/// `enroll` command starts it directly rather than making them restart the app.
fn spawn_control_connection(app: &AppHandle) {
    let (Ok(Some(config)), Ok(Some(key))) = (
        rms_agent_core::AgentConfig::load(),
        rms_agent_core::DeviceKey::load(),
    ) else {
        tracing::info!("not enrolled; not connecting to a control server");
        return;
    };

    let version = app.package_info().version.to_string();
    let handler = commands::TrayCommandHandler::shared(app.clone(), version.clone());

    tracing::info!(server = %config.server_url, "starting control connection");
    tauri::async_runtime::spawn(rms_agent_core::run_forever(config, key, handler, version));
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("RMS_LOG")
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
            set_autostart,
            enroll,
            unenroll
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

            // An agent that hasn't enrolled can't do anything, and a tray icon
            // gives no hint that it's waiting on you. Show the window on first
            // run; afterwards it stays hidden until asked for.
            if !rms_agent_core::is_enrolled()
                && let Some(window) = handle.get_webview_window("status")
            {
                let _ = window.show();
                let _ = window.set_focus();
            }

            spawn_control_connection(&handle);
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
