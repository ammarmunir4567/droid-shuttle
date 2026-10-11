//! Menu-bar mode: a status item that shows the phone and transfer progress, quick actions, Dock progress,
//! a notification when a transfer finishes in the background, and "close the window, keep running".
//!
//! What the menu says is decided by pure functions (`menu_model`, `title`, `finished_message`) so it is unit
//! tested without a display; the rest is thin glue to Tauri.

use crate::{
    adb::{AdbDevice, AdbState},
    device,
    transfer::{Manager, Summary},
};
use serde::Deserialize;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    window::{ProgressBarState, ProgressBarStatus},
    AppHandle, Emitter, Listener, Manager as _, UserAttentionType,
};
use tauri_plugin_notification::{NotificationExt, PermissionState};

const ICON: &[u8] = include_bytes!("../icons/tray.png");
const ICON_IDLE: &[u8] = include_bytes!("../icons/tray-idle.png");
const TRAY_ID: &str = "main";

// ---------- what the menu says (pure) ----------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PhoneBrief {
    pub serial: String,
    pub name: String,
    pub battery: Option<u8>,
    pub charging: bool,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct TrayState {
    pub phone: Option<PhoneBrief>,
    pub transfers: Summary,
    /// Name of the phone while its camera is being shared as a webcam.
    pub webcam: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// Greyed-out status line.
    Info(String),
    Sep,
    Action { id: &'static str, label: String, enabled: bool },
}

pub fn fmt_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1000.0 && i < UNITS.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if i == 0 { format!("{n} B") } else { format!("{v:.1} {}", UNITS[i]) }
}

