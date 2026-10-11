//! Screen mirroring & control, using the scrcpy server (Apache-2.0) on the phone.
//!
//! The server encodes the screen to H.264 and injects the touch/key events we send it. We talk to
//! its abstract socket straight through the ADB server (`localabstract:`), so no port forwarding is
//! needed. Protocol reference: scrcpy v4.1 `doc/develop.md` + `ControlMessageReader.java`.

use crate::adb::{self, connect, send, shell_quote, sync};
use crate::transfer::ctl;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
};

pub const SERVER_VERSION: &str = "4.1";
const SERVER_JAR: &[u8] = include_bytes!("../resources/scrcpy-server-v4.1");
const SERVER_SHA256: &str = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";
pub(crate) const REMOTE_JAR: &str = "/data/local/tmp/scrcpy-server.jar";

// ---------- options ----------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorOptions {
    /// Longest side in pixels; 0 = the phone's native resolution.
    pub max_size: u32,
    /// 0 = the server's default (8 Mbit/s).
    pub bit_rate_mbps: u32,
    /// 0 = don't cap the frame rate.
    pub max_fps: u32,
    /// Turn the phone's screen off while mirroring (still controllable).
    pub screen_off: bool,
    pub show_touches: bool,
    pub stay_awake: bool,
    /// Extra raw `key=value` server options (e.g. `video_encoder=c2.android.avc.encoder`).
    #[serde(default)]
    pub extra: String,
}

impl Default for MirrorOptions {
    fn default() -> Self {
        Self { max_size: 0, bit_rate_mbps: 0, max_fps: 0, screen_off: false, show_touches: false, stay_awake: true, extra: String::new() }
    }
}

/// Only options that differ from the server's defaults are sent: the stock scrcpy client does the
/// same, and some vendor encoders crash on settings that merely restate a default.
pub fn server_args(scid: u32, o: &MirrorOptions) -> String {
    let mut a = vec![
        format!("CLASSPATH={REMOTE_JAR} app_process / com.genymobile.scrcpy.Server {SERVER_VERSION}"),
        format!("scid={scid:08x}"),
        "log_level=info".into(),
        "audio=false".into(),
        "tunnel_forward=true".into(), // we connect to the phone (no reverse tunnel to set up)
    ];
    if o.max_size > 0 { a.push(format!("max_size={}", o.max_size)); }
    if o.bit_rate_mbps > 0 { a.push(format!("video_bit_rate={}", o.bit_rate_mbps * 1_000_000)); }
    if o.max_fps > 0 { a.push(format!("max_fps={}", o.max_fps)); }
    if o.show_touches { a.push("show_touches=true".into()); }
    if !o.stay_awake { a.push("stay_awake=false".into()); }
    if o.screen_off { a.push("power_off_on_close=true".into()); }
    if !o.extra.trim().is_empty() { a.push(o.extra.trim().to_string()); }
    a.join(" ")
}

// ---------- video stream ----------

#[derive(Debug, Clone, PartialEq)]
pub enum VideoMsg {
    /// A new capture session (first one, or after the phone rotated).
    Session { width: u32, height: u32 },
    /// SPS/PPS; must be prepended to the next frame for a decoder.
    Config(Vec<u8>),
    Frame { key: bool, pts_us: u64, data: Vec<u8> },
}

#[derive(Debug, PartialEq)]
pub enum Header {
    Session { width: u32, height: u32 },
    Media { config: bool, key: bool, pts: u64, size: u32 },
}

/// Parse the 12-byte header that precedes every video packet.
pub fn parse_header(b: &[u8; 12]) -> Header {
    let first = u64::from_be_bytes(b[0..8].try_into().unwrap());
    if first >> 63 == 1 {
        return Header::Session { width: u32::from_be_bytes(b[4..8].try_into().unwrap()), height: u32::from_be_bytes(b[8..12].try_into().unwrap()) };
    }
    Header::Media { config: first >> 62 & 1 == 1, key: first >> 61 & 1 == 1, pts: first & ((1 << 61) - 1), size: u32::from_be_bytes(b[8..12].try_into().unwrap()) }
}

