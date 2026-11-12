use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;

use crate::{DesktopConfig, DesktopState};

#[tauri::command]
pub fn desktop_config(state: State<'_, DesktopState>) -> Result<DesktopConfig, String> {
    Ok(state.config.clone())
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 与 Electron 版 `app.openExternal` 对齐：只允许 http/https/mailto，避免 WebView 里
/// `window.open` 被拦截，同时不让渲染层直接拿到 shell 执行能力。
#[tauri::command]
#[allow(deprecated)] // shell::open 后续迁到 tauri-plugin-opener，当前保持与 Electron 版行为一致
pub fn open_external(app: AppHandle, url: String) -> Result<bool, String> {
    let allowed = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("mailto:");
    if !allowed {
        return Err("URL scheme rejected".to_string());
    }
    app.shell()
        .open(url, None)
        .map_err(|error| error.to_string())?;
    Ok(true)
}
