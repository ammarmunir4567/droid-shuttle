//! ADB sync protocol (file listing, stat, push, pull) over the adb server.
//!
//! One connection per operation keeps the state machine trivial. `LIS2`/`STA2`
//! give 64-bit sizes (files over 4 GB); older devices fall back to v1.

use super::{connect, features, send, shell_quote, AdbError, Result};
use crate::transfer::ctl::Ctl;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter},
    net::TcpStream,
};

pub const S_IFMT: u32 = 0o170000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFLNK: u32 = 0o120000;
const DATA_MAX: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct RawEntry {
    pub name: String,
    pub mode: u32,
    pub size: u64,
    pub mtime: i64,
}

impl RawEntry {
    pub fn is_dir(&self) -> bool {
        self.mode & S_IFMT == S_IFDIR
    }
    pub fn is_symlink(&self) -> bool {
        self.mode & S_IFMT == S_IFLNK
    }
}

async fn open(serial: &str) -> Result<TcpStream> {
    let mut s = connect().await?;
    send(&mut s, &format!("host:transport:{serial}")).await?;
    send(&mut s, "sync:").await?;
    Ok(s)
}

async fn request(s: &mut TcpStream, id: &[u8; 4], payload: &[u8]) -> Result<()> {
    let mut buf = Vec::with_capacity(8 + payload.len());
    buf.extend_from_slice(id);
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    s.write_all(&buf).await?;
    Ok(())
}

async fn read_u32(s: &mut TcpStream) -> Result<u32> {
    let mut b = [0u8; 4];
    s.read_exact(&mut b).await?;
    Ok(u32::from_le_bytes(b))
}

async fn read_fail(s: &mut TcpStream) -> AdbError {
    let len = match read_u32(s).await {
        Ok(l) => l as usize,
        Err(e) => return e,
    };
    let mut msg = vec![0u8; len.min(4096)];
    if let Err(e) = s.read_exact(&mut msg).await {
        return e.into();
    }
    AdbError::Fail(String::from_utf8_lossy(&msg).into_owned())
}

fn le_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes(b[..4].try_into().unwrap())
}
fn le_u64(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}

pub async fn list(serial: &str, path: &str) -> Result<Vec<RawEntry>> {
    let v2 = features(serial).await?.contains("ls_v2");
    let mut s = open(serial).await?;
    request(&mut s, if v2 { b"LIS2" } else { b"LIST" }, path.as_bytes()).await?;
    let mut out = Vec::new();
    loop {
        let mut id = [0u8; 4];
        s.read_exact(&mut id).await?;
        let (mode, size, mtime, namelen) = match &id {
            b"DONE" => break,
            b"FAIL" => return Err(read_fail(&mut s).await),
            b"DENT" => {
                let mut b = [0u8; 16];
                s.read_exact(&mut b).await?;
                (le_u32(&b[0..]), le_u32(&b[4..]) as u64, le_u32(&b[8..]) as i64, le_u32(&b[12..]))
            }
            b"DNT2" => {
                let mut b = [0u8; 72];
                s.read_exact(&mut b).await?;
                // error(4) dev(8) ino(8) mode(4) nlink(4) uid(4) gid(4) size(8) atime(8) mtime(8) ctime(8) namelen(4)
                (le_u32(&b[20..]), le_u64(&b[36..]), le_u64(&b[52..]) as i64, le_u32(&b[68..]))
            }
            _ => return Err(AdbError::Protocol),
        };
        let mut name = vec![0u8; namelen as usize];
        s.read_exact(&mut name).await?;
        let name = String::from_utf8_lossy(&name).into_owned();
        if name != "." && name != ".." {
            out.push(RawEntry { name, mode, size, mtime });
        }
    }
    Ok(out)
}