/// WebCodecs codec string (`avc1.PPCCLL`) from an SPS NAL unit, e.g. `avc1.640028`.
/// (The UI derives this in TypeScript; this copy is the tested reference implementation.)
#[allow(dead_code)]
pub fn avc_codec_string(config: &[u8]) -> Option<String> {
    // Annex B: 00 00 00 01 | 67 PP CC LL ...
    let i = config.windows(4).position(|w| w == [0, 0, 0, 1] || w[..3] == [0, 0, 1])?;
    let start = if config[i + 2] == 1 { i + 3 } else { i + 4 };
    (config.get(start)? & 0x1f == 7).then_some(())?;
    Some(format!("avc1.{:02x}{:02x}{:02x}", config.get(start + 1)?, config.get(start + 2)?, config.get(start + 3)?))
}

// ---------- control messages (client → phone) ----------

pub mod msg {
    #[allow(dead_code)]
    pub const KEY_DOWN: u8 = 0;
    #[allow(dead_code)]
    pub const KEY_UP: u8 = 1;
    #[allow(dead_code)]
    pub const TOUCH_DOWN: u8 = 0;
    pub const TOUCH_UP: u8 = 1;
    #[allow(dead_code)] // the UI sends MOVE (2); kept here for the protocol reference
    pub const TOUCH_MOVE: u8 = 2;
    /// Pointer id scrcpy uses for "the mouse"; with only the primary button it acts as a finger.
    pub const POINTER_MOUSE: i64 = -1;

    fn pos(out: &mut Vec<u8>, x: i32, y: i32, w: u16, h: u16) {
        out.extend_from_slice(&x.to_be_bytes());
        out.extend_from_slice(&y.to_be_bytes());
        out.extend_from_slice(&w.to_be_bytes());
        out.extend_from_slice(&h.to_be_bytes());
    }

    pub fn touch(action: u8, x: i32, y: i32, w: u16, h: u16, pressure: f32, buttons: u32) -> Vec<u8> {
        let mut o = vec![2, action];
        o.extend_from_slice(&POINTER_MOUSE.to_be_bytes());
        pos(&mut o, x, y, w, h);
        let p = if pressure >= 1.0 { 0xffffu16 } else { (pressure.max(0.0) * 65536.0) as u16 };
        o.extend_from_slice(&p.to_be_bytes());
        o.extend_from_slice(&1i32.to_be_bytes()); // action button: primary
        o.extend_from_slice(&(buttons as i32).to_be_bytes());
        o
    }

    pub fn key(action: u8, keycode: i32, repeat: i32, meta: i32) -> Vec<u8> {
        let mut o = vec![0, action];
        o.extend_from_slice(&keycode.to_be_bytes());
        o.extend_from_slice(&repeat.to_be_bytes());
        o.extend_from_slice(&meta.to_be_bytes());
        o
    }

    pub fn text(s: &str) -> Vec<u8> {
        let b = s.as_bytes();
        let mut o = vec![1];
        o.extend_from_slice(&(b.len() as u32).to_be_bytes());
        o.extend_from_slice(b);
        o
    }

    /// `h`/`v` in [-1, 1]; the server scales them by 16.
    pub fn scroll(x: i32, y: i32, w: u16, hgt: u16, h: f32, v: f32, buttons: u32) -> Vec<u8> {
        let fx = |f: f32| (f.clamp(-1.0, 1.0) * 32767.0) as i16;
        let mut o = vec![3];
        pos(&mut o, x, y, w, hgt);
        o.extend_from_slice(&fx(h).to_be_bytes());
        o.extend_from_slice(&fx(v).to_be_bytes());
        o.extend_from_slice(&(buttons as i32).to_be_bytes());
        o
    }

    pub fn back_or_screen_on(action: u8) -> Vec<u8> {
        vec![4, action]
    }

