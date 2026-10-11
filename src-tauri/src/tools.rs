//! Power tools: interactive shell (adb shell protocol v2), logcat streaming, a device status
//! dashboard, and wireless ADB (pairing, connecting, "go wireless" from a USB cable).

use crate::adb::{self, connect, read_len_prefixed, send, shell, shell_rc};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

// ---------- adb shell protocol v2 (a real terminal with a pty) ----------

pub const SH_STDIN: u8 = 0;
#[allow(dead_code)] // part of the wire protocol; documents the ids the UI sees
pub const SH_STDOUT: u8 = 1;
#[allow(dead_code)]
pub const SH_STDERR: u8 = 2;
pub const SH_EXIT: u8 = 3;
#[allow(dead_code)]
pub const SH_CLOSE_STDIN: u8 = 4;
pub const SH_WINDOW_SIZE: u8 = 5;

/// One shell-v2 packet: `[id u8][len u32 LE][data]`.
pub fn shell_packet(id: u8, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(5 + data.len());
    v.push(id);
    v.extend_from_slice(&(data.len() as u32).to_le_bytes());
    v.extend_from_slice(data);
    v
}

/// Window-size packet payload: `rowsxcols,xpixelsxypixels`.
pub fn window_size(cols: u16, rows: u16) -> Vec<u8> {
    shell_packet(SH_WINDOW_SIZE, format!("{rows}x{cols},0x0").as_bytes())
}

#[derive(Debug)]
pub enum ShellCmd {
    Input(Vec<u8>),
    Resize(u16, u16),
    Close,
}

#[derive(Default)]
pub struct Shells {
    next: std::sync::atomic::AtomicU64,
    map: std::sync::Mutex<HashMap<u64, mpsc::UnboundedSender<ShellCmd>>>,
}

/// Output chunk from a shell: `[kind u8][bytes]` where kind is 1 stdout, 2 stderr, 3 exit (1 byte code).
pub type ShellOut = Vec<u8>;

impl Shells {
    pub async fn start(self: &Arc<Self>, serial: &str, cols: u16, rows: u16, out: mpsc::UnboundedSender<ShellOut>) -> Result<u64, String> {
        let mut s = connect().await.map_err(|e| e.to_string())?;
        send(&mut s, &format!("host:transport:{serial}")).await.map_err(|e| e.to_string())?;
        send(&mut s, "shell,v2,TERM=xterm-256color,pty:").await.map_err(|e| e.to_string())?;
        s.write_all(&window_size(cols, rows)).await.map_err(|e| e.to_string())?;

        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();
        self.map.lock().unwrap().insert(id, tx);
        let me = self.clone();
        tokio::spawn(async move {
            let (mut rd, mut wr) = s.into_split();
            let reader = async {
                loop {
                    let mut h = [0u8; 5];
                    if rd.read_exact(&mut h).await.is_err() {
                        break;
                    }
                    let len = u32::from_le_bytes([h[1], h[2], h[3], h[4]]) as usize;
                    let mut data = vec![0u8; len.min(1 << 22)];
                    if rd.read_exact(&mut data).await.is_err() {
                        break;
                    }
                    let mut m = Vec::with_capacity(1 + data.len());
                    m.push(h[0]);
                    m.extend_from_slice(&data);
                    let exit = h[0] == SH_EXIT;
                    if out.send(m).is_err() || exit {
                        break;
                    }
                }
            };
            let writer = async {
                while let Some(c) = rx.recv().await {
                    let bytes = match c {
                        ShellCmd::Input(d) => shell_packet(SH_STDIN, &d),
                        ShellCmd::Resize(c, r) => window_size(c, r),
                        ShellCmd::Close => break,
                    };
                    if wr.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            };
            tokio::select! { _ = reader => {}, _ = writer => {} }
            me.map.lock().unwrap().remove(&id);
        });
        Ok(id)
    }

    pub fn send(&self, id: u64, cmd: ShellCmd) {
        if let Some(tx) = self.map.lock().unwrap().get(&id) {
            let _ = tx.send(cmd);
        }
    }
}

// ---------- logcat ----------

/// Stream `logcat` lines in batches (every ~60 ms) to `out` as newline-joined UTF-8.
pub async fn logcat_stream(serial: &str, clear: bool, out: mpsc::UnboundedSender<Vec<u8>>, mut stop: tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
    if clear {
        let _ = shell(serial, "logcat -c").await;
    }
    let mut s = connect().await.map_err(|e| e.to_string())?;
    send(&mut s, &format!("host:transport:{serial}")).await.map_err(|e| e.to_string())?;
    send(&mut s, "exec:logcat -v threadtime -b main,system,crash").await.map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::new();
    let mut batch: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut tick = tokio::time::interval(Duration::from_millis(60));
    loop {
        tokio::select! {
            n = s.read(&mut chunk) => {
                let n = n.map_err(|e| e.to_string())?;
                if n == 0 { break }
                buf.extend_from_slice(&chunk[..n]);
                while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                    batch.extend_from_slice(&buf[..=i]);
                    buf.drain(..=i);
                }
            }
            _ = tick.tick() => {
                if !batch.is_empty() && out.send(std::mem::take(&mut batch)).is_err() { break }
            }
            _ = stop.changed() => break,
        }
    }
    if !batch.is_empty() {
        let _ = out.send(batch);
    }
    Ok(())
}