fn phone_line(p: &PhoneBrief) -> Option<String> {
    let mut parts = vec![];
    if let Some(b) = p.battery {
        parts.push(if p.charging { format!("{b}% charging") } else { format!("{b}%") });
    }
    if p.free_bytes > 0 {
        parts.push(format!("{} free", fmt_bytes(p.free_bytes)));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn transfer_line(t: &Summary) -> Option<String> {
    if t.active == 0 {
        return None;
    }
    if t.waiting == t.active {
        return Some("Waiting for your phone to reconnect…".into());
    }
    let what = if t.active == 1 { "1 transfer".to_string() } else { format!("{} transfers", t.active) };
    Some(match t.percent() {
        Some(p) => format!("{what} · {p}%"),
        None => format!("{what} · preparing"),
    })
}

/// Short text shown next to the icon while something is moving.
pub fn title(st: &TrayState) -> Option<String> {
    let t = &st.transfers;
    if t.active == 0 {
        st.webcam.is_some().then(|| "● Cam".to_string())
    } else if t.waiting == t.active {
        Some("Waiting".into())
    } else {
        Some(t.percent().map_or("…".to_string(), |p| format!("{p}%")))
    }
}

pub fn tooltip(st: &TrayState) -> String {
    match &st.phone {
        Some(p) => format!("Droid Shuttle · {}", p.name),
        None => "Droid Shuttle · no phone connected".into(),
    }
}

/// Screens reachable from the menu (id, label).
pub const GO_TO: [(&str, &str); 5] = [("files", "Files"), ("gallery", "Gallery"), ("storage", "Storage"), ("mirror", "Mirror"), ("webcam", "Webcam")];

pub fn menu_model(st: &TrayState) -> Vec<Entry> {
    let has_phone = st.phone.is_some();
    let mut m = vec![];
    match &st.phone {
        Some(p) => {
            m.push(Entry::Info(p.name.clone()));
            if let Some(l) = phone_line(p) {
                m.push(Entry::Info(l));
            }
        }
        None => {
            m.push(Entry::Info("No phone connected".into()));
            m.push(Entry::Info("Plug it in with a USB cable".into()));
        }
    }
    if let Some(l) = transfer_line(&st.transfers) {
        m.push(Entry::Info(l));
    }
    if let Some(name) = &st.webcam {
        m.push(Entry::Info(format!("Camera live · {name}")));
    }
    m.push(Entry::Sep);
    m.push(Entry::Action { id: "open", label: "Open Droid Shuttle".into(), enabled: true });
    m.push(Entry::Sep);
    for (id, label) in GO_TO {
        m.push(Entry::Action { id: Box::leak(format!("go:{id}").into_boxed_str()), label: label.into(), enabled: has_phone });
    }
    m.push(Entry::Sep);
    if st.webcam.is_some() {
        m.push(Entry::Action { id: "webcam-stop", label: "Stop Phone Camera".into(), enabled: true });
    }
    m.push(Entry::Action { id: "screenshot", label: "Take Phone Screenshot".into(), enabled: has_phone });
    m.push(Entry::Sep);
    m.push(Entry::Action { id: "quit", label: "Quit Droid Shuttle".into(), enabled: true });
    m
}

/// The slice of a `transfer-update` event needed to decide on a notification.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub id: u64,
    pub label: String,
    pub direction: String,
    pub status: String,
    #[serde(default)]
    pub silent: bool,
    pub finished_ms: Option<u64>,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub files_done: u64,
    #[serde(default)]
    pub bytes_total: u64,
}

/// (title, body) for a finished, visible, non-cancelled transfer; `None` when there is nothing to announce.
pub fn finished_message(f: &Finished) -> Option<(String, String)> {
    if f.silent || f.finished_ms.is_none() || f.status == "canceled" {
        return None;
    }
    if !f.errors.is_empty() {
        let n = f.errors.len();
        return Some(("Transfer finished with problems".into(), format!("“{}”: {n} error{}. Open Droid Shuttle for details.", f.label, if n == 1 { "" } else { "s" })));
    }
    let size = if f.bytes_total > 0 { format!(" · {}", fmt_bytes(f.bytes_total)) } else { String::new() };
    let verb = match f.direction.as_str() {
        "pull" => "Saved to your Mac",
        "push" => "Copied to your phone",
        _ => "Finished",
    };
    let files = if f.files_done == 1 { "1 file".to_string() } else { format!("{} files", f.files_done) };
    Some((format!("{verb}: {}", f.label), format!("{files}{size}")))
}

// ---------- glue ----------

#[derive(Default)]
pub struct MenuBar {
    phone: Mutex<Option<PhoneBrief>>,
    notified: Mutex<HashSet<u64>>,
    had_phone: Mutex<Option<bool>>,
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main_is_frontmost(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

/// Closing the main window hides it instead: transfers keep running and the menu-bar item stays.
/// ⌘Q or "Quit Droid Shuttle" in the menu really quits.
pub fn on_window_event<R: tauri::Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// Re-draw the menu, title and Dock progress from the current phone + transfer state.
pub fn refresh(app: &AppHandle) {
    let mb = app.state::<Arc<MenuBar>>();
    let webcam = app.state::<Arc<crate::webcam::Manager>>().status().map(|i| i.device_name);
    let st = TrayState { phone: mb.phone.lock().unwrap().clone(), transfers: app.state::<Arc<Manager>>().summary(), webcam };

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app, &menu_model(&st)) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_title(title(&st));
        let _ = tray.set_tooltip(Some(tooltip(&st)));
        let has = st.phone.is_some();
        let mut had = mb.had_phone.lock().unwrap();
        if *had != Some(has) {
            *had = Some(has);
            if let Ok(img) = Image::from_bytes(if has { ICON } else { ICON_IDLE }) {
                let _ = tray.set_icon(Some(img));
                let _ = tray.set_icon_as_template(true);
            }
        }
    }

    if let Some(w) = app.get_webview_window("main") {
        let t = st.transfers;
        let state = if t.active == 0 {
            ProgressBarState { status: Some(ProgressBarStatus::None), progress: None }
        } else if t.waiting == t.active {
            ProgressBarState { status: Some(ProgressBarStatus::Paused), progress: t.percent().map(u64::from) }
        } else {
            ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: t.percent().map(u64::from) }
        };
        let _ = w.set_progress_bar(state);
    }
}