    pub fn set_clipboard(seq: u64, paste: bool, text: &str) -> Vec<u8> {
        let mut o = vec![9];
        o.extend_from_slice(&seq.to_be_bytes());
        o.push(paste as u8);
        o.extend_from_slice(&(text.len() as u32).to_be_bytes());
        o.extend_from_slice(text.as_bytes());
        o
    }

    pub fn display_power(on: bool) -> Vec<u8> {
        vec![10, on as u8]
    }

    pub const EXPAND_NOTIFICATIONS: u8 = 5;
    pub const EXPAND_SETTINGS: u8 = 6;
    pub const COLLAPSE_PANELS: u8 = 7;
    pub const ROTATE_DEVICE: u8 = 11;
    pub const RESET_VIDEO: u8 = 17;

    pub fn empty(kind: u8) -> Vec<u8> {
        vec![kind]
    }
}

/// Typed input from the UI.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Input {
    Touch { action: u8, x: i32, y: i32, w: u16, h: u16, pressure: f32 },
    Key { action: u8, keycode: i32, meta: i32 },
    Text { text: String },
    Scroll { x: i32, y: i32, w: u16, h: u16, hscroll: f32, vscroll: f32 },
    BackOrScreenOn { action: u8 },
    Panel { kind: String },
    Rotate,
    SetClipboard { text: String, paste: bool },
    DisplayPower { on: bool },
    ResetVideo,
}

impl Input {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Input::Touch { action, x, y, w, h, pressure } => msg::touch(*action, *x, *y, *w, *h, *pressure, if *action == msg::TOUCH_UP { 0 } else { 1 }),
            Input::Key { action, keycode, meta } => msg::key(*action, *keycode, 0, *meta),
            Input::Text { text } => msg::text(text),
            Input::Scroll { x, y, w, h, hscroll, vscroll } => msg::scroll(*x, *y, *w, *h, *hscroll, *vscroll, 0),
            Input::BackOrScreenOn { action } => msg::back_or_screen_on(*action),
            Input::Panel { kind } => msg::empty(match kind.as_str() {
                "settings" => msg::EXPAND_SETTINGS,
                "collapse" => msg::COLLAPSE_PANELS,
                _ => msg::EXPAND_NOTIFICATIONS,
            }),
            Input::Rotate => msg::empty(msg::ROTATE_DEVICE),
            Input::SetClipboard { text, paste } => msg::set_clipboard(0, *paste, text),
            Input::DisplayPower { on } => msg::display_power(*on),
            Input::ResetVideo => msg::empty(msg::RESET_VIDEO),
        }
    }
}

// ---------- the session ----------

#[derive(Debug, Clone)]
pub enum DeviceMsg {
    Clipboard(String),
}