pub async fn pids_of(serial: &str, package: &str) -> Vec<u32> {
    shell(serial, &format!("pidof {}", adb::shell_quote(package))).await.map(|o| o.split_whitespace().filter_map(|p| p.parse().ok()).collect()).unwrap_or_default()
}

// ---------- device dashboard ----------

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub battery_level: Option<u32>,
    pub battery_status: String,
    pub battery_health: String,
    pub battery_temp_c: Option<f32>,
    pub battery_voltage_mv: Option<u32>,
    pub plugged: String,
    pub mem_total: u64,
    pub mem_available: u64,
    pub storage_total: u64,
    pub storage_used: u64,
    pub uptime_secs: u64,
    pub model: String,
    pub manufacturer: String,
    pub android: String,
    pub sdk: u32,
    pub security_patch: String,
    pub build: String,
    pub abi: String,
    pub screen: String,
    pub density: String,
    pub wifi_ip: Option<String>,
    pub kernel: String,
}

pub fn parse_battery_full(text: &str) -> (Option<u32>, String, String, Option<f32>, Option<u32>, String) {
    let get = |k: &str| text.lines().map(str::trim).find_map(|l| l.strip_prefix(k)).map(|v| v.trim().to_string());
    let level = get("level:").and_then(|v| v.parse().ok());
    let status = match get("status:").as_deref() {
        Some("2") => "Charging",
        Some("3") => "Discharging",
        Some("4") => "Not charging",
        Some("5") => "Full",
        _ => "Unknown",
    };
    let health = match get("health:").as_deref() {
        Some("2") => "Good",
        Some("3") => "Overheating",
        Some("4") => "Dead",
        Some("5") => "Over voltage",
        Some("6") => "Failure",
        Some("7") => "Cold",
        _ => "Unknown",
    };
    let temp = get("temperature:").and_then(|v| v.parse::<f32>().ok()).map(|t| t / 10.0);
    let volt = get("voltage:").and_then(|v| v.parse().ok());
    let plugged = if get("AC powered:").as_deref() == Some("true") {
        "AC charger"
    } else if get("USB powered:").as_deref() == Some("true") {
        "USB"
    } else if get("Wireless powered:").as_deref() == Some("true") {
        "Wireless"
    } else {
        "Not plugged in"
    };
    (level, status.into(), health.into(), temp, volt, plugged.into())
}

/// `MemTotal:  3857432 kB` style lines → bytes.
pub fn parse_meminfo(text: &str) -> (u64, u64) {
    let kb = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)).and_then(|v| v.split_whitespace().next()).and_then(|n| n.parse::<u64>().ok()).unwrap_or(0) * 1024;
    (kb("MemTotal:"), kb("MemAvailable:"))
}

