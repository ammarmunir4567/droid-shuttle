//! Use the phone's camera and microphone as a webcam and mic on the Mac.
//!
//! The scrcpy server on the phone (the same jar Mirror uses) captures the camera as H.264 and the
//! microphone as raw PCM. Video is re-wrapped as MPEG-TS on a loopback port for OBS's Media Source (OBS
//! then provides the "OBS Virtual Camera" Zoom/Meet can pick); the mic is played into BlackHole, which
//! Zoom/Meet can pick as a microphone. Nothing here touches the Mac's own camera or microphone.

mod audio;
mod hub;
mod ts;

pub use audio::OutputDevice;

use crate::adb::{self, connect, send};
use crate::mirror::{self, Header};
use hub::Hub;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

/// Port OBS connects to; another one is used if it's taken.
const DEFAULT_PORT: u16 = 5400;
const CODEC_RAW_AUDIO: u32 = 0x0072_6177; // "\0raw"
const MIC_SOURCES: [&str; 5] = ["mic", "mic-voice-communication", "mic-camcorder", "mic-unprocessed", "mic-voice-recognition"];

// ---------- options ----------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CameraOptions {
    /// Camera id from the phone's list; empty = choose by `facing`.
    pub camera_id: String,
    /// `front`, `back` or `external`.
    pub facing: String,
    pub width: u32,
    pub height: u32,
    /// 0 or 30 = the camera's default.
    pub fps: u32,
    /// 0 = the server's default (8 Mbit/s).
    pub bit_rate_mbps: u32,
    /// 0, 90, 180 or 270.
    pub rotation: u32,
    pub mic: bool,
    pub mic_source: String,
    /// Delays the mic so it lines up with video that OBS delivers late.
    pub audio_delay_ms: u32,
    /// Mac output device for the mic; empty = BlackHole.
    pub output_device: String,
    /// Loopback port for OBS; 0 = 5400 (or a free one).
    pub port: u16,
}

impl Default for CameraOptions {
    fn default() -> Self {
        Self { camera_id: String::new(), facing: "back".into(), width: 1920, height: 1080, fps: 30, bit_rate_mbps: 0, rotation: 0, mic: true, mic_source: "mic".into(), audio_delay_ms: 0, output_device: String::new(), port: 0 }
    }
}

impl CameraOptions {
    /// The values end up on a command line on the phone, so only known-safe ones get through.
    pub fn validate(&mut self) -> Result<(), String> {
        let bad = |what: &str| Err(format!("Invalid camera setting: {what}."));
        if !["front", "back", "external", ""].contains(&self.facing.as_str()) {
            return bad("camera facing");
        }
        if self.camera_id.len() > 32 || !self.camera_id.chars().all(|c| c.is_ascii_alphanumeric() || "_-.:".contains(c)) {
            return bad("camera id");
        }
        if !MIC_SOURCES.contains(&self.mic_source.as_str()) {
            return bad("microphone source");
        }
        if ![0, 90, 180, 270].contains(&self.rotation) {
            return bad("rotation");
        }
        if (self.width == 0) != (self.height == 0) || self.width > 8192 || self.height > 8192 {
            return bad("resolution");
        }
        if self.port != 0 && self.port < 1024 {
            return bad("port");
        }
        self.audio_delay_ms = self.audio_delay_ms.min(1000);
        Ok(())
    }
}

/// Server command line. The stock scrcpy client sends only what it needs and some vendor encoders crash on
/// extras (see the Mirror notes), so `minimal` — the automatic second attempt — drops every optional tuning
/// option and keeps only what the camera and mic need.
pub fn server_args(scid: u32, o: &CameraOptions, minimal: bool) -> String {
    let mut a = vec![
        format!("CLASSPATH={} app_process / com.genymobile.scrcpy.Server {}", mirror::REMOTE_JAR, mirror::SERVER_VERSION),
        format!("scid={scid:08x}"),
        "log_level=info".into(),
        "video_source=camera".into(),
        "control=false".into(),
        "tunnel_forward=true".into(),
    ];
    if !o.camera_id.is_empty() {
        a.push(format!("camera_id={}", o.camera_id));
    } else if !o.facing.is_empty() {
        a.push(format!("camera_facing={}", o.facing));
    }
    // Without a size the server picks the sensor's largest mode (e.g. 4000x3000), far too heavy to stream.
    if o.width > 0 && o.height > 0 {
        a.push(format!("camera_size={}x{}", o.width, o.height));
    }
    if o.rotation != 0 {
        a.push(format!("capture_orientation={}", o.rotation));
    }
    if o.mic {
        a.push(format!("audio_source={}", o.mic_source));
        a.push("audio_codec=raw".into());
    } else {
        a.push("audio=false".into());
    }
    if !minimal {
        // 30 is what Android's camera does anyway; only a different rate is worth sending.
        if o.fps > 0 && o.fps != 30 {
            a.push(format!("camera_fps={}", o.fps));
        }
        if o.bit_rate_mbps > 0 {
            a.push(format!("video_bit_rate={}", o.bit_rate_mbps * 1_000_000));
        }
        // The server's own default is one key frame every 10 s; OBS can only show a picture from a key frame, so ask for
        // more. Measured on a Galaxy A07 (MediaTek): `1` gives one every 2 s (that encoder doubles it), `2` every 4 s.
        a.push("video_codec_options=i-frame-interval=1".into());
    }
    a.join(" ")
}

// ---------- the phone's cameras ----------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCamera {
    pub id: String,
    pub facing: String,
    /// The sensor's full size.
    pub width: u32,
    pub height: u32,
    pub fps: Vec<u32>,
    /// Sizes the camera can stream, largest first.
    pub sizes: Vec<Size>,
}

