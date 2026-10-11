//! In-process fake ADB server for unit tests: just enough of the host protocol, sync v1 and a few shell
//! commands to exercise the transfer engine, including a "cable pulled" simulation (connection dropped
//! mid-transfer, phone offline for a while).

use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

pub const SERIAL: &str = "FAKE0001";

/// The fake server's address is process-global, so tests that use it run one at a time.
pub static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
pub struct Fake {
    pub files: Mutex<HashMap<String, Vec<u8>>>,
    pub online: AtomicBool,
    /// Cable-pull: drop the next pull after this many bytes were streamed.
    pub drop_pull_after: Mutex<Option<usize>>,
    /// Cable-pull: drop the next push after this many bytes were received.
    pub drop_push_after: Mutex<Option<usize>>,
    /// How long the phone stays offline after a drop.
    pub offline_ms: AtomicUsize,
    pub recv: AtomicUsize,
    pub tail: AtomicUsize,
    pub send: AtomicUsize,
    pub cat: AtomicUsize,
    /// Scripted scrcpy server: what to play on the 1st, 2nd … `localabstract:scrcpy_*` connection.
    pub scrcpy_script: Mutex<Vec<ScrcpySocket>>,
    pub scrcpy_sockets: AtomicUsize,
    /// Command lines the "phone" was asked to run for scrcpy.
    pub scrcpy_cmds: Mutex<Vec<String>>,
    /// What `list_cameras=true` prints.
    pub camera_list: Mutex<String>,
}

/// One scrcpy socket: timed chunks, then either stay open (a live phone) or hang up (cable pulled).
#[derive(Clone, Default)]
pub struct ScrcpySocket {
    pub chunks: Vec<(u64, Vec<u8>)>,
    pub hold_open: bool,
}

impl Fake {
    pub fn put(&self, path: &str, data: Vec<u8>) {
        self.files.lock().unwrap().insert(path.to_string(), data);
    }
    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(path).cloned()
    }
    fn pull_drop(&self) -> Option<usize> {
        self.drop_pull_after.lock().unwrap().take()
    }
    fn go_offline(self: &Arc<Self>) {
        self.online.store(false, Ordering::SeqCst);
        let (me, ms) = (self.clone(), self.offline_ms.load(Ordering::SeqCst) as u64);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            me.online.store(true, Ordering::SeqCst);
        });
    }
}

/// Start the server on a free port and point the client at it. Hold the returned guard's lock for the test.
pub async fn start() -> Arc<Fake> {
    let fake = Arc::new(Fake::default());
    fake.online.store(true, Ordering::SeqCst);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    *super::TEST_ADDR.lock().unwrap() = Some(listener.local_addr().unwrap().to_string());
    let f = fake.clone();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { return };
            let f = f.clone();
            tokio::spawn(async move {
                let _ = serve(f, sock).await;
            });
        }
    });
    fake
}

async fn okay(s: &mut TcpStream) -> std::io::Result<()> {
    s.write_all(b"OKAY").await
}
async fn fail(s: &mut TcpStream, msg: &str) -> std::io::Result<()> {
    s.write_all(format!("FAIL{:04x}{msg}", msg.len()).as_bytes()).await
}
async fn body(s: &mut TcpStream, text: &str) -> std::io::Result<()> {
    s.write_all(format!("OKAY{:04x}{text}", text.len()).as_bytes()).await
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('\'').to_string()
}

