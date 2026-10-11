//! Minimal async client for the ADB server protocol (127.0.0.1:5037).
//!
//! Talking to the server directly avoids spawning an `adb` process per call and
//! gives us streaming `track-devices` for instant hot-plug detection.

pub mod sync;

#[cfg(test)]
pub(crate) mod fake;

use serde::Serialize;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const ADB_ADDR: &str = "127.0.0.1:5037";

/// Unit tests point the client at an in-process fake server instead of the real one.
#[cfg(test)]
pub(crate) static TEST_ADDR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn adb_addr() -> String {
    #[cfg(test)]
    if let Some(a) = TEST_ADDR.lock().unwrap().clone() {
        return a;
    }
    ADB_ADDR.to_string()
}

#[derive(Debug, Error)]
pub enum AdbError {
    #[error("adb server unreachable: {0}")]
    Io(#[from] std::io::Error),
    #[error("adb refused: {0}")]
    Fail(String),
    #[error("malformed adb reply")]
    Protocol,
    #[error("adb binary not found; install platform-tools")]
    NotInstalled,
    #[error("cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, AdbError>;

/// State reported by `adb devices -l`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AdbState {
    /// Fully usable (USB debugging on, host authorized).
    Ready,
    /// USB debugging on but the RSA prompt on the phone has not been accepted.
    Unauthorized,
    Offline,
    Recovery,
    Sideload,
    /// Linux-only udev state; kept so unknown values don't break parsing.
    Other,
}

impl AdbState {
    fn parse(s: &str) -> Self {
        match s {
            "device" => Self::Ready,
            "unauthorized" => Self::Unauthorized,
            "offline" => Self::Offline,
            "recovery" => Self::Recovery,
            "sideload" => Self::Sideload,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    pub state: AdbState,
    pub model: Option<String>,
    pub product: Option<String>,
    pub transport_id: Option<String>,
    /// True for `ip:port` / mDNS serials (wireless), false for USB.
    pub wireless: bool,
}

/// Parse the body of `host:devices-l` / `host:track-devices-l`.
pub fn parse_devices(body: &str) -> Vec<AdbDevice> {
    body.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = AdbState::parse(parts.next()?);
            let (mut model, mut product, mut transport_id) = (None, None, None);
            for kv in parts {
                if let Some((k, v)) = kv.split_once(':') {
                    match k {
                        "model" => model = Some(v.replace('_', " ")),
                        "product" => product = Some(v.to_string()),
                        "transport_id" => transport_id = Some(v.to_string()),
                        _ => {}
                    }
                }
            }
            let wireless = serial.contains(':') || serial.contains("_adb-tls-connect");
            Some(AdbDevice { serial, state, model, product, transport_id, wireless })
        })
        .collect()
}

pub(crate) async fn send(stream: &mut TcpStream, cmd: &str) -> Result<()> {
    stream.write_all(format!("{:04x}{}", cmd.len(), cmd).as_bytes()).await?;
    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => Err(AdbError::Fail(read_len_prefixed(stream).await?)),
        _ => Err(AdbError::Protocol),
    }
}

pub(crate) async fn read_len_prefixed(stream: &mut TcpStream) -> Result<String> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await?;
    let len = usize::from_str_radix(std::str::from_utf8(&len).map_err(|_| AdbError::Protocol)?, 16)
        .map_err(|_| AdbError::Protocol)?;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Find an `adb` executable: the copy bundled next to the app first, then Homebrew.
pub fn adb_binary() -> Result<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf()));
    find_adb(exe_dir.as_deref(), &["/opt/homebrew/bin/adb", "/usr/local/bin/adb"])
}

fn find_adb(exe_dir: Option<&std::path::Path>, fallbacks: &[&str]) -> Result<std::path::PathBuf> {
    if let Some(bundled) = exe_dir.map(|d| d.join("adb")).filter(|p| p.is_file()) {
        return Ok(bundled);
    }
    fallbacks
        .iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.is_file())
        .ok_or(AdbError::NotInstalled)
}

/// Connect to the ADB server, starting it if it is not running.
pub(crate) async fn connect() -> Result<TcpStream> {
    if let Ok(s) = TcpStream::connect(adb_addr()).await {
        return Ok(s);
    }
    let bin = adb_binary()?;
    tokio::process::Command::new(bin).arg("start-server").output().await?;
    for _ in 0..20 {
        if let Ok(s) = TcpStream::connect(adb_addr()).await {
            return Ok(s);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Err(AdbError::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "adb server did not start")))
}