fn build_menu(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for e in entries {
        match e {
            Entry::Info(t) => menu.append(&MenuItem::new(app, t, false, None::<&str>)?)?,
            Entry::Sep => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Action { id, label, enabled } => menu.append(&MenuItem::with_id(app, *id, label, *enabled, None::<&str>)?)?,
        }
    }
    Ok(menu)
}

/// Show a notification, asking for permission the first time. Returns false when it could not be shown.
fn notify(app: &AppHandle, title: &str, body: &str) -> bool {
    let n = app.notification();
    let granted = match n.permission_state() {
        Ok(PermissionState::Granted) => true,
        Ok(PermissionState::Denied) => false,
        _ => matches!(n.request_permission(), Ok(PermissionState::Granted)),
    };
    granted && n.builder().title(title).body(body).show().is_ok()
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main(app),
        "quit" => app.exit(0),
        "webcam-stop" => {
            app.state::<Arc<crate::webcam::Manager>>().stop();
            let _ = app.emit("webcam-ended", None::<String>); // lets the Webcam screen reset itself
            refresh(app);
        }
        "screenshot" => {
            let Some(serial) = app.state::<Arc<MenuBar>>().phone.lock().unwrap().as_ref().map(|p| p.serial.clone()) else { return };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let dir = format!("{}/Pictures/Droid Shuttle Screenshots", crate::fs::local_home());
                match crate::mirror::screenshot(&serial).await {
                    Ok(png) => {
                        let path = std::path::Path::new(&dir).join(crate::mirror::timestamped("Screenshot", "png"));
                        let saved = tokio::fs::create_dir_all(&dir).await.is_ok() && tokio::fs::write(&path, png).await.is_ok();
                        if saved && !notify(&app, "Screenshot saved", &format!("Pictures ▸ Droid Shuttle Screenshots ▸ {}", path.file_name().unwrap_or_default().to_string_lossy())) {
                            let _ = std::process::Command::new("open").arg("-R").arg(&path).status(); // no notification permission: show it in Finder instead
                        }
                    }
                    Err(e) => {
                        notify(&app, "Couldn't take a screenshot", &e);
                    }
                }
            });
        }
        other => {
            if let Some(section) = other.strip_prefix("go:") {
                show_main(app);
                let _ = app.emit("tray-navigate", section);
            }
        }
    }
}

/// Called by the device tracker on every plug / unplug.
pub fn on_devices(app: &AppHandle, list: &[AdbDevice]) {
    let ready = list.iter().find(|d| d.state == AdbState::Ready).map(|d| d.serial.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let brief = match ready {
            Some(serial) => load_brief(&serial).await,
            None => None,
        };
        *app.state::<Arc<MenuBar>>().phone.lock().unwrap() = brief;
        refresh(&app);
    });
}

async fn load_brief(serial: &str) -> Option<PhoneBrief> {
    let info = device::fetch_info(serial).await.ok()?;
    let name = if info.model.is_empty() { serial.to_string() } else { info.model.clone() };
    Some(PhoneBrief { serial: serial.to_string(), name, battery: info.battery_level, charging: info.battery_charging, free_bytes: info.storage_total.saturating_sub(info.storage_used) })
}

fn on_transfer(app: &AppHandle, payload: &str) {
    refresh(app);
    let Ok(f) = serde_json::from_str::<Finished>(payload) else { return };
    let Some((title, body)) = finished_message(&f) else { return };
    if !app.state::<Arc<MenuBar>>().notified.lock().unwrap().insert(f.id) || main_is_frontmost(app) {
        return; // already announced, or you're looking at the app anyway
    }
    notify(app, &title, &body);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(UserAttentionType::Informational)); // bounce the Dock icon once
    }
}