pub struct Session {
    pub device_name: String,
    control: mpsc::UnboundedSender<Vec<u8>>,
    stop: tokio::sync::watch::Sender<bool>,
    pub video: mpsc::Receiver<VideoMsg>,
    pub device: mpsc::UnboundedReceiver<DeviceMsg>,
    /// Last lines the server printed (for error messages).
    pub log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl Session {
    pub fn send(&self, bytes: Vec<u8>) {
        let _ = self.control.send(bytes);
    }
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
    pub fn control_handle(&self) -> ControlHandle {
        ControlHandle { tx: self.control.clone(), stop: self.stop.clone() }
    }
}

/// Cheap clone for sending input / stopping from other tasks.
#[derive(Clone)]
pub struct ControlHandle {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    stop: tokio::sync::watch::Sender<bool>,
}

impl ControlHandle {
    pub fn send(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(bytes);
    }
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
}

pub(crate) async fn open_socket(serial: &str, name: &str) -> adb::Result<TcpStream> {
    let mut s = connect().await?;
    send(&mut s, &format!("host:transport:{serial}")).await?;
    send(&mut s, &format!("localabstract:{name}")).await?;
    Ok(s)
}

pub(crate) async fn push_server(serial: &str) -> Result<(), String> {
    let got = Sha256::digest(SERVER_JAR);
    if sync::hex(&got) != SERVER_SHA256 {
        return Err("The bundled scrcpy server is corrupted — reinstall Droid Shuttle.".into());
    }
    let tmp = std::env::temp_dir().join(format!("scrcpy-server-{}.jar", std::process::id()));
    tokio::fs::write(&tmp, SERVER_JAR).await.map_err(|e| e.to_string())?;
    let (_o, c) = ctl::channel();
    let r = sync::push(serial, &tmp, REMOTE_JAR, 0o100644, 0, &c, |_| {}).await.map_err(|e| e.to_string());
    let _ = tokio::fs::remove_file(&tmp).await;
    r.map(|_| ())
}

fn friendly(log: &[String]) -> String {
    let text = log.join("\n");
    if text.contains("Could not find any Android device") || text.contains("device offline") {
        return "The phone isn't reachable.".into();
    }
    if text.contains("INJECT_EVENTS") || text.contains("SecurityException") {
        return "Your phone blocked screen control. On some phones (Xiaomi/Redmi, OPPO, Vivo) enable “USB debugging (Security settings)” in Developer options.".into();
    }
    if text.contains("version") && text.contains("server") {
        return format!("Mirroring server version mismatch. {}", log.last().cloned().unwrap_or_default());
    }
    log.iter().rev().find(|l| l.contains("ERROR") || l.contains("Exception")).cloned().unwrap_or_else(|| "The mirroring server stopped unexpectedly.".into())
}

pub async fn start(serial: &str, opts: &MirrorOptions) -> Result<Session, String> {
    push_server(serial).await?;
    let scid: u32 = rand_u31();
    let name = format!("scrcpy_{scid:08x}");

    // The server process lives as long as this exec stream stays open.
    let mut srv = connect().await.map_err(|e| e.to_string())?;
    send(&mut srv, &format!("host:transport:{serial}")).await.map_err(|e| e.to_string())?;
    send(&mut srv, &format!("exec:{}", server_args(scid, opts))).await.map_err(|e| e.to_string())?;
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    {
        let (log, mut stop) = (log.clone(), stop_rx.clone());
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                tokio::select! {
                    n = srv.read(&mut chunk) => match n {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                                let line = String::from_utf8_lossy(&buf[..i]).trim().to_string();
                                buf.drain(..=i);
                                if !line.is_empty() {
                                    tracing::debug!("scrcpy server: {line}");
                                    let mut l = log.lock().unwrap();
                                    l.push(line);
                                    if l.len() > 30 { l.remove(0); }
                                }
                            }
                        }
                    },
                    _ = stop.changed() => break,
                }
            }
            // Dropping `srv` closes the stream, which ends the server process.
        });
    }

    // The server needs a moment to start listening.
    let mut video = None;
    for _ in 0..60 {
        if let Ok(s) = open_socket(serial, &name).await {
            video = Some(s);
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let mut video = video.ok_or_else(|| friendly(&log.lock().unwrap()))?;
    let control = open_socket(serial, &name).await.map_err(|e| format!("control socket: {e}"))?;

    // First socket: dummy byte, then the device name (64 bytes), then codec id, then a session packet.
    let handshake = async {
        let mut dummy = [0u8; 1];
        video.read_exact(&mut dummy).await?;
        let mut name_buf = [0u8; 64];
        video.read_exact(&mut name_buf).await?;
        let mut codec = [0u8; 4];
        video.read_exact(&mut codec).await?;
        Ok::<_, std::io::Error>((name_buf, codec))
    };
    let (name_buf, codec) = tokio::time::timeout(Duration::from_secs(8), handshake)
        .await
        .map_err(|_| friendly(&log.lock().unwrap()))?
        .map_err(|_| friendly(&log.lock().unwrap()))?;
    if &codec != b"h264" {
        return Err(format!("Unexpected video codec {:?}", String::from_utf8_lossy(&codec)));
    }
    let device_name = String::from_utf8_lossy(&name_buf).trim_end_matches('\0').to_string();

    let (vtx, vrx) = mpsc::channel::<VideoMsg>(8);
    let (ctx, mut crx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (dtx, drx) = mpsc::unbounded_channel::<DeviceMsg>();

    // Video reader.
    {
        let mut stop = stop_rx.clone();
        tokio::spawn(async move {
            let mut video = video;
            loop {
                let mut h = [0u8; 12];
                tokio::select! {
                    r = video.read_exact(&mut h) => if r.is_err() { break },
                    _ = stop.changed() => break,
                }
                let out = match parse_header(&h) {
                    Header::Session { width, height } => VideoMsg::Session { width, height },
                    Header::Media { config, key, pts, size } => {
                        let mut data = vec![0u8; size as usize];
                        if video.read_exact(&mut data).await.is_err() {
                            break;
                        }
                        if config { VideoMsg::Config(data) } else { VideoMsg::Frame { key, pts_us: pts, data } }
                    }
                };
                if vtx.send(out).await.is_err() {
                    break; // consumer gone
                }
            }
        });
    }

    // Control: writer + device-message reader.
    {
        let (mut rd, mut wr) = control.into_split();
        let mut stop = stop_rx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    m = crx.recv() => match m { Some(b) => if wr.write_all(&b).await.is_err() { break }, None => break },
                    _ = stop.changed() => break,
                }
            }
        });
        let mut stop = stop_rx;
        tokio::spawn(async move {
            loop {
                let mut t = [0u8; 1];
                tokio::select! {
                    r = rd.read_exact(&mut t) => if r.is_err() { break },
                    _ = stop.changed() => break,
                }
                match t[0] {
                    0 => {
                        let mut l = [0u8; 4];
                        if rd.read_exact(&mut l).await.is_err() { break }
                        let mut text = vec![0u8; (u32::from_be_bytes(l) as usize).min(1 << 20)];
                        if rd.read_exact(&mut text).await.is_err() { break }
                        let _ = dtx.send(DeviceMsg::Clipboard(String::from_utf8_lossy(&text).into_owned()));
                    }
                    1 => { let mut b = [0u8; 8]; if rd.read_exact(&mut b).await.is_err() { break } } // clipboard ack
                    2 => { let mut b = [0u8; 4]; if rd.read_exact(&mut b).await.is_err() { break }; let n = u16::from_be_bytes([b[2], b[3]]) as usize; let mut d = vec![0u8; n]; if rd.read_exact(&mut d).await.is_err() { break } } // uhid output
                    _ => break,
                }
            }
        });
    }

    Ok(Session { device_name, control: ctx, stop: stop_tx, video: vrx, device: drx, log })
}