/// `None` when the path does not exist. Follows symlinks.
pub async fn stat(serial: &str, path: &str) -> Result<Option<RawEntry>> {
    let v2 = features(serial).await?.contains("stat_v2");
    let mut s = open(serial).await?;
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    if v2 {
        request(&mut s, b"STA2", path.as_bytes()).await?;
        let mut id = [0u8; 4];
        s.read_exact(&mut id).await?;
        if &id != b"STA2" {
            return Err(AdbError::Protocol);
        }
        let mut b = [0u8; 68];
        s.read_exact(&mut b).await?;
        if le_u32(&b[0..]) != 0 {
            return Ok(None);
        }
        Ok(Some(RawEntry { name, mode: le_u32(&b[20..]), size: le_u64(&b[36..]), mtime: le_u64(&b[52..]) as i64 }))
    } else {
        request(&mut s, b"STAT", path.as_bytes()).await?;
        let mut id = [0u8; 4];
        s.read_exact(&mut id).await?;
        let mut b = [0u8; 12];
        s.read_exact(&mut b).await?;
        let (mode, size, mtime) = (le_u32(&b[0..]), le_u32(&b[4..]), le_u32(&b[8..]));
        if mode == 0 && size == 0 && mtime == 0 {
            return Ok(None);
        }
        Ok(Some(RawEntry { name, mode, size: size as u64, mtime: mtime as i64 }))
    }
}

/// Download `remote` to `local`. Returns the SHA-256 of the bytes received.
pub async fn pull(serial: &str, remote: &str, local: &Path, ctl: &Ctl, on_bytes: impl Fn(u64)) -> Result<String> {
    let mut s = open(serial).await?;
    request(&mut s, b"RECV", remote.as_bytes()).await?;
    let mut out = BufWriter::with_capacity(1 << 20, File::create(local).await?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; DATA_MAX];
    loop {
        let mut id = [0u8; 4];
        s.read_exact(&mut id).await?;
        match &id {
            b"DATA" => {
                let len = read_u32(&mut s).await? as usize;
                if len > DATA_MAX {
                    return Err(AdbError::Protocol);
                }
                s.read_exact(&mut buf[..len]).await?;
                out.write_all(&buf[..len]).await?;
                hasher.update(&buf[..len]);
                on_bytes(len as u64);
                ctl.gate().await?;
            }
            b"DONE" => break,
            b"FAIL" => return Err(read_fail(&mut s).await),
            _ => return Err(AdbError::Protocol),
        }
    }
    out.flush().await?;
    Ok(hex(&hasher.finalize()))
}

/// Read only the first `max` bytes of a remote file (e.g. an image's EXIF header) and hang up.
pub async fn pull_prefix(serial: &str, remote: &str, max: usize) -> Result<Vec<u8>> {
    let mut s = open(serial).await?;
    request(&mut s, b"RECV", remote.as_bytes()).await?;
    let mut out = Vec::with_capacity(max.min(1 << 20));
    let mut buf = vec![0u8; DATA_MAX];
    while out.len() < max {
        let mut id = [0u8; 4];
        s.read_exact(&mut id).await?;
        match &id {
            b"DATA" => {
                let len = read_u32(&mut s).await? as usize;
                if len > DATA_MAX {
                    return Err(AdbError::Protocol);
                }
                s.read_exact(&mut buf[..len]).await?;
                out.extend_from_slice(&buf[..len]);
            }
            b"DONE" => break,
            b"FAIL" => return Err(read_fail(&mut s).await),
            _ => return Err(AdbError::Protocol),
        }
    }
    out.truncate(max);
    Ok(out)
}