fn parse_size(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.trim().split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// Parse the server's `list_cameras=true list_camera_sizes=true` output, e.g.
/// ```text
/// List of cameras:
///     --camera-id=0    (back, 4000x3000, fps={15, 24, 30}, zoom-range=[1, 8])
///         - 4000x3000
///       High speed capture (--camera-high-speed):
///         - 1920x1080 (fps={120, 240})
/// ```
pub fn parse_camera_list(text: &str) -> Vec<PhoneCamera> {
    let mut cams: Vec<PhoneCamera> = vec![];
    let mut high_speed = false;
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.split("--camera-id=").nth(1) {
            let id = rest.split_whitespace().next().unwrap_or_default().to_string();
            let inner = rest.split_once('(').map(|(_, r)| r).unwrap_or_default();
            let mut parts = inner.splitn(3, ',');
            let facing = parts.next().unwrap_or("unknown").trim().to_string();
            let (width, height) = parts.next().and_then(parse_size).unwrap_or((0, 0));
            let fps = inner.split_once("fps={").and_then(|(_, r)| r.split_once('}')).map(|(l, _)| l.split(',').filter_map(|n| n.trim().parse().ok()).collect()).unwrap_or_default();
            cams.push(PhoneCamera { id, facing, width, height, fps, sizes: vec![] });
            high_speed = false;
        } else if line.contains("High speed capture") {
            high_speed = true;
        } else if let (Some(cam), Some(rest), false) = (cams.last_mut(), line.strip_prefix("- "), high_speed) {
            if let Some((width, height)) = parse_size(rest) {
                if !cam.sizes.iter().any(|s| s.width == width && s.height == height) {
                    cam.sizes.push(Size { width, height });
                }
            }
        }
    }
    for c in &mut cams {
        c.sizes.sort_by_key(|s| std::cmp::Reverse(s.width as u64 * s.height as u64));
    }
    cams
}

pub async fn list_cameras(serial: &str) -> Result<Vec<PhoneCamera>, String> {
    mirror::push_server(serial).await?;
    let cmd = format!("CLASSPATH={} app_process / com.genymobile.scrcpy.Server {} log_level=info list_cameras=true list_camera_sizes=true", mirror::REMOTE_JAR, mirror::SERVER_VERSION);
    let out = tokio::time::timeout(Duration::from_secs(20), adb::exec(serial, &cmd))
        .await
        .map_err(|_| "The phone didn't answer when asked for its cameras.".to_string())?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out);
    let cams = parse_camera_list(&text);
    if cams.is_empty() {
        let lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).collect();
        return Err(if text.contains("(access denied)") { friendly(&["CameraAccessException".to_string()]) } else { friendly(&lines) });
    }
    Ok(cams)
}

/// A readable reason from the server's log lines.
fn friendly(log: &[String]) -> String {
    let text = log.join("\n");
    let has = |s: &str| text.contains(s);
    if has("Could not find any Android device") || has("device offline") {
        "The phone isn't reachable.".into()
    } else if has("before Android 12") || has("Camera mirroring is not supported") {
        "Sharing the camera needs Android 12 or newer.".into()
    } else if has("CAMERA_IN_USE") || has("Max cameras in use") || has("in use by another") {
        "Another app is using the phone's camera. Close it and try again.".into()
    } else if has("CameraAccessException") || has("CAMERA_DISABLED") || has("access denied") || has("Permission Denial") {
        "The phone blocked access to its camera. Check that no policy or privacy setting disables the camera, and that the screen is unlocked.".into()
    } else if has("Invalid size") || has("CAMERA_ERROR") || has("configuration") && has("amera") {
        "The phone's camera doesn't support that resolution. Try 720p.".into()
    } else {
        log.iter().rev().find(|l| l.contains("ERROR") || l.contains("Exception")).cloned().unwrap_or_else(|| match log.last() {
            Some(last) => format!("The camera stream stopped unexpectedly ({last})."),
            None => "The camera stream stopped unexpectedly.".into(),
        })
    }
}

/// A second attempt with minimal options only helps when the first failure looks like an encoder or
/// camera-configuration problem, not when the phone is unreachable or the camera is blocked.
fn worth_retrying(err: &str) -> bool {
    !["isn't reachable", "Android 12", "Another app", "blocked access", "corrupted"].iter().any(|s| err.contains(s))
}

// ---------- prerequisites ----------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prereqs {
    pub obs_installed: bool,
    pub blackhole_installed: bool,
    pub sdk: u32,
    pub camera_supported: bool,
    pub mic_supported: bool,
}

pub async fn prereqs(serial: &str) -> Prereqs {
    let sdk = adb::shell(serial, "getprop ro.build.version.sdk").await.ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    let home = std::env::var("HOME").unwrap_or_default();
    let obs_installed = ["/Applications/OBS.app".to_string(), format!("{home}/Applications/OBS.app")].iter().any(|p| std::path::Path::new(p).exists());
    let blackhole_installed = audio::list_output_devices().iter().any(|d| d.is_blackhole);
    // Android 12 = API 31 (camera); Android 11 = API 30 (audio capture).
    Prereqs { obs_installed, blackhole_installed, sdk, camera_supported: sdk >= 31, mic_supported: sdk >= 30 }
}

pub fn audio_devices() -> Vec<OutputDevice> {
    audio::list_output_devices()
}

// ---------- wire handshake ----------

/// First socket: a dummy byte, the device name (64 bytes), then the 4-byte codec id.
async fn read_video_handshake<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<(String, [u8; 4])> {
    let mut dummy = [0u8; 1];
    r.read_exact(&mut dummy).await?;
    let mut name = [0u8; 64];
    r.read_exact(&mut name).await?;
    let mut codec = [0u8; 4];
    r.read_exact(&mut codec).await?;
    Ok((String::from_utf8_lossy(&name).trim_end_matches('\0').to_string(), codec))
}

/// Audio socket: just the codec id. `0` = the phone turned audio off, `1` = it couldn't set it up.
async fn read_audio_codec<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<u32> {
    let mut id = [0u8; 4];
    r.read_exact(&mut id).await?;
    Ok(u32::from_be_bytes(id))
}

type Log = Arc<Mutex<Vec<String>>>;

struct Conn {
    device_name: String,
    video: TcpStream,
    audio: Option<TcpStream>,
    mic_note: Option<String>,
    log: Log,
    stop_tx: watch::Sender<bool>,
    stop_rx: watch::Receiver<bool>,
}

