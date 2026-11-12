use std::error::Error;
use std::fs;
use std::path::Path;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// sidecar 用它加密 refresh token，必须在多次启动之间保持稳定。
/// 首次启动生成 32 字节 base64 写入 app_data_dir/master.key。
pub fn load_or_create_master_key(data_dir: &Path) -> Result<String, Box<dyn Error>> {
    let path = data_dir.join("master.key");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty()
            && matches!(STANDARD.decode(trimmed), Ok(ref bytes) if bytes.len() == 32)
        {
            return Ok(trimmed.to_string());
        }
    }

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let key = STANDARD.encode(bytes);
    fs::write(&path, &key)?;
    Ok(key)
}