pub async fn list_devices() -> Result<Vec<AdbDevice>> {
    let mut s = connect().await?;
    send(&mut s, "host:devices-l").await?;
    Ok(parse_devices(&read_len_prefixed(&mut s).await?))
}

/// Run a shell command on a device and return stdout (stderr merged).
pub async fn shell(serial: &str, cmd: &str) -> Result<String> {
    let mut s = connect().await?;
    send(&mut s, &format!("host:transport:{serial}")).await?;
    send(&mut s, &format!("shell:{cmd}")).await?;
    let mut out = Vec::new();
    s.read_to_end(&mut out).await?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Single-quote a string for the Android shell.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run a shell command and also return its exit code (the legacy shell service has none).
pub async fn shell_rc(serial: &str, cmd: &str) -> Result<(String, i32)> {
    let out = shell(serial, &format!("{cmd}; echo \"::rc=$?\"")).await?;
    match out.rfind("::rc=") {
        Some(i) => {
            let rc = out[i + 5..].trim().parse().unwrap_or(-1);
            Ok((out[..i].to_string(), rc))
        }
        None => Ok((out, -1)),
    }
}

/// Device feature flags (`ls_v2`, `stat_v2`, ...), cached per serial.
pub async fn features(serial: &str) -> Result<std::collections::HashSet<String>> {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, std::collections::HashSet<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(f) = cache.lock().unwrap().get(serial) {
        return Ok(f.clone());
    }
    let mut s = connect().await?;
    send(&mut s, &format!("host-serial:{serial}:features")).await?;
    let set: std::collections::HashSet<String> =
        read_len_prefixed(&mut s).await?.trim().split(',').map(str::to_string).collect();
    cache.lock().unwrap().insert(serial.to_string(), set.clone());
    Ok(set)
}

/// Run a command via the `exec:` service: no pty, so binary output (thumbnails) arrives untouched.
pub async fn exec(serial: &str, cmd: &str) -> Result<Vec<u8>> {
    let mut s = connect().await?;
    send(&mut s, &format!("host:transport:{serial}")).await?;
    send(&mut s, &format!("exec:{cmd}")).await?;
    let mut out = Vec::new();
    s.read_to_end(&mut out).await?;
    Ok(out)
}

/// Stream the device list; invokes `on_change` with the full list on every change.
/// Returns only on error so callers can reconnect with backoff.
pub async fn track_devices(mut on_change: impl FnMut(Vec<AdbDevice>)) -> Result<()> {
    let mut s = connect().await?;
    send(&mut s, "host:track-devices-l").await?;
    loop {
        let body = read_len_prefixed(&mut s).await?;
        on_change(parse_devices(&body));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn bundled_adb_wins_over_system_copies() {
        let dir = std::env::temp_dir().join(format!("ds-adb-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fallback = dir.join("system-adb");
        std::fs::write(&fallback, b"").unwrap();
        let fb = fallback.to_str().unwrap();
        // Nothing bundled: falls back to the system copy.
        assert_eq!(find_adb(Some(&dir), &[fb]).unwrap(), fallback);
        // Bundled copy next to the executable takes priority.
        std::fs::write(dir.join("adb"), b"").unwrap();
        assert_eq!(find_adb(Some(&dir), &[fb]).unwrap(), dir.join("adb"));
        // Neither available: a clear error.
        assert!(matches!(find_adb(None, &["/nonexistent/adb"]), Err(AdbError::NotInstalled)));
        std::fs::remove_dir_all(&dir).ok();
    }

    use super::*;

    #[test]
    fn parses_usb_and_wireless_devices() {
        let body = "R5CT123ABCD            device usb:336592896X product:e1qxxx model:SM_S911B device:e1q transport_id:3\n\
                    192.168.1.9:5555       unauthorized transport_id:4\n";
        let d = parse_devices(body);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].state, AdbState::Ready);
        assert_eq!(d[0].model.as_deref(), Some("SM S911B"));
        assert!(!d[0].wireless);
        assert_eq!(d[1].state, AdbState::Unauthorized);
        assert!(d[1].wireless);
    }

    #[test]
    fn empty_list_is_empty() {
        assert!(parse_devices("").is_empty());
    }
}