/// Start the server on the phone and open its sockets (video, then audio; no control socket).
async fn open_session(serial: &str, opts: &CameraOptions, minimal: bool) -> Result<Conn, String> {
    // The server deletes its own jar as soon as it starts, so every attempt needs a fresh copy on the phone.
    mirror::push_server(serial).await?;
    let scid = mirror::rand_u31();
    let name = format!("scrcpy_{scid:08x}");
    let mut srv = connect().await.map_err(|e| e.to_string())?;
    send(&mut srv, &format!("host:transport:{serial}")).await.map_err(|e| e.to_string())?;
    send(&mut srv, &format!("exec:{}", server_args(scid, opts, minimal))).await.map_err(|e| e.to_string())?;

    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let (stop_tx, stop_rx) = watch::channel(false);
    {
        // Keeps the server alive (the process ends when this stream closes) and collects what it prints.
        let (log, mut stop) = (log.clone(), stop_rx.clone());
        tokio::spawn(async move {
            let (mut buf, mut chunk) = (Vec::new(), [0u8; 2048]);
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
                                    tracing::debug!("scrcpy camera server: {line}");
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
        });
    }

    // What went wrong, once the server has had a moment to print it.
    let why = |log: &Log| {
        let log = log.clone();
        async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let lines = log.lock().unwrap().clone();
            friendly(&lines)
        }
    };

    let mut video = None;
    for _ in 0..60 {
        if let Ok(s) = mirror::open_socket(serial, &name).await {
            video = Some(s);
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let Some(mut video) = video else {
        let e = why(&log).await;
        let _ = stop_tx.send(true);
        return Err(e);
    };
    let mut audio = if opts.mic {
        match mirror::open_socket(serial, &name).await {
            Ok(s) => Some(s),
            Err(e) => {
                let _ = stop_tx.send(true);
                return Err(format!("audio socket: {e}"));
            }
        }
    } else {
        None
    };

    let hs = tokio::time::timeout(Duration::from_secs(10), read_video_handshake(&mut video)).await;
    let (device_name, codec) = match hs {
        Ok(Ok(v)) => v,
        _ => {
            let e = why(&log).await;
            let _ = stop_tx.send(true);
            return Err(e);
        }
    };
    if &codec != b"h264" {
        let _ = stop_tx.send(true);
        return Err(format!("Unexpected video codec {:?}", String::from_utf8_lossy(&codec)));
    }

    let mut mic_note = None;
    if let Some(a) = audio.as_mut() {
        match tokio::time::timeout(Duration::from_secs(10), read_audio_codec(a)).await {
            Ok(Ok(CODEC_RAW_AUDIO)) => {}
            Ok(Ok(0)) => mic_note = Some("The phone couldn't capture its microphone (it needs Android 11 or newer, and another app may be using it). Video still works.".to_string()),
            Ok(Ok(1)) => mic_note = Some("The phone reported a microphone error. Video still works.".to_string()),
            Ok(Ok(other)) => mic_note = Some(format!("The phone sent an unexpected audio format ({other:#x}). Video still works.")),
            _ => mic_note = Some("The phone's microphone didn't answer. Video still works.".to_string()),
        }
        if mic_note.is_some() {
            audio = None;
        }
    }
    Ok(Conn { device_name, video, audio, mic_note, log, stop_tx, stop_rx })
}

// ---------- stream pumps ----------

/// `[kind u8][pts u64 BE][payload]`, the same message layout Mirror sends its UI.
fn pack(kind: u8, pts: u64, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(9 + payload.len());
    v.push(kind);
    v.extend_from_slice(&pts.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

/// Read the phone's video packets and feed the OBS stream (`ts_hub`) and the preview (`preview`).
/// Returns when the phone stops sending or `stop` fires.
async fn run_video<R: AsyncRead + Unpin>(mut r: R, ts_hub: &Hub, preview: &Hub, mut stop: watch::Receiver<bool>) {
    // No sticky tables: every key frame is preceded by PAT/PMT, and a newcomer starts on a key frame, so
    // its continuity counters stay unbroken.
    let mut mux = ts::Muxer::new();
    let mut config: Vec<u8> = Vec::new();
    loop {
        let mut h = [0u8; 12];
        tokio::select! {
            res = r.read_exact(&mut h) => if res.is_err() { break },
            _ = stop.changed() => break,
        }
        match mirror::parse_header(&h) {
            Header::Session { width, height } => {
                let mut p = width.to_be_bytes().to_vec();
                p.extend_from_slice(&height.to_be_bytes());
                preview.publish_sticky(0, pack(0, 0, &p));
            }
            Header::Media { config: is_config, key, pts, size } => {
                let mut data = vec![0u8; size as usize];
                if r.read_exact(&mut data).await.is_err() {
                    break;
                }
                if is_config {
                    preview.publish_sticky(1, pack(1, 0, &data));
                    config = data;
                } else {
                    let au = ts::access_unit(&config, &data, key);
                    let mut chunk = if key { mux.tables() } else { Vec::new() }; // tables ahead of every key frame
                    chunk.extend(mux.video(&au, pts, key));
                    ts_hub.publish_frame(key, chunk);
                    preview.publish_frame(key, pack(if key { 2 } else { 3 }, pts, &data));
                }
            }
        }
    }
}

/// Read the phone's raw microphone packets: `sink` gets the PCM, `on_level` the peak level every ~100 ms.
async fn run_audio<R: AsyncRead + Unpin>(mut r: R, mut sink: impl FnMut(&[u8]), mut on_level: impl FnMut(f32), mut stop: watch::Receiver<bool>) {
    let (mut peak, mut last) = (0f32, tokio::time::Instant::now());
    loop {
        let mut h = [0u8; 12];
        tokio::select! {
            res = r.read_exact(&mut h) => if res.is_err() { break },
            _ = stop.changed() => break,
        }
        let Header::Media { size, .. } = mirror::parse_header(&h) else { break };
        let mut data = vec![0u8; (size as usize).min(1 << 20)];
        if r.read_exact(&mut data).await.is_err() {
            break;
        }
        sink(&data);
        peak = peak.max(audio::level(&data));
        if last.elapsed() >= Duration::from_millis(100) {
            on_level(peak);
            (peak, last) = (0.0, tokio::time::Instant::now());
        }
    }
    on_level(0.0);
}

/// Accept OBS (or ffplay…) connections on loopback and stream the MPEG-TS to each.
async fn serve_ts(listener: TcpListener, hub: Arc<Hub>, mut stop: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            r = listener.accept() => {
                let Ok((mut sock, _)) = r else { continue };
                let _ = sock.set_nodelay(true);
                let mut rx = hub.subscribe(false);
                let mut stop = stop.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            c = rx.recv() => match c {
                                Some(c) => if sock.write_all(&c).await.is_err() { break },
                                None => break,
                            },
                            _ = stop.changed() => break,
                        }
                    }
                });
            }
            _ = stop.changed() => break,
        }
    }
}