async fn serve(f: Arc<Fake>, mut s: TcpStream) -> std::io::Result<()> {
    loop {
        let mut len = [0u8; 4];
        s.read_exact(&mut len).await?;
        let n = usize::from_str_radix(std::str::from_utf8(&len).unwrap(), 16).unwrap();
        let mut cmd = vec![0u8; n];
        s.read_exact(&mut cmd).await?;
        let cmd = String::from_utf8_lossy(&cmd).into_owned();
        if cmd == "host:devices-l" {
            let line = if f.online.load(Ordering::SeqCst) { format!("{SERIAL}\tdevice model:Fake product:fake transport_id:1\n") } else { String::new() };
            body(&mut s, &line).await?;
        } else if cmd.starts_with("host-serial:") {
            body(&mut s, "").await?; // no v2 features: sync v1
        } else if cmd.starts_with("host:transport:") {
            if f.online.load(Ordering::SeqCst) {
                okay(&mut s).await?;
            } else {
                fail(&mut s, &format!("device '{SERIAL}' not found")).await?;
            }
        } else if cmd.starts_with("localabstract:scrcpy_") {
            let idx = f.scrcpy_sockets.fetch_add(1, Ordering::SeqCst);
            let script = f.scrcpy_script.lock().unwrap().get(idx).cloned();
            match script {
                None => fail(&mut s, "closed").await?,
                Some(sock) => {
                    okay(&mut s).await?;
                    return scrcpy_socket(&mut s, sock).await;
                }
            }
        } else if cmd == "sync:" {
            okay(&mut s).await?;
            return sync_loop(&f, &mut s).await;
        } else if let Some(rest) = cmd.strip_prefix("exec:") {
            okay(&mut s).await?;
            return exec(&f, &mut s, rest).await;
        } else if let Some(rest) = cmd.strip_prefix("shell:") {
            okay(&mut s).await?;
            return shell(&f, &mut s, rest).await;
        } else {
            fail(&mut s, "unsupported").await?;
        }
    }
}

async fn sync_loop(f: &Arc<Fake>, s: &mut TcpStream) -> std::io::Result<()> {
    loop {
        let mut head = [0u8; 8];
        s.read_exact(&mut head).await?;
        let len = u32::from_le_bytes(head[4..].try_into().unwrap()) as usize;
        let mut payload = vec![0u8; len];
        s.read_exact(&mut payload).await?;
        let payload = String::from_utf8_lossy(&payload).into_owned();
        match &head[..4] {
            b"STAT" => {
                let (mode, size) = match f.get(&payload) {
                    Some(d) => (0o100644u32, d.len() as u32),
                    None => (0, 0),
                };
                let mut out = b"STAT".to_vec();
                for v in [mode, size, 1_700_000_000u32] {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                s.write_all(&out).await?;
            }
            b"LIST" => {
                let prefix = format!("{}/", payload.trim_end_matches('/'));
                let entries: Vec<(String, usize)> = f
                    .files
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|(p, d)| p.strip_prefix(&prefix).filter(|r| !r.contains('/')).map(|r| (r.to_string(), d.len())))
                    .collect();
                for (name, size) in entries {
                    let mut out = b"DENT".to_vec();
                    for v in [0o100644u32, size as u32, 1_700_000_000, name.len() as u32] {
                        out.extend_from_slice(&v.to_le_bytes());
                    }
                    out.extend_from_slice(name.as_bytes());
                    s.write_all(&out).await?;
                }
                s.write_all(b"DONE\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0").await?;
            }
            b"RECV" => {
                f.recv.fetch_add(1, Ordering::SeqCst);
                let Some(data) = f.get(&payload) else {
                    s.write_all(b"FAIL\x1c\0\0\0remote object does not exist").await?;
                    continue;
                };
                let cut = f.pull_drop();
                let mut sent = 0usize;
                for chunk in data.chunks(64 * 1024) {
                    if cut.is_some_and(|c| sent >= c) {
                        f.go_offline();
                        return Ok(()); // cable pulled
                    }
                    let mut out = b"DATA".to_vec();
                    out.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
                    out.extend_from_slice(chunk);
                    s.write_all(&out).await?;
                    sent += chunk.len();
                }
                s.write_all(b"DONE\0\0\0\0").await?;
            }
            b"SEND" => {
                f.send.fetch_add(1, Ordering::SeqCst);
                let path = payload.rsplit_once(',').map(|(p, _)| p).unwrap_or(&payload).to_string();
                f.put(&path, vec![]);
                let cut = f.drop_push_after.lock().unwrap().take();
                let mut got = 0usize;
                loop {
                    let mut h = [0u8; 8];
                    s.read_exact(&mut h).await?;
                    match &h[..4] {
                        b"DATA" => {
                            let n = u32::from_le_bytes(h[4..].try_into().unwrap()) as usize;
                            let mut buf = vec![0u8; n];
                            s.read_exact(&mut buf).await?;
                            f.files.lock().unwrap().get_mut(&path).unwrap().extend_from_slice(&buf);
                            got += n;
                            if cut.is_some_and(|c| got >= c) {
                                f.go_offline();
                                return Ok(()); // the partial file stays on the "phone"
                            }
                        }
                        b"DONE" => {
                            s.write_all(b"OKAY\0\0\0\0").await?;
                            break;
                        }
                        _ => return Ok(()),
                    }
                }
            }
            _ => return Ok(()),
        }
    }
}

