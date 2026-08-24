//! System tray icon and menu.
//!
//! The menu is intentionally tiny. It exists to answer "is this thing running?"
//! and to give a manual escape hatch for updates — not to be an app.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::updater::{self, Trigger};

const ID_STATUS: &str = "status";
const ID_CHECK: &str = "check";
const ID_SHOW: &str = "show";
const ID_QUIT: &str = "quit";

// Deliberately not generic over `R: Runtime`. `TrayIconBuilder`'s runtime
// parameter defaults to `Wry`, so a generic `AppHandle<R>` fails to unify with
// it at `.build()`. This app has exactly one runtime; being generic buys nothing.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let version = app.package_info().version.to_string();

    // Disabled item used purely as a label — the tooltip is not enough on Linux,
    // where hover text is inconsistent across tray implementations.
    let status = MenuItem::with_id(app, ID_STATUS, format!("v{version}"), false, None::<&str>)?;
    let check = MenuItem::with_id(app, ID_CHECK, "Check for updates now", true, None::<&str>)?;
    let show = MenuItem::with_id(app, ID_SHOW, "Show status window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &check,
            &show,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("bundled window icon"),
        )
        // NOT a template icon: template rendering flattens to a monochrome mask,
        // which would turn the app icon into a solid blob in the macOS menu bar.
        // TODO(macos): ship a dedicated monochrome glyph and set this to true.
        .icon_as_template(false)
        .tooltip(format!("Remote Mgmt Daemon v{version}"))
        .menu(&menu)
        // Left click should not open the menu on Windows/Linux; it opens the
        // status window instead. macOS keeps the menu on left click by
        // convention, which `show_menu_on_left_click(false)` respects.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ID_CHECK => {
                let app = app.clone();
                tauri::async_runtime::spawn(updater::check_and_report(app, Trigger::Menu));
            }
            ID_SHOW => show_status_window(app),
            ID_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event
                && button == tauri::tray::MouseButton::Left
            {
                show_status_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_status_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("status") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