async fn bind(port: u16) -> Result<(TcpListener, u16), String> {
    let want = if port == 0 { DEFAULT_PORT } else { port };
    let l = match TcpListener::bind(("127.0.0.1", want)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Couldn't open a local port for OBS: {e}"))?,
    };
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    Ok((l, port))
}

// ---------- the running session ----------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub device_name: String,
    pub obs_url: String,
    pub port: u16,
    pub mic_active: bool,
    pub mic_note: Option<String>,
    pub output_device: Option<String>,
}

/// What the session tells the UI about; the app implements it with Tauri events.
pub trait Events: Send + Sync + 'static {
    fn ended(&self, reason: Option<String>);
    fn level(&self, level: f32);
}

struct Running {
    id: u64,
    stop: watch::Sender<bool>,
    /// The mic's output buffer, if the mic is being played.
    delay: Option<audio::RingHandle>,
    info: Info,
    ts: Arc<Hub>,
    preview: Arc<Hub>,
}

impl Running {
    fn shutdown(&self) {
        let _ = self.stop.send(true);
        self.ts.close();
        self.preview.close();
    }
}

#[derive(Default)]
pub struct Manager {
    slot: Mutex<Option<Running>>,
    preview_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    next_id: AtomicU64,
}

impl Manager {
    /// Retune the mic delay of the running session (lip-sync with OBS's video). False if there's nothing to retune.
    pub fn set_delay(&self, delay_ms: u32) -> bool {
        match self.slot.lock().unwrap().as_ref().and_then(|r| r.delay.as_ref()) {
            Some(h) => {
                h.set_delay(delay_ms.min(1000));
                true
            }
            None => false,
        }
    }

    pub fn status(&self) -> Option<Info> {
        self.slot.lock().unwrap().as_ref().map(|r| r.info.clone())
    }

    /// User-initiated stop: no `ended` event, the caller already knows.
    pub fn stop(&self) {
        if let Some(r) = self.slot.lock().unwrap().take() {
            r.shutdown();
        }
        self.detach_preview();
    }

    /// The phone stopped sending. True if that session was still the current one (so the UI hears of it).
    fn clear_if(&self, id: u64) -> bool {
        let mut slot = self.slot.lock().unwrap();
        if slot.as_ref().is_some_and(|r| r.id == id) {
            if let Some(r) = slot.take() {
                r.shutdown();
            }
            drop(slot);
            self.detach_preview();
            return true;
        }
        false
    }

    pub async fn start(self: &Arc<Self>, events: Arc<dyn Events>, serial: &str, mut opts: CameraOptions) -> Result<Info, String> {
        opts.validate()?;
        self.stop();
        let (listener, port) = bind(opts.port).await?;

        let mut conn = match open_session(serial, &opts, false).await {
            Ok(c) => c,
            Err(first) if worth_retrying(&first) => {
                tracing::warn!("camera start failed ({first}); retrying with minimal options");
                open_session(serial, &opts, true).await.map_err(|_| first)?
            }
            Err(first) => return Err(first),
        };

        // The mic goes to BlackHole (or the chosen device). If that can't be opened the camera still runs.
        let mut mic_note = conn.mic_note.take();
        let player = match conn.audio.is_some().then(|| audio::start(&opts.output_device, opts.audio_delay_ms)) {
            Some(Ok(p)) => Some(p),
            Some(Err(e)) => {
                mic_note = Some(e);
                None
            }
            None => None,
        };
        let info = Info {
            device_name: conn.device_name.clone(),
            obs_url: format!("tcp://127.0.0.1:{port}"),
            port,
            mic_active: player.is_some(),
            mic_note,
            output_device: player.as_ref().map(|p| p.device.clone()),
        };

        let (ts_hub, preview) = (Arc::new(Hub::default()), Arc::new(Hub::default()));
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        *self.slot.lock().unwrap() = Some(Running { id, stop: conn.stop_tx.clone(), delay: player.as_ref().map(|p| p.handle()), info: info.clone(), ts: ts_hub.clone(), preview: preview.clone() });

        tokio::spawn(serve_ts(listener, ts_hub.clone(), conn.stop_rx.clone()));
        if let Some(audio_sock) = conn.audio.take() {
            let ev = events.clone();
            tokio::spawn(run_audio(audio_sock, move |pcm| { if let Some(p) = &player { p.push(pcm) } }, move |l| ev.level(l), conn.stop_rx.clone()));
        }
        let (mgr, log, stop_tx) = (self.clone(), conn.log.clone(), conn.stop_tx.clone());
        let (video, stop_rx) = (conn.video, conn.stop_rx);
        tokio::spawn(async move {
            run_video(video, &ts_hub, &preview, stop_rx).await;
            let _keep = stop_tx; // the server runs while this is alive
            if mgr.clear_if(id) {
                let lines = log.lock().unwrap().clone();
                let reason = lines.iter().rev().any(|l| l.contains("ERROR") || l.contains("Exception")).then(|| friendly(&lines));
                events.ended(reason);
            }
        });
        Ok(info)
    }

    /// Send the preview (same messages Mirror uses) to `ch`; replaces any earlier preview.
    pub fn attach_preview(&self, ch: Channel<InvokeResponseBody>) -> Result<(), String> {
        let hub = self.slot.lock().unwrap().as_ref().map(|r| r.preview.clone()).ok_or("The camera isn't running.")?;
        let mut rx: mpsc::Receiver<hub::Chunk> = hub.subscribe(true);
        let task = tauri::async_runtime::spawn(async move {
            while let Some(c) = rx.recv().await {
                if ch.send(InvokeResponseBody::Raw((*c).clone())).is_err() {
                    break; // the page is gone
                }
            }
        });
        if let Some(old) = self.preview_task.lock().unwrap().replace(task) {
            old.abort();
        }
        Ok(())
    }

