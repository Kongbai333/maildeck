mod commands;
mod secrets;
mod sidecar;

use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub server_url: String,
    pub api_token: String,
    pub version: String,
}

pub struct DesktopState {
    pub config: DesktopConfig,
    pub sidecar: Arc<Mutex<Option<sidecar::SidecarProcess>>>,
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::desktop_config,
            commands::open_external,
            commands::app_version
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let master_key = secrets::load_or_create_master_key(&data_dir)?;
            let (port, token, child) = sidecar::start(&handle, &data_dir, &master_key)?;

            app.manage(DesktopState {
                config: DesktopConfig {
                    server_url: format!("http://127.0.0.1:{port}"),
                    api_token: token,
                    version: env!("CARGO_PKG_VERSION").to_string(),
                },
                sidecar: Arc::new(Mutex::new(Some(child))),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build MailDeck Tauri application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            let sidecar = Arc::clone(&handle.state::<DesktopState>().sidecar);
            let child = {
                let mut guard = match sidecar.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.take()
            };
            if let Some(child) = child {
                child.stop();
            }
        }
    });
}