/// Upload `local` to `remote`. Returns the SHA-256 of the bytes sent.
pub async fn push(serial: &str, local: &Path, remote: &str, mode: u32, mtime: u32, ctl: &Ctl, on_bytes: impl Fn(u64)) -> Result<String> {
    let mut s = open(serial).await?;
    request(&mut s, b"SEND", format!("{remote},{mode}").as_bytes()).await?;
    let mut file = File::open(local).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 + DATA_MAX];
    buf[..4].copy_from_slice(b"DATA");
    loop {
        let n = file.read(&mut buf[8..]).await?;
        if n == 0 {
            break;
        }
        buf[4..8].copy_from_slice(&(n as u32).to_le_bytes());
        s.write_all(&buf[..8 + n]).await?;
        hasher.update(&buf[8..8 + n]);
        on_bytes(n as u64);
        ctl.gate().await?;
    }
    let mut done = [0u8; 8];
    done[..4].copy_from_slice(b"DONE");
    done[4..].copy_from_slice(&mtime.to_le_bytes());
    s.write_all(&done).await?;
    let mut id = [0u8; 4];
    s.read_exact(&mut id).await?;
    match &id {
        b"OKAY" => {
            let _ = read_u32(&mut s).await;
            Ok(hex(&hasher.finalize()))
        }
        b"FAIL" => Err(read_fail(&mut s).await),
        _ => Err(AdbError::Protocol),
    }
}

/// Feed the first `len` bytes of `file` (positioned at 0) into `hasher`, leaving the cursor at `len`.
async fn hash_prefix(file: &mut File, len: u64, hasher: &mut Sha256) -> Result<()> {
    let mut buf = vec![0u8; 1 << 20];
    let mut left = len;
    while left > 0 {
        let want = buf.len().min(left as usize);
        let n = file.read(&mut buf[..want]).await?;
        if n == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(())
}

/// Continue a download whose first `offset` bytes are already in `local`.
///
/// The sync protocol cannot start mid-file, so this reads `tail -c +N` over `exec:`. An exec channel cannot
/// tell a clean end from a cable drop, so the byte count is checked against `total` and a short stream is
/// reported as `UnexpectedEof` (the caller treats that as "phone went away" and retries).
/// Returns the SHA-256 of the whole file.
pub async fn pull_resume(serial: &str, remote: &str, local: &Path, offset: u64, total: u64, ctl: &Ctl, on_bytes: impl Fn(u64)) -> Result<String> {
    let mut file = tokio::fs::OpenOptions::new().read(true).write(true).open(local).await?;
    let mut hasher = Sha256::new();
    hash_prefix(&mut file, offset, &mut hasher).await?;
    file.set_len(offset).await?; // drop any torn tail
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    on_bytes(offset);
    let mut s = connect().await?;
    send(&mut s, &format!("host:transport:{serial}")).await?;
    send(&mut s, &format!("exec:tail -c +{} {}", offset + 1, shell_quote(remote))).await?;
    let mut out = BufWriter::with_capacity(1 << 20, file);
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = 0u64;
    loop {
        let n = s.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).await?;
        hasher.update(&buf[..n]);
        got += n as u64;
        on_bytes(n as u64);
        ctl.gate().await?;
    }
    out.flush().await?;
    if offset + got != total {
        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
    }
    Ok(hex(&hasher.finalize()))
}

/// Continue an upload: `remote` already holds the first `offset` bytes of `local`. Appends the rest through
/// `exec:cat >>` and checks the final size on the phone. Returns the SHA-256 of the whole file.
pub async fn push_resume(serial: &str, local: &Path, remote: &str, offset: u64, total: u64, ctl: &Ctl, on_bytes: impl Fn(u64)) -> Result<String> {
    let mut file = File::open(local).await?;
    let mut hasher = Sha256::new();
    hash_prefix(&mut file, offset, &mut hasher).await?;
    on_bytes(offset);
    let mut s = connect().await?;
    send(&mut s, &format!("host:transport:{serial}")).await?;
    send(&mut s, &format!("exec:cat >> {}", shell_quote(remote))).await?;
    let mut buf = vec![0u8; DATA_MAX];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        s.write_all(&buf[..n]).await?;
        hasher.update(&buf[..n]);
        on_bytes(n as u64);
        ctl.gate().await?;
    }
    s.shutdown().await?; // EOF on cat's stdin
    let mut rest = Vec::new();
    s.read_to_end(&mut rest).await?; // returns when cat has exited
    match stat(serial, remote).await? {
        Some(e) if e.size == total => Ok(hex(&hasher.finalize())),
        _ => Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into()),
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
