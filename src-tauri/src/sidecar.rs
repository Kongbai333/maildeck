use std::error::Error;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::secrets;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const CORS_ORIGINS: &str = "http://tauri.localhost,https://tauri.localhost,http://localhost:5173,http://127.0.0.1:5173";

pub struct SidecarProcess {
    child: Child,
}

impl SidecarProcess {
    pub fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> Result<u16, Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn resolve_resources(app: &AppHandle) -> Result<PathBuf, Box<dyn Error>> {
    let candidates = [
        app.path().resource_dir().ok(),
        std::env::current_dir().ok().map(|p| p.join("resources")),
        std::env::current_dir()
            .ok()
            .map(|p| p.join("src-tauri").join("resources")),
    ];
    for dir in candidates.into_iter().flatten() {
        if dir.join("maildeck-server.mjs").is_file() {
            return Ok(dir);
        }
    }
    Err("sidecar bundle missing: run `npm run prepare:tauri` first".into())
}

fn node_program(dir: &Path) -> PathBuf {
    let bundled = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
    }
}

fn wait_for_health(port: u16) -> Result<(), Box<dyn Error>> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        let probe = TcpStream::connect_timeout(&addr, Duration::from_millis(300)).and_then(|mut stream| {
            stream.set_read_timeout(Some(Duration::from_millis(500)))?;
            stream.write_all(
                b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )?;
            let mut buf = [0u8; 32];
            let read = stream.read(&mut buf)?;
            Ok::<_, std::io::Error>(String::from_utf8_lossy(&buf[..read]).contains(" 200 "))
        });
        if matches!(probe, Ok(true)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(format!("sidecar /api/health did not become ready within {:?}", HEALTH_TIMEOUT).into())
}

/// 启动 sidecar 并等待健康检查通过；返回 (port, api_token, child)。
pub fn start(
    app: &AppHandle,
    data_dir: &Path,
    master_key: &str,
) -> Result<(u16, String, SidecarProcess), Box<dyn Error>> {
    let resources = resolve_resources(app)?;
    let server_data = data_dir.join("server-data");
    std::fs::create_dir_all(&server_data)?;

    let port = free_port()?;
    let token = secrets::random_token();

    let mut command = Command::new(node_program(&resources));
    command
        .arg(resources.join("maildeck-server.mjs"))
        .current_dir(&resources)
        .env("NODE_ENV", "production")
        .env("MAILDECK_HOST", "127.0.0.1")
        .env("MAILDECK_PORT", port.to_string())
        .env("MAILDECK_API_TOKEN", &token)
        .env("MAILDECK_DATA_DIR", &server_data)
        .env("MAILDECK_MASTER_KEY", master_key)
        .env("MAILDECK_CORS_ORIGINS", CORS_ORIGINS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn()?;
    if let Err(error) = wait_for_health(port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    Ok((port, token, SidecarProcess { child }))
}
