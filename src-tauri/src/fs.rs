//! Listing and basic file operations for the phone (via ADB) and the Mac.

use crate::adb::{shell_quote, shell_rc, sync, AdbError};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix seconds.
    pub mtime: i64,
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

pub fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

pub fn parent(path: &str) -> String {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => t[..i].to_string(),
    }
}

pub async fn list_device(serial: &str, dir: &str) -> Result<Vec<FileEntry>, AdbError> {
    let raw = sync::list(serial, dir).await?;
    let mut out = Vec::with_capacity(raw.len());
    for e in raw {
        let path = join(dir, &e.name);
        let (mut is_dir, mut size, mut mtime) = (e.is_dir(), e.size, e.mtime);
        let is_symlink = e.is_symlink();
        if is_symlink {
            // Resolve so linked folders (e.g. /storage/self) open like folders.
            match sync::stat(serial, &path).await {
                Ok(Some(t)) => (is_dir, size, mtime) = (t.is_dir(), t.size, t.mtime),
                _ => continue, // broken link
            }
        }
        out.push(FileEntry { name: e.name, path, is_dir, is_symlink, size, mtime });
    }
    Ok(out)
}

pub async fn list_local(dir: &str) -> std::io::Result<Vec<FileEntry>> {
    let mut rd = tokio::fs::read_dir(dir).await?;
    let mut out = Vec::new();
    while let Some(ent) = rd.next_entry().await? {
        let name = ent.file_name().to_string_lossy().into_owned();
        let link = ent.file_type().await.map(|t| t.is_symlink()).unwrap_or(false);
        let Ok(md) = tokio::fs::metadata(ent.path()).await else { continue };
        let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
        out.push(FileEntry { path: join(dir, &name), name, is_dir: md.is_dir(), is_symlink: link, size: md.len(), mtime });
    }
    Ok(out)
}

fn rc_ok((out, rc): (String, i32)) -> Result<(), AdbError> {
    if rc == 0 { Ok(()) } else { Err(AdbError::Fail(out.trim().to_string())) }
}

pub async fn device_mkdir(serial: &str, path: &str) -> Result<(), AdbError> {
    rc_ok(shell_rc(serial, &format!("mkdir -p {}", shell_quote(path))).await?)
}

pub async fn device_rename(serial: &str, from: &str, to: &str) -> Result<(), AdbError> {
    rc_ok(shell_rc(serial, &format!("mv {} {}", shell_quote(from), shell_quote(to))).await?)
}

pub async fn device_delete(serial: &str, paths: &[String]) -> Result<(), AdbError> {
    for chunk in paths.chunks(50) {
        let args: Vec<String> = chunk.iter().map(|p| shell_quote(p)).collect();
        rc_ok(shell_rc(serial, &format!("rm -rf {}", args.join(" "))).await?)?;
    }
    Ok(())
}

/// Safe default folders worth showing in the sidebar (only those that exist).
pub async fn device_places(serial: &str) -> Result<Vec<FileEntry>, AdbError> {
    let mut out = Vec::new();
    for name in ["DCIM", "Download", "Pictures", "Movies", "Music", "Documents", "Recordings"] {
        let p = join("/sdcard", name);
        if let Ok(Some(e)) = sync::stat(serial, &p).await {
            if e.is_dir() {
                out.push(FileEntry { name: name.into(), path: p, is_dir: true, is_symlink: false, size: 0, mtime: e.mtime });
            }
        }
    }
    Ok(out)
}

/// Removable storage volumes under /storage (e.g. an SD card named `1A2B-3C4D`).
pub async fn device_volumes(serial: &str) -> Result<Vec<FileEntry>, AdbError> {
    let entries = sync::list(serial, "/storage").await?;
    Ok(entries
        .into_iter()
        .filter(|e| e.name != "emulated" && e.name != "self" && !e.name.starts_with('.'))
        .filter(|e| e.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .map(|e| FileEntry { path: join("/storage", &e.name), name: e.name, is_dir: true, is_symlink: false, size: 0, mtime: e.mtime })
        .collect())
}

pub fn local_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}