/// First IPv4 address from `ip -f inet addr show wlan0`.
pub fn parse_ip(text: &str) -> Option<String> {
    text.lines().map(str::trim).find_map(|l| l.strip_prefix("inet ")).and_then(|r| r.split(['/', ' ']).next()).map(str::to_string).filter(|s| !s.is_empty())
}

pub async fn device_status(serial: &str) -> Result<DeviceStatus, String> {
    let (props, battery, mem, df, uptime, wm, ip, kernel) = tokio::try_join!(
        shell(serial, "getprop"),
        shell(serial, "dumpsys battery"),
        shell(serial, "cat /proc/meminfo"),
        shell(serial, "df -k /data"),
        shell(serial, "cat /proc/uptime"),
        shell(serial, "wm size; wm density"),
        shell(serial, "ip -f inet addr show wlan0"),
        shell(serial, "uname -sr"),
    )
    .map_err(|e| e.to_string())?;
    let p = crate::device::parse_getprop(&props);
    let g = |k: &str| p.get(k).cloned().unwrap_or_default();
    let (battery_level, battery_status, battery_health, battery_temp_c, battery_voltage_mv, plugged) = parse_battery_full(&battery);
    let (mem_total, mem_available) = parse_meminfo(&mem);
    let (storage_total, storage_used) = crate::device::parse_df(&df);
    let screen = wm.lines().find_map(|l| l.strip_prefix("Physical size:")).unwrap_or("").trim().to_string();
    let density = wm.lines().find_map(|l| l.strip_prefix("Physical density:")).unwrap_or("").trim().to_string();
    Ok(DeviceStatus {
        battery_level, battery_status, battery_health, battery_temp_c, battery_voltage_mv, plugged, mem_total, mem_available, storage_total, storage_used,
        uptime_secs: uptime.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) as u64,
        model: g("ro.product.model"), manufacturer: g("ro.product.manufacturer"), android: g("ro.build.version.release"),
        sdk: g("ro.build.version.sdk").parse().unwrap_or(0), security_patch: g("ro.build.version.security_patch"),
        build: g("ro.build.display.id"), abi: g("ro.product.cpu.abi"), screen, density: density.clone(), wifi_ip: parse_ip(&ip), kernel: kernel.trim().to_string(),
    })
}

// ---------- wireless ADB ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MdnsService {
    pub name: String,
    /// `_adb-tls-pairing._tcp` (waiting to be paired) or `_adb-tls-connect._tcp` (ready to connect).
    pub kind: String,
    pub address: String,
}

/// Lines of `host:mdns:services`: `name<TAB>_adb-tls-connect._tcp<TAB>192.168.1.5:37099`.
pub fn parse_mdns(text: &str) -> Vec<MdnsService> {
    text.lines()
        .filter_map(|l| {
            let mut p = l.split('\t');
            let (name, kind, addr) = (p.next()?.trim(), p.next()?.trim(), p.next()?.trim());
            (kind.starts_with("_adb") && !addr.is_empty()).then(|| MdnsService { name: name.into(), kind: kind.trim_end_matches('.').into(), address: addr.into() })
        })
        .collect()
}

async fn host_text(cmd: &str) -> Result<String, String> {
    let mut s = connect().await.map_err(|e| e.to_string())?;
    send(&mut s, cmd).await.map_err(|e| e.to_string())?;
    // `connect`/`pair` answer with a length-prefixed message; mdns lists answer with raw text.
    match read_len_prefixed(&mut s).await {
        Ok(t) => Ok(t),
        Err(_) => Ok(String::new()),
    }
}

pub async fn mdns_services() -> Vec<MdnsService> {
    host_text("host:mdns:services").await.map(|t| parse_mdns(&t)).unwrap_or_default()
}

pub fn pair_ok(msg: &str) -> bool {
    msg.to_lowercase().contains("successfully paired")
}

pub fn connect_ok(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("connected to") || m.contains("already connected")
}