/// Create the status item and start listening for phone / transfer changes.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let st = TrayState::default();
    let menu = build_menu(app, &menu_model(&st))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON_IDLE)?)
        .icon_as_template(true)
        .tooltip(tooltip(&st))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        .build(app)?;

    let a = app.clone();
    app.listen("transfer-update", move |ev| on_transfer(&a, ev.payload()));

    // Battery and free space drift: refresh them once a minute while a phone is attached.
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let serial = a.state::<Arc<MenuBar>>().phone.lock().unwrap().as_ref().map(|p| p.serial.clone());
            if let Some(serial) = serial {
                if let Some(b) = load_brief(&serial).await {
                    *a.state::<Arc<MenuBar>>().phone.lock().unwrap() = Some(b);
                    refresh(&a);
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone() -> PhoneBrief {
        PhoneBrief { serial: "R8".into(), name: "SM-A075F".into(), battery: Some(87), charging: true, free_bytes: 41_200_000_000 }
    }
    fn labels(m: &[Entry]) -> Vec<String> {
        m.iter().map(|e| match e { Entry::Info(t) => format!("· {t}"), Entry::Sep => "---".into(), Entry::Action { label, enabled, .. } => format!("{}{label}", if *enabled { "" } else { "(off) " }) }).collect()
    }

    #[test]
    fn menu_without_a_phone_says_how_to_connect_and_disables_phone_actions() {
        let m = labels(&menu_model(&TrayState::default()));
        assert_eq!(m, ["· No phone connected", "· Plug it in with a USB cable", "---", "Open Droid Shuttle", "---", "(off) Files", "(off) Gallery", "(off) Storage", "(off) Mirror", "(off) Webcam", "---", "(off) Take Phone Screenshot", "---", "Quit Droid Shuttle"]);
    }

    #[test]
    fn menu_with_a_phone_shows_battery_and_free_space_and_enables_actions() {
        let m = labels(&menu_model(&TrayState { phone: Some(phone()), ..Default::default() }));
        assert_eq!(&m[..3], ["· SM-A075F", "· 87% charging · 41.2 GB free", "---"]);
        assert!(m.contains(&"Files".to_string()) && m.contains(&"Take Phone Screenshot".to_string()));
        assert!(!m.iter().any(|l| l.starts_with("(off)")));
        // Partial info degrades gracefully.
        let bare = PhoneBrief { battery: None, free_bytes: 0, ..phone() };
        assert_eq!(labels(&menu_model(&TrayState { phone: Some(bare), ..Default::default() }))[..2], ["· SM-A075F", "---"]);
        let low = PhoneBrief { charging: false, free_bytes: 0, ..phone() };
        assert_eq!(labels(&menu_model(&TrayState { phone: Some(low), ..Default::default() }))[1], "· 87%");
    }

    #[test]
    fn transfer_progress_appears_in_the_menu_and_next_to_the_icon() {
        let mut st = TrayState { phone: Some(phone()), ..Default::default() };
        assert_eq!(title(&st), None);
        st.transfers = Summary { active: 2, waiting: 0, bytes_total: 1000, bytes_done: 420 };
        assert_eq!(title(&st).as_deref(), Some("42%"));
        assert!(labels(&menu_model(&st)).contains(&"· 2 transfers · 42%".to_string()));
        st.transfers = Summary { active: 1, waiting: 0, bytes_total: 0, bytes_done: 0 };
        assert_eq!(title(&st).as_deref(), Some("…"));
        assert!(labels(&menu_model(&st)).contains(&"· 1 transfer · preparing".to_string()));
        st.transfers = Summary { active: 2, waiting: 2, bytes_total: 1000, bytes_done: 420 };
        assert_eq!(title(&st).as_deref(), Some("Waiting"));
        assert!(labels(&menu_model(&st)).contains(&"· Waiting for your phone to reconnect…".to_string()));
    }

    #[test]
    fn a_live_camera_shows_in_the_menu_and_next_to_the_icon_and_can_be_stopped_from_there() {
        let mut st = TrayState { phone: Some(phone()), ..Default::default() };
        assert!(!labels(&menu_model(&st)).iter().any(|l| l.contains("Camera") || l.contains("Stop")));
        st.webcam = Some("SM-A075F".into());
        assert_eq!(title(&st).as_deref(), Some("● Cam"));
        let m = labels(&menu_model(&st));
        assert!(m.contains(&"· Camera live · SM-A075F".to_string()) && m.contains(&"Stop Phone Camera".to_string()), "{m:?}");
        st.transfers = Summary { active: 1, waiting: 0, bytes_total: 1000, bytes_done: 500 };
        assert_eq!(title(&st).as_deref(), Some("50%"), "a running transfer's progress takes the title");
    }

    #[test]
    fn menu_ids_are_stable() {
        let ids: Vec<&str> = menu_model(&TrayState::default()).iter().filter_map(|e| if let Entry::Action { id, .. } = e { Some(*id) } else { None }).collect();
        assert_eq!(ids, ["open", "go:files", "go:gallery", "go:storage", "go:mirror", "go:webcam", "screenshot", "quit"]);
    }

    #[test]
    fn formats_sizes_like_the_app_does() {
        assert_eq!([fmt_bytes(0), fmt_bytes(999), fmt_bytes(1_500), fmt_bytes(412_000_000), fmt_bytes(41_200_000_000)], ["0 B", "999 B", "1.5 KB", "412.0 MB", "41.2 GB"]);
    }

    fn done(over: impl FnOnce(&mut Finished)) -> Finished {
        let mut f = Finished { id: 1, label: "Holiday.mp4".into(), direction: "pull".into(), status: "done".into(), silent: false, finished_ms: Some(5), errors: vec![], files_done: 1, bytes_total: 412_000_000 };
        over(&mut f);
        f
    }

    #[test]
    fn notifications_say_what_happened_and_skip_noise() {
        assert_eq!(finished_message(&done(|_| {})), Some(("Saved to your Mac: Holiday.mp4".into(), "1 file · 412.0 MB".into())));
        let up = finished_message(&done(|f| { f.direction = "push".into(); f.files_done = 3; f.label = "Trip".into() })).unwrap();
        assert_eq!(up, ("Copied to your phone: Trip".into(), "3 files · 412.0 MB".into()));
        let bad = finished_message(&done(|f| f.errors = vec!["x".into(), "y".into()])).unwrap();
        assert_eq!(bad.0, "Transfer finished with problems");
        assert!(bad.1.contains("2 errors"));
        assert_eq!(finished_message(&done(|f| f.silent = true)), None, "internal jobs stay quiet");
        assert_eq!(finished_message(&done(|f| f.status = "canceled".into())), None, "you canceled it, you know");
        assert_eq!(finished_message(&done(|f| f.finished_ms = None)), None, "still running");
    }

    #[test]
    fn understands_what_the_transfer_engine_really_emits() {
        // Serialize a real Snapshot, so this breaks if either struct changes shape.
        use crate::transfer::{Direction, Snapshot, Status};
        let snap = Snapshot {
            id: 7, label: "Photos".into(), direction: Direction::Pull, status: Status::Done, bytes_total: 10, bytes_done: 10, files_total: 1, files_done: 1,
            files_skipped: 0, current: None, speed_bps: 0.0, errors: vec![], verified: 0, started_ms: 1, finished_ms: Some(9), silent: false, reconnects: 0,
        };
        let f: Finished = serde_json::from_value(serde_json::to_value(&snap).unwrap()).unwrap();
        assert_eq!((f.id, f.finished_ms, f.silent, f.direction.as_str(), f.status.as_str()), (7, Some(9), false, "pull", "done"));
        assert_eq!(finished_message(&f).unwrap().0, "Saved to your Mac: Photos");
        let waiting: Finished = serde_json::from_value(serde_json::to_value(Snapshot { status: Status::Waiting, finished_ms: None, ..snap }).unwrap()).unwrap();
        assert_eq!(finished_message(&waiting), None);
    }
}