pub(crate) fn rand_u31() -> u32 {
    let mut b = [0u8; 4];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    u32::from_le_bytes(b) & 0x7fff_ffff
}

/// Quote helper re-exported for tests of the command line.
#[allow(dead_code)]
pub fn quote(s: &str) -> String {
    shell_quote(s)
}

// ---------- screenshots & recordings ----------

/// PNG screenshot of the phone's screen (works with or without a mirror session).
pub async fn screenshot(serial: &str) -> Result<Vec<u8>, String> {
    let png = adb::exec(serial, "screencap -p").await.map_err(|e| e.to_string())?;
    if png.len() < 100 || !png.starts_with(b"\x89PNG") {
        return Err("The phone didn't return a screenshot (is the screen off or the app blocking captures?).".into());
    }
    Ok(png)
}

/// `Screenshot 2026-10-04 17.32.10.png` in local time (same style macOS uses).
pub fn timestamped(prefix: &str, ext: &str) -> String {
    let stamp = std::process::Command::new("date").arg("+%Y-%m-%d %H.%M.%S").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "now".into());
    format!("{prefix} {stamp}.{ext}")
}

pub fn recording_remote_path() -> String {
    format!("/sdcard/Download/.droidshuttle-recording-{}.mp4", std::process::id())
}

/// Start `screenrecord` on the phone (Android caps a single recording at 3 minutes).
/// The returned stream keeps the process alive; dropping it ends the recording.
pub async fn record_start(serial: &str, remote: &str, bit_rate_mbps: u32) -> Result<TcpStream, String> {
    let mut s = connect().await.map_err(|e| e.to_string())?;
    send(&mut s, &format!("host:transport:{serial}")).await.map_err(|e| e.to_string())?;
    send(&mut s, &format!("exec:screenrecord --time-limit 180 --bit-rate {} {}", bit_rate_mbps.max(1) * 1_000_000, shell_quote(remote))).await.map_err(|e| e.to_string())?;
    Ok(s)
}