pub async fn pair(host_port: &str, code: &str) -> Result<String, String> {
    let msg = host_text(&format!("host:pair:{code}:{host_port}")).await?;
    if pair_ok(&msg) { Ok(msg) } else { Err(if msg.is_empty() { "Pairing failed. Check the code and that the phone's pairing screen is still open.".into() } else { msg }) }
}

pub async fn connect_to(host_port: &str) -> Result<String, String> {
    let msg = host_text(&format!("host:connect:{host_port}")).await?;
    if connect_ok(&msg) { Ok(msg) } else { Err(if msg.is_empty() { format!("Couldn't connect to {host_port}.") } else { msg }) }
}

pub async fn disconnect(host_port: &str) -> Result<(), String> {
    host_text(&format!("host:disconnect:{host_port}")).await.map(|_| ())
}

/// USB → Wi-Fi in one step: switch the phone's adbd to TCP, find its address, connect to it.
pub async fn go_wireless(serial: &str, port: u16) -> Result<String, String> {
    let ip = parse_ip(&shell(serial, "ip -f inet addr show wlan0").await.map_err(|e| e.to_string())?).ok_or("The phone isn't connected to Wi-Fi. Connect it to the same network as this Mac first.")?;
    let (out, rc) = shell_rc(serial, &format!("setprop service.adb.tcp.port {port}; stop adbd; start adbd")).await.map_err(|e| e.to_string())?;
    let _ = (out, rc);
    // Fallback for phones where that isn't allowed from the shell user: the adb client command.
    let bin = adb::adb_binary().map_err(|e| e.to_string())?;
    let out = tokio::process::Command::new(bin).args(["-s", serial, "tcpip", &port.to_string()]).output().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if !text.contains("restarting in TCP mode") && !out.status.success() {
        return Err(format!("Couldn't switch to wireless mode: {}", text.trim()));
    }
    let addr = format!("{ip}:{port}");
    for _ in 0..15 {
        tokio::time::sleep(Duration::from_millis(600)).await;
        if connect_to(&addr).await.is_ok() {
            return Ok(addr);
        }
    }
    Err(format!("The phone didn't accept a connection at {addr}. Make sure the Mac and phone are on the same Wi-Fi network."))
}

/// A throwaway name/password pair for QR pairing (`WIFI:T:ADB;S:<name>;P:<password>;;`).
pub fn qr_credentials() -> (String, String) {
    let mut b = [0u8; 12];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    (format!("studio-{}", &hex[..10]), hex[10..22].to_string())
}