async fn scrcpy_socket(s: &mut TcpStream, sock: ScrcpySocket) -> std::io::Result<()> {
    for (delay_ms, bytes) in sock.chunks {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        s.write_all(&bytes).await?;
    }
    if sock.hold_open {
        let mut b = [0u8; 64];
        while s.read(&mut b).await? > 0 {}
    }
    Ok(()) // dropping the stream hangs up
}

async fn exec(f: &Arc<Fake>, s: &mut TcpStream, cmd: &str) -> std::io::Result<()> {
    if cmd.contains("com.genymobile.scrcpy.Server") {
        if cmd.contains("list_cameras=true") {
            if f.files.lock().unwrap().remove("/data/local/tmp/scrcpy-server.jar").is_none() {
                return s.write_all(b"Aborted\n").await;
            }
            let text = f.camera_list.lock().unwrap().clone();
            return s.write_all(text.as_bytes()).await;
        }
        // Like the real server, it deletes its own jar on start; without the jar the JVM aborts ("Aborted").
        let had_jar = f.files.lock().unwrap().remove("/data/local/tmp/scrcpy-server.jar").is_some();
        if !had_jar {
            return s.write_all(b"Aborted\n").await;
        }
        // The server process lives while this connection stays open.
        f.scrcpy_cmds.lock().unwrap().push(cmd.to_string());
        let mut b = [0u8; 64];
        while s.read(&mut b).await? > 0 {}
        return Ok(());
    }
    if let Some(rest) = cmd.strip_prefix("tail -c +") {
        f.tail.fetch_add(1, Ordering::SeqCst);
        let (n, path) = rest.split_once(' ').unwrap();
        let from = n.parse::<usize>().unwrap() - 1;
        let data = f.get(&unquote(path)).unwrap_or_default();
        let cut = f.pull_drop();
        for (i, chunk) in data[from.min(data.len())..].chunks(64 * 1024).enumerate() {
            if cut.is_some_and(|c| i * 64 * 1024 >= c) {
                f.go_offline();
                return Ok(());
            }
            s.write_all(chunk).await?;
        }
    } else if let Some(rest) = cmd.strip_prefix("find ") {
        // find '<root>'/ -type f -exec stat -c '%s %Y %n' {} +  → "size mtime path" per file, plus some noise like a real phone.
        let root = rest.split(" -type").next().unwrap_or("").replace('\'', "");
        let mut lines: Vec<String> = f.files.lock().unwrap().iter().filter(|(p, _)| p.starts_with(&root)).map(|(p, d)| format!("{} 1700000000 {p}\n", d.len())).collect();
        lines.sort();
        s.write_all(b"stat: '/sdcard/Android/data/x': Permission denied\n").await?;
        for l in lines {
            s.write_all(l.as_bytes()).await?;
        }
    } else if let Some(path) = cmd.strip_prefix("cat >> ") {
        f.cat.fetch_add(1, Ordering::SeqCst);
        let path = unquote(path);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = s.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            f.files.lock().unwrap().entry(path.clone()).or_default().extend_from_slice(&buf[..n]);
        }
    }
    Ok(())
}

async fn shell(f: &Arc<Fake>, s: &mut TcpStream, cmd: &str) -> std::io::Result<()> {
    let cmd = cmd.split("; echo").next().unwrap_or(cmd);
    let mut out = String::new();
    let mut rc = 0;
    if let Some(rest) = cmd.strip_prefix("mv -f ") {
        let (a, b) = rest.split_once("' '").map(|(a, b)| (unquote(a), unquote(b))).unwrap();
        let mut files = f.files.lock().unwrap();
        match files.remove(&a) {
            Some(d) => {
                files.insert(b, d);
            }
            None => rc = 1,
        }
    } else if let Some(rest) = cmd.strip_prefix("rm -f ") {
        f.files.lock().unwrap().remove(&unquote(rest));
    } else if let Some(rest) = cmd.strip_prefix("sha256sum ") {
        let path = unquote(rest);
        match f.get(&path) {
            Some(d) => out = format!("{}  {path}\n", crate::adb::sync::hex(&Sha256::digest(&d))),
            None => rc = 1,
        }
    } // mkdir -p / touch: accepted and ignored
    s.write_all(format!("{out}::rc={rc}\n").as_bytes()).await
}