/// Finish the recording cleanly (SIGINT makes screenrecord write the MP4 index).
pub async fn record_finish(serial: &str, remote: &str, local: &std::path::Path) -> Result<(), String> {
    let _ = adb::shell_rc(serial, "pkill -2 screenrecord").await;
    // Wait for the process to exit and the file to be finalized.
    for _ in 0..40 {
        let (out, _) = adb::shell_rc(serial, "pidof screenrecord").await.map_err(|e| e.to_string())?;
        if out.trim().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let (_o, c) = ctl::channel();
    sync::pull(serial, remote, local, &c, |_| {}).await.map_err(|e| format!("Couldn't copy the recording: {e}"))?;
    let _ = adb::shell_rc(serial, &format!("rm -f {}", shell_quote(remote))).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_and_media_headers() {
        let mut h = [0u8; 12];
        h[0] = 0x80;
        h[4..8].copy_from_slice(&1080u32.to_be_bytes());
        h[8..12].copy_from_slice(&2400u32.to_be_bytes());
        assert_eq!(parse_header(&h), Header::Session { width: 1080, height: 2400 });

        // media packet: key frame, pts 1234567, size 4096
        let first: u64 = (1 << 61) | 1_234_567;
        let mut h = [0u8; 12];
        h[0..8].copy_from_slice(&first.to_be_bytes());
        h[8..12].copy_from_slice(&4096u32.to_be_bytes());
        assert_eq!(parse_header(&h), Header::Media { config: false, key: true, pts: 1_234_567, size: 4096 });

        // config packet
        let first: u64 = 1 << 62;
        let mut h = [0u8; 12];
        h[0..8].copy_from_slice(&first.to_be_bytes());
        assert_eq!(parse_header(&h), Header::Media { config: true, key: false, pts: 0, size: 0 });
    }

    #[test]
    fn codec_string_comes_from_the_sps() {
        let sps = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];
        assert_eq!(avc_codec_string(&sps).as_deref(), Some("avc1.640028"));
        let short_start = [0, 0, 1, 0x67, 0x42, 0xc0, 0x1f];
        assert_eq!(avc_codec_string(&short_start).as_deref(), Some("avc1.42c01f"));
        assert_eq!(avc_codec_string(&[0, 0, 0, 1, 0x65, 1, 2, 3]), None, "an IDR slice is not an SPS");
    }

    #[test]
    fn control_messages_match_the_wire_format() {
        // touch: type, action, pointer(8), x,y(4+4), w,h(2+2), pressure(2), actionButton(4), buttons(4) = 32 bytes
        let t = msg::touch(msg::TOUCH_DOWN, 100, 200, 1080, 2400, 1.0, 1);
        assert_eq!(t.len(), 32);
        assert_eq!(&t[..2], &[2, 0]);
        assert_eq!(&t[2..10], &(-1i64).to_be_bytes());
        assert_eq!(&t[10..14], &100i32.to_be_bytes());
        assert_eq!(&t[18..20], &1080u16.to_be_bytes());
        assert_eq!(&t[22..24], &[0xff, 0xff]);
        assert_eq!(&t[28..32], &1i32.to_be_bytes());
        let up = Input::Touch { action: msg::TOUCH_UP, x: 1, y: 2, w: 3, h: 4, pressure: 0.0 }.encode();
        assert_eq!(&up[22..24], &[0, 0], "pressure 0 on release");
        assert_eq!(&up[28..32], &0i32.to_be_bytes(), "no buttons held on release");

        let k = msg::key(msg::KEY_DOWN, 3, 0, 0);
        assert_eq!(k, vec![0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(msg::text("hi"), vec![1, 0, 0, 0, 2, b'h', b'i']);
        assert_eq!(msg::back_or_screen_on(0), vec![4, 0]);
        let s = msg::scroll(5, 6, 7, 8, 0.0, -1.0, 0);
        assert_eq!(s.len(), 21);
        assert_eq!(i16::from_be_bytes([s[13], s[14]]), 0);
        assert_eq!(i16::from_be_bytes([s[15], s[16]]), -32767);
        let c = msg::set_clipboard(7, true, "héllo");
        assert_eq!(&c[..1], &[9]);
        assert_eq!(c[9], 1);
        assert_eq!(u32::from_be_bytes(c[10..14].try_into().unwrap()), "héllo".len() as u32, "length is in bytes, not chars");
        assert_eq!(msg::display_power(false), vec![10, 0]);
        assert_eq!(Input::Panel { kind: "settings".into() }.encode(), vec![6]);
        assert_eq!(Input::Rotate.encode(), vec![11]);
    }

    #[test]
    fn server_command_line_only_sends_non_default_options() {
        let base = server_args(0xabc, &MirrorOptions { stay_awake: false, ..Default::default() });
        assert!(base.contains("com.genymobile.scrcpy.Server 4.1 scid=00000abc"));
        assert!(base.contains("tunnel_forward=true") && base.contains("audio=false"));
        for absent in ["max_size", "video_bit_rate", "max_fps", "show_touches", "power_off_on_close", "video_codec", "cleanup"] {
            assert!(!base.contains(absent), "{absent} should be left at the server default: {base}");
        }
        let full = server_args(1, &MirrorOptions { max_size: 1080, bit_rate_mbps: 4, max_fps: 30, screen_off: true, show_touches: true, stay_awake: false, extra: "video_encoder=x".into() });
        for present in ["max_size=1080", "video_bit_rate=4000000", "max_fps=30", "show_touches=true", "stay_awake=false", "power_off_on_close=true", "video_encoder=x"] {
            assert!(full.contains(present), "{present} missing: {full}");
        }
    }

    #[test]
    fn bundled_server_matches_its_published_checksum() {
        assert_eq!(sync::hex(&Sha256::digest(SERVER_JAR)), SERVER_SHA256);
    }

    /// Real phone: `cargo test live_mirror -- --ignored --nocapture --test-threads=1`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_mirror_session() {
        let serial = adb::list_devices().await.unwrap().into_iter().find(|d| d.state == adb::AdbState::Ready).expect("device").serial;
        let t0 = std::time::Instant::now();
        let extra = std::env::var("SCRCPY_EXTRA").unwrap_or_default();
        println!("extra options: {extra:?}");
        let env_u32 = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        let (fps, size, mbps) = (env_u32("SCRCPY_FPS"), env_u32("SCRCPY_SIZE"), env_u32("SCRCPY_MBPS"));
        let mut s = start(&serial, &MirrorOptions { max_size: size, bit_rate_mbps: mbps, max_fps: fps, extra, stay_awake: false, ..Default::default() }).await.expect("session");
        println!("started in {:.2}s for {:?}", t0.elapsed().as_secs_f64(), s.device_name);

        // The phone's real size for comparison.
        let wm = adb::shell(&serial, "wm size").await.unwrap();
        println!("wm size: {}", wm.trim());

        let (mut session, mut config, mut keys, mut frames, mut bytes) = (None, None, 0, 0, 0usize);
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(500), s.video.recv()).await {
                Ok(Some(VideoMsg::Session { width, height })) => session = Some((width, height)),
                Ok(Some(VideoMsg::Config(c))) => config = Some(c),
                Ok(Some(VideoMsg::Frame { key, data, .. })) => { frames += 1; keys += key as u32; bytes += data.len(); }
                Ok(None) => break,
                Err(_) => {}
            }
        }
        println!("server log:\n  {}", s.log.lock().unwrap().join("\n  "));
        let (w, h) = session.expect("a session packet with the video size");
        let codec = avc_codec_string(config.as_ref().expect("an SPS/PPS config packet")).expect("codec string");
        println!("video {w}x{h}, codec {codec}, {frames} frames ({keys} key) in 4s = {:.1} fps, {:.0} kbit/s", frames as f64 / 4.0, bytes as f64 * 8.0 / 4.0 / 1000.0);
        assert!(w > 0 && h > 0);
        assert!(frames > 0 && keys > 0, "got frames, including a key frame");

        // Input: switch the display off and on again, and read the phone's power state back.
        let power = || async { adb::shell(&serial, "dumpsys display | grep -m1 'Display State='").await.unwrap().trim().to_string() };
        s.send(Input::DisplayPower { on: false }.encode());
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let off = power().await;
        // "Back or screen on": wakes a sleeping display (and acts as Back when it's already on).
        s.send(Input::BackOrScreenOn { action: msg::KEY_DOWN }.encode());
        s.send(Input::BackOrScreenOn { action: msg::KEY_UP }.encode());
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let on = power().await;
        println!("display power via control channel: off -> {off:?}, on -> {on:?}");
        assert!(off.contains("State=OFF"), "display should be off: {off}");
        assert!(on.contains("State=ON"), "display should be back on: {on}");

        // Panels open and close without breaking the stream.
        s.send(Input::Panel { kind: "notifications".into() }.encode());
        tokio::time::sleep(Duration::from_millis(600)).await;
        s.send(Input::Panel { kind: "collapse".into() }.encode());
        tokio::time::sleep(Duration::from_millis(400)).await;
        let more = tokio::time::timeout(Duration::from_secs(2), s.video.recv()).await;
        assert!(matches!(more, Ok(Some(_))), "still streaming after panel toggles");

        // Clean shutdown: the server process must be gone from the phone.
        s.stop();
        tokio::time::sleep(Duration::from_millis(2000)).await;
        let ps = adb::shell(&serial, "ps -A -o ARGS | grep com.genymobile.scrcpy.Server | grep -v grep | wc -l").await.unwrap();
        println!("scrcpy server processes left on phone: {}", ps.trim());
        assert_eq!(ps.trim(), "0");
    }

    /// Real phone: `cargo test live_capture -- --ignored --nocapture --test-threads=1`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_screenshot_and_recording() {
        let serial = adb::list_devices().await.unwrap().into_iter().find(|d| d.state == adb::AdbState::Ready).expect("device").serial;
        adb::shell(&serial, "input keyevent KEYCODE_WAKEUP").await.unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;

        let png = screenshot(&serial).await.unwrap();
        let img = image::load_from_memory(&png).unwrap();
        println!("screenshot {}x{}, {} KB", img.width(), img.height(), png.len() / 1024);
        assert_eq!((img.width(), img.height()), (720, 1600));

        let remote = recording_remote_path();
        let stream = record_start(&serial, &remote, 4).await.unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        let local = std::env::temp_dir().join(format!("db-rec-{}.mp4", std::process::id()));
        record_finish(&serial, &remote, &local).await.unwrap();
        drop(stream);
        let bytes = std::fs::read(&local).unwrap();
        println!("recording: {} KB, ftyp box: {:?}", bytes.len() / 1024, String::from_utf8_lossy(&bytes[4..12]));
        assert!(bytes.len() > 2000 && &bytes[4..8] == b"ftyp", "a valid MP4");
        assert!(adb::shell(&serial, &format!("ls {} 2>&1", shell_quote(&remote))).await.unwrap().contains("No such file"), "temp file removed from the phone");
        let _ = std::fs::remove_file(local);
        let n = timestamped("Screenshot", "png");
        println!("name: {n}");
        assert!(n.starts_with("Screenshot 20") && n.ends_with(".png"));
    }
}