    pub fn detach_preview(&self) {
        if let Some(t) = self.preview_task.lock().unwrap().take() {
            t.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "[server] INFO: List of cameras:
    --camera-id=0    (back, 4000x3000, fps={15, 24, 30}, zoom-range=[1, 8])
        - 4000x3000
        - 1920x1080
        - 1280x720
        - 1920x1080
      High speed capture (--camera-high-speed):
        - 1280x720 (fps={120, 240})
    --camera-id=1    (front, 3264x2448, fps={30})
        - 1920x1080
        - 640x480
    --camera-id=20    (external, 1920x1080)
        (none)";

    #[test]
    fn camera_list_is_parsed() {
        let cams = parse_camera_list(LIST);
        assert_eq!(cams.len(), 3);
        assert_eq!((cams[0].id.as_str(), cams[0].facing.as_str(), cams[0].width, cams[0].height), ("0", "back", 4000, 3000));
        assert_eq!(cams[0].fps, [15, 24, 30]);
        let sizes: Vec<_> = cams[0].sizes.iter().map(|s| (s.width, s.height)).collect();
        assert_eq!(sizes, [(4000, 3000), (1920, 1080), (1280, 720)], "largest first, no duplicates, high-speed modes left out");
        assert_eq!((cams[1].id.as_str(), cams[1].facing.as_str(), cams[1].fps.clone()), ("1", "front", vec![30]));
        assert_eq!(cams[1].sizes.len(), 2);
        assert_eq!((cams[2].facing.as_str(), cams[2].sizes.len(), cams[2].fps.len()), ("external", 0, 0));
        assert!(parse_camera_list("List of cameras:\n    (none)").is_empty());
    }

    #[test]
    fn server_command_line_has_what_the_camera_and_mic_need() {
        let o = CameraOptions::default();
        let full = server_args(0xabc, &o, false);
        assert!(full.contains("com.genymobile.scrcpy.Server 4.1 scid=00000abc"), "{full}");
        for present in ["video_source=camera", "control=false", "tunnel_forward=true", "camera_facing=back", "camera_size=1920x1080", "audio_source=mic", "audio_codec=raw", "video_codec_options=i-frame-interval=1"] {
            assert!(full.contains(present), "{present} missing: {full}");
        }
        for absent in ["camera_id", "camera_fps", "video_bit_rate", "capture_orientation", "audio=false"] {
            assert!(!full.contains(absent), "{absent} should be left at the default: {full}");
        }
        let minimal = server_args(1, &o, true);
        assert!(minimal.contains("camera_size=1920x1080") && minimal.contains("audio_codec=raw"));
        for absent in ["camera_fps", "video_codec_options", "video_bit_rate"] {
            assert!(!minimal.contains(absent), "{absent} is optional tuning: {minimal}");
        }
        let custom = server_args(2, &CameraOptions { camera_id: "1".into(), rotation: 90, bit_rate_mbps: 6, fps: 24, mic: false, ..o.clone() }, false);
        assert!(custom.contains("camera_fps=24"), "a non-default rate is sent: {custom}");
        assert!(custom.contains("camera_id=1") && !custom.contains("camera_facing"), "an id wins over facing: {custom}");
        assert!(custom.contains("capture_orientation=90") && custom.contains("video_bit_rate=6000000") && custom.contains("audio=false"));
        assert!(!custom.contains("audio_source"), "no mic, no audio source: {custom}");
        assert!(server_args(3, &CameraOptions { rotation: 270, ..o }, true).contains("capture_orientation=270"), "rotation is functional, so the minimal attempt keeps it");
    }

    #[test]
    fn options_are_checked_before_they_reach_a_command_line() {
        let ok = || CameraOptions::default();
        assert!(ok().validate().is_ok());
        for bad in [
            CameraOptions { camera_id: "0 control=true".into(), ..ok() },
            CameraOptions { camera_id: "0;reboot".into(), ..ok() },
            CameraOptions { facing: "up".into(), ..ok() },
            CameraOptions { mic_source: "mic audio=false".into(), ..ok() },
            CameraOptions { rotation: 45, ..ok() },
            CameraOptions { width: 1920, height: 0, ..ok() },
            CameraOptions { width: 99_999, height: 1080, ..ok() },
            CameraOptions { port: 80, ..ok() },
        ] {
            assert!(bad.clone().validate().is_err(), "{bad:?}");
        }
        let mut o = CameraOptions { audio_delay_ms: 99_999, camera_id: "front_1.2:3".into(), ..ok() };
        o.validate().unwrap();
        assert_eq!(o.audio_delay_ms, 1000, "delay is clamped");
    }

    #[test]
    fn options_arrive_from_the_ui_in_camel_case_with_defaults_for_missing_fields() {
        let o: CameraOptions = serde_json::from_str(r#"{"cameraId":"1","facing":"front","width":1280,"height":720,"fps":24,"micSource":"mic-voice-communication","audioDelayMs":250}"#).unwrap();
        assert_eq!((o.camera_id.as_str(), o.width, o.fps, o.audio_delay_ms), ("1", 1280, 24, 250));
        assert!(o.mic && o.output_device.is_empty() && o.port == 0, "unspecified → defaults");
    }

    #[test]
    fn failures_get_readable_messages() {
        let l = |s: &str| vec![s.to_string()];
        assert!(friendly(&l("ERROR: Camera mirroring is not supported")).contains("Android 12"));
        assert!(friendly(&l("android.hardware.camera2.CameraAccessException: CAMERA_IN_USE (4)")).contains("Another app"));
        assert!(friendly(&l("android.hardware.camera2.CameraAccessException: CAMERA_DISABLED (1)")).contains("blocked"));
        assert!(friendly(&l("adb: device offline")).contains("isn't reachable"));
        assert_eq!(friendly(&[]), "The camera stream stopped unexpectedly.");
        assert!(friendly(&l("Aborted")).contains("(Aborted)"), "keeps the server's last words when nothing more specific is known");
        assert!(friendly(&l("ERROR: something odd")).contains("something odd"));
        assert!(!worth_retrying("The phone isn't reachable.") && !worth_retrying(&friendly(&l("CAMERA_IN_USE"))));
        assert!(worth_retrying("The camera stream stopped unexpectedly.") && worth_retrying("Video decoder oops"));
    }

    #[tokio::test]
    async fn handshakes_are_read_in_wire_order() {
        let mut bytes = vec![0u8];
        let mut name = b"Galaxy A07".to_vec();
        name.resize(64, 0);
        bytes.extend(name);
        bytes.extend(b"h264");
        let (name, codec) = read_video_handshake(&mut &bytes[..]).await.unwrap();
        assert_eq!((name.as_str(), &codec), ("Galaxy A07", b"h264"));
        assert_eq!(read_audio_codec(&mut &0x0072_6177u32.to_be_bytes()[..]).await.unwrap(), CODEC_RAW_AUDIO);
        assert_eq!(read_audio_codec(&mut &0u32.to_be_bytes()[..]).await.unwrap(), 0);
        assert!(read_video_handshake(&mut &bytes[..10]).await.is_err(), "a short read is an error, not a hang");
    }

    fn video_packet(config: bool, key: bool, pts: u64, payload: &[u8]) -> Vec<u8> {
        let first = (u64::from(config) << 62) | (u64::from(key) << 61) | pts;
        let mut v = first.to_be_bytes().to_vec();
        v.extend((payload.len() as u32).to_be_bytes());
        v.extend(payload);
        v
    }

    #[tokio::test]
    async fn video_is_fanned_out_as_mpeg_ts_and_as_preview_messages() {
        let mut stream = vec![0x80, 0, 0, 0];
        stream.extend(1920u32.to_be_bytes());
        stream.extend(1080u32.to_be_bytes()); // session packet
        stream.extend(video_packet(true, false, 0, &[0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 4]));
        stream.extend(video_packet(false, true, 1000, &[0, 0, 0, 1, 0x65, 9, 9]));
        stream.extend(video_packet(false, false, 34_000, &[0, 0, 0, 1, 0x41, 8]));
        let (ts_hub, preview) = (Hub::default(), Hub::default());
        let (_tx, rx) = watch::channel(false);
        run_video(&stream[..], &ts_hub, &preview, rx).await;

        let mut pv = preview.subscribe(true);
        let mut kinds = vec![];
        while let Ok(c) = pv.try_recv() {
            kinds.push(c[0]);
        }
        assert_eq!(kinds, [0, 1, 2, 3], "session, config, key frame, delta — what H264Player expects");

        let mut ts_rx = ts_hub.subscribe(true);
        let key = ts_rx.try_recv().unwrap();
        assert!(key.len() % ts::PACKET == 0 && key.chunks(ts::PACKET).all(|p| p[0] == 0x47), "whole TS packets");
        assert!(key.len() / ts::PACKET >= 3, "PAT + PMT + the key frame");
        assert_eq!((key[1] & 0x1f, key[2]), (0, 0), "the stream starts with the PAT (pid 0)");
        assert!(key.windows(14).any(|w| w == [0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 4]), "SPS/PPS are put in front of the key frame");
        let delta = ts_rx.try_recv().unwrap();
        assert!(delta.len() % ts::PACKET == 0 && delta[0] == 0x47 && delta[1] & 0x1f == 1, "a delta frame has no tables, just video (pid 0x100)");
        assert!(ts_rx.try_recv().is_err());
        assert!(ts_hub.subscribe(false).try_recv().is_err(), "OBS doesn't get a replay: it waits for the next key frame");
    }

    #[tokio::test]
    async fn microphone_packets_go_to_the_sink_with_a_level() {
        let loud: Vec<u8> = (0..1024).flat_map(|_| 20_000i16.to_le_bytes().into_iter().chain(20_000i16.to_le_bytes())).collect();
        let mut stream = vec![];
        for i in 0..3u64 {
            stream.extend(video_packet(false, false, i * 21_333, &loud)); // same 12-byte framing on the audio socket
        }
        let (_tx, rx) = watch::channel(false);
        let (mut bytes, mut levels) = (0usize, vec![]);
        run_audio(&stream[..], |pcm| bytes += pcm.len(), |l| levels.push(l), rx).await;
        assert_eq!(bytes, 3 * loud.len());
        assert_eq!(levels.last(), Some(&0.0), "the meter drops to zero when the stream ends");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn obs_can_connect_and_receive_the_stream() {
        let hub = Arc::new(Hub::default());
        hub.publish_sticky(0, b"TABLES".to_vec());
        let (listener, port) = bind(0).await.unwrap();
        let (tx, rx) = watch::channel(false);
        tokio::spawn(serve_ts(listener, hub.clone(), rx));
        let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut got = vec![0u8; 6];
        c.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"TABLES");
        hub.publish_frame(false, b"skipped".to_vec());
        hub.publish_frame(true, b"KEY".to_vec());
        let mut got = vec![0u8; 3];
        tokio::time::timeout(Duration::from_secs(2), c.read_exact(&mut got)).await.unwrap().unwrap();
        assert_eq!(&got, b"KEY", "joined mid-GOP → starts at the key frame");
        tx.send(true).unwrap();
        hub.close();
    }

    // ---- end to end against the scripted fake phone (adb/fake.rs) ----

    use crate::adb::fake::{self, ScrcpySocket};

    #[derive(Default)]
    struct TestEvents {
        ended: Mutex<Vec<Option<String>>>,
        levels: Mutex<Vec<f32>>,
    }
    impl Events for TestEvents {
        fn ended(&self, reason: Option<String>) {
            self.ended.lock().unwrap().push(reason);
        }
        fn level(&self, level: f32) {
            self.levels.lock().unwrap().push(level);
        }
    }

    /// What the phone sends first on the video socket: dummy byte, name, codec, session, SPS/PPS.
    fn video_intro() -> Vec<u8> {
        let mut v = vec![0u8];
        let mut name = b"Fake Phone".to_vec();
        name.resize(64, 0);
        v.extend(name);
        v.extend(b"h264");
        v.extend([0x80, 0, 0, 0]);
        v.extend(1920u32.to_be_bytes());
        v.extend(1080u32.to_be_bytes());
        v.extend(video_packet(true, false, 0, &[0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 4]));
        v
    }
    fn live_video() -> ScrcpySocket {
        let mut chunks = vec![(0, video_intro())];
        for i in 0..40u64 {
            chunks.push((100, video_packet(false, true, i * 100_000, &[0, 0, 0, 1, 0x65, 9, 9, 9]))); // a key frame every 100 ms
        }
        ScrcpySocket { chunks, hold_open: true }
    }
    fn loud_audio() -> ScrcpySocket {
        let pcm: Vec<u8> = (0..1024).flat_map(|_| 20_000i16.to_le_bytes().into_iter().chain(20_000i16.to_le_bytes())).collect();
        let mut chunks = vec![(0, CODEC_RAW_AUDIO.to_be_bytes().to_vec())];
        for i in 0..40u64 {
            chunks.push((30, video_packet(false, false, i * 21_333, &pcm)));
        }
        ScrcpySocket { chunks, hold_open: true }
    }
    async fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
        for _ in 0..60 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_against_a_scripted_phone_serves_obs_and_keeps_going_without_the_mic_device() {
        let _g = fake::LOCK.lock().await;
        let f = fake::start().await;
        *f.scrcpy_script.lock().unwrap() = vec![live_video(), loud_audio()];
        let (events, mgr) = (Arc::new(TestEvents::default()), Arc::new(Manager::default()));
        let opts = CameraOptions { output_device: "No Such Device".into(), ..Default::default() };
        let info = mgr.start(events.clone(), fake::SERIAL, opts).await.expect("start");

        assert_eq!(info.device_name, "Fake Phone");
        assert!(info.obs_url.starts_with("tcp://127.0.0.1:"), "{}", info.obs_url);
        assert!(!info.mic_active && info.mic_note.as_deref().unwrap_or("").contains("isn't available"), "no output device → no mic, but a reason: {:?}", info.mic_note);
        assert_eq!(mgr.status().map(|i| i.port), Some(info.port));
        assert!(!mgr.set_delay(100), "no mic is playing, so there's no delay to retune");
        assert_eq!(f.scrcpy_sockets.load(std::sync::atomic::Ordering::SeqCst), 2, "video then audio, and no control socket");
        let cmd = f.scrcpy_cmds.lock().unwrap()[0].clone();
        for want in ["video_source=camera", "camera_size=1920x1080", "audio_source=mic", "audio_codec=raw", "control=false"] {
            assert!(cmd.contains(want), "{want} missing from {cmd}");
        }

        // An OBS-style client: whole TS packets, starting with the PAT, then video.
        let mut c = TcpStream::connect(("127.0.0.1", info.port)).await.unwrap();
        let mut got = vec![0u8; 6 * ts::PACKET];
        tokio::time::timeout(Duration::from_secs(5), c.read_exact(&mut got)).await.expect("OBS gets data").unwrap();
        assert!(got.chunks(ts::PACKET).all(|p| p[0] == 0x47), "TS sync bytes");
        assert_eq!((got[1] & 0x1f, got[2]), (0, 0), "starts with the PAT");

        wait_for("the mic level", || events.levels.lock().unwrap().iter().any(|l| *l > 0.5)).await;
        mgr.stop();
        assert!(mgr.status().is_none());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(events.ended.lock().unwrap().is_empty(), "a stop you asked for isn't reported as the phone ending");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unplugging_the_phone_ends_the_session_and_tells_the_ui_once() {
        let _g = fake::LOCK.lock().await;
        let f = fake::start().await;
        let mut hangs_up = live_video();
        hangs_up.chunks.truncate(3);
        hangs_up.hold_open = false; // the cable is pulled after a few frames
        *f.scrcpy_script.lock().unwrap() = vec![hangs_up];
        let (events, mgr) = (Arc::new(TestEvents::default()), Arc::new(Manager::default()));
        let info = mgr.start(events.clone(), fake::SERIAL, CameraOptions { mic: false, ..Default::default() }).await.expect("start");
        assert!(!info.mic_active && info.mic_note.is_none(), "no mic asked for → nothing to explain");
        let cmd = f.scrcpy_cmds.lock().unwrap()[0].clone();
        assert!(cmd.contains("audio=false") && !cmd.contains("audio_source"), "{cmd}");

        wait_for("the end of the session", || !events.ended.lock().unwrap().is_empty()).await;
        assert_eq!(events.ended.lock().unwrap().len(), 1);
        assert!(mgr.status().is_none(), "the slot is cleared");
        let mut late = TcpStream::connect(("127.0.0.1", info.port)).await;
        if let Ok(c) = late.as_mut() {
            let mut b = [0u8; 1];
            assert!(matches!(tokio::time::timeout(Duration::from_secs(1), c.read(&mut b)).await, Ok(Ok(0)) | Ok(Err(_)) | Err(_)), "nothing more is streamed");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_phone_that_cannot_capture_audio_still_streams_video() {
        let _g = fake::LOCK.lock().await;
        let f = fake::start().await;
        let no_audio = ScrcpySocket { chunks: vec![(0, 0u32.to_be_bytes().to_vec())], hold_open: true }; // codec id 0 = audio disabled
        *f.scrcpy_script.lock().unwrap() = vec![live_video(), no_audio];
        let (events, mgr) = (Arc::new(TestEvents::default()), Arc::new(Manager::default()));
        let info = mgr.start(events, fake::SERIAL, CameraOptions::default()).await.expect("video is enough to start");
        assert!(!info.mic_active);
        assert!(info.mic_note.as_deref().unwrap_or("").contains("couldn't capture its microphone"), "{:?}", info.mic_note);
        mgr.stop();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_start_is_retried_once_with_minimal_options() {
        let _g = fake::LOCK.lock().await;
        let f = fake::start().await;
        let dies = ScrcpySocket { chunks: vec![], hold_open: false }; // the server hangs up before the handshake (an encoder crash)
        *f.scrcpy_script.lock().unwrap() = vec![dies, live_video()];
        let (events, mgr) = (Arc::new(TestEvents::default()), Arc::new(Manager::default()));
        let opts = CameraOptions { mic: false, bit_rate_mbps: 6, fps: 24, ..Default::default() };
        let info = mgr.start(events, fake::SERIAL, opts).await.expect("the second attempt works");
        assert_eq!(info.device_name, "Fake Phone");
        let cmds = f.scrcpy_cmds.lock().unwrap().clone();
        assert_eq!(cmds.len(), 2, "{cmds:?}");
        assert!(cmds[0].contains("camera_fps=24") && cmds[0].contains("video_bit_rate=6000000") && cmds[0].contains("video_codec_options"), "{}", cmds[0]);
        assert!(!cmds[1].contains("camera_fps") && !cmds[1].contains("video_bit_rate") && !cmds[1].contains("video_codec_options") && cmds[1].contains("camera_size=1920x1080"), "{}", cmds[1]);
        mgr.stop();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_phones_cameras_are_listed_through_the_server() {
        let _g = fake::LOCK.lock().await;
        let f = fake::start().await;
        *f.camera_list.lock().unwrap() = LIST.to_string();
        let cams = list_cameras(fake::SERIAL).await.unwrap();
        assert_eq!(cams.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["0", "1", "20"]);
        *f.camera_list.lock().unwrap() = "[server] INFO: List of cameras:\n    (access denied)".into();
        assert!(list_cameras(fake::SERIAL).await.unwrap_err().contains("blocked access to its camera"));
    }

    /// Real phone: serves the camera on the OBS port (and plays the mic) for `CAM_HOLD_SECS` (default 30) so ffmpeg,
    /// ffplay or OBS can be pointed at `tcp://127.0.0.1:<port>`. Prints the mic level every second: make some noise.
    /// `cargo test live_webcam_serve -- --ignored --nocapture --test-threads=1`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_webcam_serve() {
        struct Print(Mutex<f32>);
        impl Events for Print {
            fn ended(&self, reason: Option<String>) {
                println!("session ended: {reason:?}");
            }
            fn level(&self, level: f32) {
                let mut p = self.0.lock().unwrap();
                *p = p.max(level);
            }
        }
        let _ = tracing_subscriber::fmt().with_max_level(tracing::Level::DEBUG).try_init();
        let serial = adb::list_devices().await.unwrap().into_iter().find(|d| d.state == adb::AdbState::Ready).expect("device").serial;
        let mut opts = CameraOptions::default();
        if let Ok(f) = std::env::var("CAM_FACING") { opts.facing = f; }
        if let Ok(s) = std::env::var("CAM_SIZE") { if let Some((w, h)) = parse_size(&s) { opts.width = w; opts.height = h; } }
        opts.output_device = std::env::var("CAM_OUT").unwrap_or_default();
        opts.audio_delay_ms = std::env::var("CAM_DELAY").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let secs: u64 = std::env::var("CAM_HOLD_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
        let (ev, mgr) = (Arc::new(Print(Mutex::new(0.0))), Arc::new(Manager::default()));
        let info = mgr.start(ev.clone(), &serial, opts).await.expect("start");
        println!("READY {} mic_active={} mic_note={:?} output={:?}", info.obs_url, info.mic_active, info.mic_note, info.output_device);
        for t in 1..=secs {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let peak = std::mem::take(&mut *ev.0.lock().unwrap());
            println!("t={t:>2}s mic level {:<20} {peak:.2}", "#".repeat((peak * 20.0) as usize));
        }
        mgr.stop();
    }

    /// Real phone (Android 12+): `cargo test live_webcam -- --ignored --nocapture --test-threads=1`
    /// Lists the cameras, streams for a few seconds, and checks that OBS-style TS and mic audio arrive.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_webcam_session() {
        let _ = tracing_subscriber::fmt().with_max_level(tracing::Level::DEBUG).try_init();
        let serial = adb::list_devices().await.unwrap().into_iter().find(|d| d.state == adb::AdbState::Ready).expect("device").serial;
        let cams = list_cameras(&serial).await.expect("camera list");
        for c in &cams {
            println!("camera {} {} {}x{} fps={:?} sizes={}", c.id, c.facing, c.width, c.height, c.fps, c.sizes.len());
        }
        let mut opts = CameraOptions::default();
        if let Ok(f) = std::env::var("CAM_FACING") { opts.facing = f; }
        if let Ok(s) = std::env::var("CAM_SIZE") { if let Some((w, h)) = parse_size(&s) { opts.width = w; opts.height = h; } }
        opts.mic = std::env::var("CAM_MIC").map(|v| v != "0").unwrap_or(true);
        opts.output_device = std::env::var("CAM_OUT").unwrap_or_default();
        opts.validate().unwrap();

        let t0 = std::time::Instant::now();
        let conn = open_session(&serial, &opts, false).await.expect("open session");
        println!("connected in {:?} to {:?}; mic note: {:?}", t0.elapsed(), conn.device_name, conn.mic_note);
        let (ts_hub, preview) = (Arc::new(Hub::default()), Arc::new(Hub::default()));
        let (stop_tx, stop_rx) = (conn.stop_tx.clone(), conn.stop_rx.clone());
        let video = conn.video;
        let (th, ph) = (ts_hub.clone(), preview.clone());
        tokio::spawn(async move { run_video(video, &th, &ph, stop_rx).await });
        let audio_bytes = Arc::new(AtomicU64::new(0));
        if let Some(a) = conn.audio {
            let (n, rx) = (audio_bytes.clone(), conn.stop_rx.clone());
            tokio::spawn(async move { run_audio(a, move |p| { n.fetch_add(p.len() as u64, Ordering::Relaxed); }, |_| {}, rx).await });
        }
        tokio::time::sleep(Duration::from_secs(4)).await;
        let mut rx = preview.subscribe(true);
        let (mut frames, mut keys, mut size) = (0, 0, None);
        while let Ok(c) = rx.try_recv() {
            match c[0] { 0 => size = Some((u32::from_be_bytes(c[9..13].try_into().unwrap()), u32::from_be_bytes(c[13..17].try_into().unwrap()))), 2 => { frames += 1; keys += 1 } 3 => frames += 1, _ => {} }
        }
        println!("preview GOP: {frames} frames ({keys} key), picture {size:?}; mic bytes {}", audio_bytes.load(Ordering::Relaxed));
        assert!(size.is_some() && keys >= 1, "the phone sent a picture");
        if opts.mic && conn.mic_note.is_none() {
            assert!(audio_bytes.load(Ordering::Relaxed) > 48_000 * 4, "about a second of audio in four");
        }
        let _ = stop_tx.send(true);
    }
}