pub fn qr_payload(name: &str, password: &str) -> String {
    format!("WIFI:T:ADB;S:{name};P:{password};;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_packets_use_the_v2_framing() {
        assert_eq!(shell_packet(SH_STDIN, b"ls\n"), vec![0, 3, 0, 0, 0, b'l', b's', b'\n']);
        assert_eq!(window_size(80, 24), shell_packet(SH_WINDOW_SIZE, b"24x80,0x0"));
        assert_eq!(shell_packet(SH_CLOSE_STDIN, b""), vec![4, 0, 0, 0, 0]);
    }

    #[test]
    fn parses_battery_in_plain_words() {
        let t = "Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  Wireless powered: false\n  status: 2\n  health: 2\n  level: 87\n  voltage: 4311\n  temperature: 312\n";
        let (lvl, st, h, temp, v, plug) = parse_battery_full(t);
        assert_eq!((lvl, st.as_str(), h.as_str(), v, plug.as_str()), (Some(87), "Charging", "Good", Some(4311), "USB"));
        assert!((temp.unwrap() - 31.2).abs() < 1e-3);
        let (_, st, ..) = parse_battery_full("  status: 5\n");
        assert_eq!(st, "Full");
        let (_, _, _, _, _, plug) = parse_battery_full("  AC powered: false\n  USB powered: false\n");
        assert_eq!(plug, "Not plugged in");
    }

    #[test]
    fn parses_meminfo_and_ip() {
        assert_eq!(parse_meminfo("MemTotal:        3857432 kB\nMemFree:  100 kB\nMemAvailable:    1234567 kB\n"), (3857432 * 1024, 1234567 * 1024));
        let ip = "29: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet 192.168.1.37/24 brd 192.168.1.255 scope global wlan0\n       valid_lft forever\n";
        assert_eq!(parse_ip(ip).as_deref(), Some("192.168.1.37"));
        assert_eq!(parse_ip("Device \"wlan0\" does not exist.\n"), None);
    }

    #[test]
    fn parses_mdns_and_wireless_replies() {
        let t = "adb-R8VYB0143NB-abc\t_adb-tls-connect._tcp.\t192.168.1.37:37099\nstudio-abc\t_adb-tls-pairing._tcp.\t192.168.1.37:41201\nbogus line\n";
        let s = parse_mdns(t);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], MdnsService { name: "adb-R8VYB0143NB-abc".into(), kind: "_adb-tls-connect._tcp".into(), address: "192.168.1.37:37099".into() });
        assert_eq!(s[1].kind, "_adb-tls-pairing._tcp");
        assert!(pair_ok("Successfully paired to 192.168.1.37:41201 [guid=adb-xyz]"));
        assert!(!pair_ok("Failed: Wrong password or connection was dropped."));
        assert!(connect_ok("connected to 192.168.1.37:5555") && connect_ok("already connected to 192.168.1.37:5555"));
        assert!(!connect_ok("failed to connect to '192.168.1.37:5555': Connection refused"));
    }

    #[test]
    fn qr_payload_matches_the_adb_pairing_format() {
        let (name, pw) = qr_credentials();
        assert!(name.starts_with("studio-") && pw.len() == 12);
        assert_eq!(qr_payload("studio-ab", "123456789012"), "WIFI:T:ADB;S:studio-ab;P:123456789012;;");
        let (n2, _) = qr_credentials();
        assert_ne!(name, n2, "random each time");
    }

    /// Real phone: `cargo test live_tools -- --ignored --nocapture --test-threads=1`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_tools() {
        let serial = adb::list_devices().await.unwrap().into_iter().find(|d| d.state == adb::AdbState::Ready).expect("device").serial;

        // dashboard
        let st = device_status(&serial).await.unwrap();
        println!("status: {st:?}");
        assert!(st.battery_level.is_some() && st.mem_total > 0 && st.storage_total > 0 && st.uptime_secs > 0 && !st.model.is_empty());

        // interactive shell: run a command in a real pty and read the echo back
        let shells = Arc::new(Shells::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = shells.start(&serial, 100, 30, tx).await.unwrap();
        shells.send(id, ShellCmd::Input(b"echo droidshuttle-$((6*7)); stty size; exit\n".to_vec()));
        let mut text = String::new();
        let mut exit = None;
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Some(m)) if m[0] == SH_EXIT => { exit = Some(m[1]); break }
                Ok(Some(m)) => text.push_str(&String::from_utf8_lossy(&m[1..])),
                Ok(None) => break,
                Err(_) => {}
            }
        }
        println!("shell output: {:?} exit={exit:?}", text);
        assert!(text.contains("droidshuttle-42"), "command ran");
        assert!(text.contains("30 100"), "pty got our window size (rows cols): {text:?}");
        assert_eq!(exit, Some(0));

        // logcat: lines arrive in threadtime format
        let (ltx, mut lrx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let s2 = serial.clone();
        let task = tokio::spawn(async move { logcat_stream(&s2, false, ltx, stop_rx).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        shell(&serial, "log -t Droid ShuttleTest 'hello from the test'").await.unwrap();
        let mut got = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        while std::time::Instant::now() < deadline && !got.contains("hello from the test") {
            if let Ok(Some(b)) = tokio::time::timeout(Duration::from_millis(500), lrx.recv()).await { got.push_str(&String::from_utf8_lossy(&b)); }
        }
        let _ = stop_tx.send(true);
        let _ = task.await;
        let line = got.lines().find(|l| l.contains("Droid ShuttleTest")).unwrap_or("").to_string();
        println!("logcat line: {line}");
        assert!(line.contains("hello from the test"));

        // mdns discovery works (may be empty)
        println!("mdns: {:?}", mdns_services().await);
    }
}
