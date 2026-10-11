mod adb;
mod apps;
mod backup;
mod device;
mod fs;
mod media;
mod menubar;
mod mirror;
mod native_drag;
mod remote_zip;
mod storage;
mod store;
mod tools;
mod transfer;

use adb::AdbDevice;
use device::DeviceInfo;
use fs::FileEntry;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use transfer::{Direction, Manager, TransferRequest};

type CmdResult<T> = Result<T, String>;
type Mgr<'a> = State<'a, Arc<Manager>>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
async fn list_devices() -> CmdResult<Vec<AdbDevice>> {
    adb::list_devices().await.map_err(err)
}

#[tauri::command]
async fn device_info(serial: String) -> CmdResult<DeviceInfo> {
    device::fetch_info(&serial).await.map_err(err)
}

#[tauri::command]
async fn list_dir(serial: String, path: String) -> CmdResult<Vec<FileEntry>> {
    fs::list_device(&serial, &path).await.map_err(err)
}

#[tauri::command]
async fn list_local(path: String) -> CmdResult<Vec<FileEntry>> {
    fs::list_local(&path).await.map_err(err)
}

#[tauri::command]
async fn device_places(serial: String) -> CmdResult<Vec<FileEntry>> {
    fs::device_places(&serial).await.map_err(err)
}

#[tauri::command]
async fn device_volumes(serial: String) -> CmdResult<Vec<FileEntry>> {
    fs::device_volumes(&serial).await.map_err(err)
}

#[tauri::command]
fn local_home() -> String {
    fs::local_home()
}

#[tauri::command]
async fn device_mkdir(serial: String, path: String) -> CmdResult<()> {
    fs::device_mkdir(&serial, &path).await.map_err(err)
}

#[tauri::command]
async fn local_mkdir(path: String) -> CmdResult<()> {
    tokio::fs::create_dir_all(path).await.map_err(err)
}

#[tauri::command]
async fn device_rename(serial: String, from: String, to: String) -> CmdResult<()> {
    fs::device_rename(&serial, &from, &to).await.map_err(err)
}

#[tauri::command]
async fn local_rename(from: String, to: String) -> CmdResult<()> {
    if tokio::fs::symlink_metadata(&to).await.is_ok() {
        return Err("An item with that name already exists".into());
    }
    tokio::fs::rename(from, to).await.map_err(err)
}

#[tauri::command]
async fn device_delete(serial: String, paths: Vec<String>) -> CmdResult<()> {
    fs::device_delete(&serial, &paths).await.map_err(err)
}

/// Mac deletes go to the Trash, never straight to oblivion.
#[tauri::command]
async fn local_trash(paths: Vec<String>) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || trash::delete_all(paths).map_err(err)).await.map_err(err)?
}

#[tauri::command]
async fn check_conflicts(serial: String, direction: Direction, sources: Vec<String>, dest_dir: String) -> Vec<String> {
    transfer::check_conflicts(&serial, direction, &sources, &dest_dir).await
}

#[tauri::command]
fn start_transfer(app: AppHandle, mgr: Mgr<'_>, req: TransferRequest) -> u64 {
    mgr.inner().start(app, req)
}

#[tauri::command]
fn pause_transfer(app: AppHandle, mgr: Mgr<'_>, id: u64) {
    mgr.set_paused(id, true, &app)
}

#[tauri::command]
fn resume_transfer(app: AppHandle, mgr: Mgr<'_>, id: u64) {
    mgr.set_paused(id, false, &app)
}

#[tauri::command]
fn cancel_transfer(mgr: Mgr<'_>, id: u64) {
    mgr.cancel(id)
}

#[tauri::command]
fn clear_finished_transfers(mgr: Mgr<'_>) {
    mgr.clear_finished()
}

#[tauri::command]
async fn install_apk(serial: String, path: String) -> CmdResult<String> {
    transfer::install_apk(&serial, &path).await.map_err(err)
}

#[tauri::command]
async fn reveal_in_finder(path: String) -> CmdResult<()> {
    tokio::process::Command::new("open").args(["-R", &path]).status().await.map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn open_local(path: String) -> CmdResult<()> {
    tokio::process::Command::new("open").arg(&path).status().await.map_err(err)?;
    Ok(())
}

/// Pull a phone file into a cache dir, then Quick Look it (or open it in its default Mac app).
#[tauri::command]
async fn preview_device_file(serial: String, path: String, open: bool) -> CmdResult<()> {
    let dir = std::env::temp_dir().join("droidshuttle-preview");
    tokio::fs::create_dir_all(&dir).await.map_err(err)?;
    let local = dir.join(fs::basename(&path));
    let (_owner, ctl) = transfer::ctl::channel();
    adb::sync::pull(&serial, &path, &local, &ctl, |_| {}).await.map_err(err)?;
    if open { open_local(local.to_string_lossy().into_owned()).await } else { preview_local_file(local.to_string_lossy().into_owned()).await }
}

#[tauri::command]
async fn preview_local_file(path: String) -> CmdResult<()> {
    tokio::process::Command::new("qlmanage")
        .args(["-p", &path])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(err)?;
    Ok(())
}

/// Hand a drag to macOS so Finder and other apps can receive it. Phone files are promised
/// and pulled on drop; Mac files are offered as plain file URLs.
#[tauri::command]
async fn native_drag(app: AppHandle, serial: Option<String>, items: Vec<native_drag::DragItemSpec>) -> CmdResult<()> {
    native_drag::begin(&app, serial, items)
}

/// Put the selection on the system clipboard: phone files as promises (pulled when pasted into
/// Finder), Mac files as file URLs. Returns the pasteboard change counter.
#[tauri::command]
async fn clipboard_write(app: AppHandle, serial: Option<String>, items: Vec<native_drag::DragItemSpec>) -> CmdResult<i64> {
    native_drag::clipboard_write(&app, serial, items)
}

/// File URLs currently on the system clipboard, plus its change counter.
#[tauri::command]
fn clipboard_read() -> native_drag::ClipInfo {
    native_drag::clipboard_read()
}

/// Where phone files are staged so the macOS clipboard can hold *real* files Finder can paste.
fn clipboard_stage_root() -> std::path::PathBuf {
    std::path::PathBuf::from(fs::local_home()).join("Library/Caches/ai.arqanum.droidshuttle/clipboard")
}

/// ⌘C on the phone: pull the selection to a staging folder, then put those real files on the
/// system clipboard so ⌘V in Finder (or any app) is an ordinary copy. Returns the change counter.
#[tauri::command]
async fn clipboard_stage(app: AppHandle, mgr: Mgr<'_>, serial: String, items: Vec<native_drag::DragItemSpec>) -> CmdResult<i64> {
    let staged = stage_items(app.clone(), mgr.inner().clone(), serial, items).await?;
    native_drag::clipboard_write(&app, None, staged)
}

pub(crate) async fn stage_items<R: tauri::Runtime>(
    app: AppHandle<R>,
    mgr: Arc<Manager>,
    serial: String,
    items: Vec<native_drag::DragItemSpec>,
) -> CmdResult<Vec<native_drag::DragItemSpec>> {
    let root = clipboard_stage_root();
    let _ = tokio::fs::remove_dir_all(&root).await; // previous copy's files are no longer needed
    let stage = root.join(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0).to_string());
    tokio::fs::create_dir_all(&stage).await.map_err(err)?;
    let n = items.len();
    let id = mgr.start(
        app,
        TransferRequest {
            serial,
            direction: Direction::Pull,
            sources: items.iter().map(|i| i.path.clone()).collect(),
            dest_dir: stage.to_string_lossy().into_owned(),
            conflict: transfer::Conflict::KeepBoth,
            verify: false,
            delete_source: false,
            dest_name: None,
            subdirs: None,
            record_import: false, silent: true, label: Some(if n == 1 { "Preparing 1 item for paste".to_string() } else { format!("Preparing {n} items for paste") }),
        },
    );
    let snap = mgr.wait(id).await.ok_or("transfer vanished")?;
    if snap.status != transfer::Status::Done {
        return Err("Copy was canceled".into());
    }
    if let Some(e) = snap.errors.first() {
        return Err(e.clone());
    }
    Ok(items
        .into_iter()
        .map(|i| native_drag::DragItemSpec { path: stage.join(fs::basename(&i.path)).to_string_lossy().into_owned(), is_dir: i.is_dir })
        .collect())
}

// ---------- Tools ----------

#[derive(Default)]
struct LogcatSlot {
    stop: std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>>,
}

/// Open an interactive shell. Output arrives on `on_out` as `[kind u8][bytes]` (1 stdout, 2 stderr, 3 exit).
#[tauri::command]
async fn shell_start(shells: State<'_, Arc<tools::Shells>>, serial: String, cols: u16, rows: u16, on_out: Channel<InvokeResponseBody>) -> CmdResult<u64> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let id = shells.inner().start(&serial, cols, rows, tx).await?;
    tauri::async_runtime::spawn(async move {
        while let Some(m) = rx.recv().await {
            if on_out.send(InvokeResponseBody::Raw(m)).is_err() {
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
fn shell_write(shells: State<'_, Arc<tools::Shells>>, id: u64, data: Vec<u8>) {
    shells.send(id, tools::ShellCmd::Input(data));
}

#[tauri::command]
fn shell_resize(shells: State<'_, Arc<tools::Shells>>, id: u64, cols: u16, rows: u16) {
    shells.send(id, tools::ShellCmd::Resize(cols, rows));
}

#[tauri::command]
fn shell_close(shells: State<'_, Arc<tools::Shells>>, id: u64) {
    shells.send(id, tools::ShellCmd::Close);
}

/// Stream logcat; each message is a batch of newline-terminated lines (UTF-8).
#[tauri::command]
async fn logcat_start(slot: State<'_, Arc<LogcatSlot>>, serial: String, clear: bool, on_lines: Channel<InvokeResponseBody>) -> CmdResult<()> {
    if let Some(old) = slot.stop.lock().unwrap().take() {
        let _ = old.send(true);
    }
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    *slot.stop.lock().unwrap() = Some(stop_tx);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    tauri::async_runtime::spawn(async move {
        let _ = tools::logcat_stream(&serial, clear, tx, stop_rx).await;
    });
    tauri::async_runtime::spawn(async move {
        while let Some(b) = rx.recv().await {
            if on_lines.send(InvokeResponseBody::Raw(b)).is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn logcat_stop(slot: State<'_, Arc<LogcatSlot>>) {
    if let Some(s) = slot.stop.lock().unwrap().take() {
        let _ = s.send(true);
    }
}

#[tauri::command]
async fn logcat_clear(serial: String) -> CmdResult<()> {
    adb::shell(&serial, "logcat -c").await.map(|_| ()).map_err(err)
}

#[tauri::command]
async fn pids_of_package(serial: String, package: String) -> Vec<u32> {
    tools::pids_of(&serial, &package).await
}

#[tauri::command]
async fn device_status(serial: String) -> CmdResult<tools::DeviceStatus> {
    tools::device_status(&serial).await
}

#[tauri::command]
async fn wifi_mdns() -> Vec<tools::MdnsService> {
    tools::mdns_services().await
}

#[tauri::command]
async fn wifi_pair(host_port: String, code: String) -> CmdResult<String> {
    tools::pair(&host_port, &code).await
}

#[tauri::command]
async fn wifi_connect(host_port: String) -> CmdResult<String> {
    tools::connect_to(&host_port).await
}

#[tauri::command]
async fn wifi_disconnect(host_port: String) -> CmdResult<()> {
    tools::disconnect(&host_port).await
}

#[tauri::command]
async fn wifi_go_wireless(serial: String) -> CmdResult<String> {
    tools::go_wireless(&serial, 5555).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct QrInfo {
    name: String,
    password: String,
    payload: String,
}

#[tauri::command]
fn wifi_qr() -> QrInfo {
    let (name, password) = tools::qr_credentials();
    let payload = tools::qr_payload(&name, &password);
    QrInfo { name, password, payload }
}

/// QR pairing: wait for the phone to advertise our pairing service, pair, then connect.
#[tauri::command]
async fn wifi_qr_finish(name: String, password: String, timeout_secs: u64) -> CmdResult<String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs.clamp(5, 180));
    let target = loop {
        if let Some(s) = tools::mdns_services().await.into_iter().find(|s| s.kind == "_adb-tls-pairing._tcp" && s.name == name) {
            break s;
        }
        if std::time::Instant::now() > deadline {
            return Err("Didn't see the phone scan the QR code. On the phone: Developer options → Wireless debugging → Pair device with QR code.".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    };
    tools::pair(&target.address, &password).await?;
    // After pairing the phone advertises a connect service; connect to it.
    for _ in 0..25 {
        if let Some(c) = tools::mdns_services().await.into_iter().find(|s| s.kind == "_adb-tls-connect._tcp" && s.address.split(':').next() == target.address.split(':').next()) {
            return tools::connect_to(&c.address).await.map(|_| c.address);
        }
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    }
    Ok(format!("Paired with {}. It will appear in the device list shortly.", target.address))
}

/// Save text (e.g. a log export) to a file the user picked.
#[tauri::command]
async fn save_text(path: String, content: String) -> CmdResult<()> {
    tokio::fs::write(path, content).await.map_err(err)
}

// ---------- Mirror ----------

#[derive(Default)]
struct MirrorSlot {
    current: std::sync::Mutex<Option<mirror::ControlHandle>>,
    recording: tokio::sync::Mutex<Option<(String, String, tokio::net::TcpStream)>>, // serial, remote path, stream
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MirrorInfo {
    device_name: String,
}

/// Start mirroring. Video packets stream to `on_video` as binary messages:
/// `[kind u8][pts u64 BE][payload]` with kind 0 = session (payload = width u32, height u32),
/// 1 = SPS/PPS config, 2 = key frame, 3 = delta frame.
#[tauri::command]
async fn mirror_start(app: AppHandle, slot: State<'_, Arc<MirrorSlot>>, serial: String, opts: mirror::MirrorOptions, on_video: Channel<InvokeResponseBody>) -> CmdResult<MirrorInfo> {
    if let Some(old) = slot.current.lock().unwrap().take() {
        old.stop();
    }
    let mut session = mirror::start(&serial, &opts).await?;
    let info = MirrorInfo { device_name: session.device_name.clone() };
    *slot.current.lock().unwrap() = Some(session.control_handle());
    if opts.screen_off {
        session.send(mirror::msg::display_power(false)); // mirror with the phone's own screen dark
    }
    tauri::async_runtime::spawn(async move {
        let pack = |kind: u8, pts: u64, payload: &[u8]| {
            let mut v = Vec::with_capacity(9 + payload.len());
            v.push(kind);
            v.extend_from_slice(&pts.to_be_bytes());
            v.extend_from_slice(payload);
            v
        };
        loop {
            tokio::select! {
                v = session.video.recv() => match v {
                    Some(mirror::VideoMsg::Session { width, height }) => {
                        let mut p = width.to_be_bytes().to_vec();
                        p.extend_from_slice(&height.to_be_bytes());
                        if on_video.send(InvokeResponseBody::Raw(pack(0, 0, &p))).is_err() { break }
                    }
                    Some(mirror::VideoMsg::Config(c)) => { if on_video.send(InvokeResponseBody::Raw(pack(1, 0, &c))).is_err() { break } }
                    Some(mirror::VideoMsg::Frame { key, pts_us, data }) => { if on_video.send(InvokeResponseBody::Raw(pack(if key { 2 } else { 3 }, pts_us, &data))).is_err() { break } }
                    None => break,
                },
                d = session.device.recv() => if let Some(mirror::DeviceMsg::Clipboard(text)) = d {
                    // The phone's clipboard changed → put it on the Mac's clipboard too.
                    if let Ok(mut child) = tokio::process::Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn() {
                        if let Some(mut si) = child.stdin.take() { use tokio::io::AsyncWriteExt; let _ = si.write_all(text.as_bytes()).await; }
                        let _ = child.wait().await;
                    }
                    let _ = app.emit("mirror-clipboard", text);
                },
            }
        }
        let reason = session.log.lock().unwrap().iter().rev().find(|l| l.contains("ERROR") || l.contains("Exception")).cloned();
        session.stop();
        let _ = app.emit("mirror-ended", reason);
    });
    Ok(info)
}

#[tauri::command]
fn mirror_input(slot: State<'_, Arc<MirrorSlot>>, input: mirror::Input) {
    if let Some(h) = slot.current.lock().unwrap().as_ref() {
        h.send(input.encode());
    }
}

#[tauri::command]
fn mirror_stop(slot: State<'_, Arc<MirrorSlot>>) {
    if let Some(h) = slot.current.lock().unwrap().take() {
        h.stop();
    }
}

/// Save a screenshot as PNG into `dest_dir` (created if needed) and return its path.
#[tauri::command]
async fn phone_screenshot(serial: String, dest_dir: String) -> CmdResult<String> {
    let png = mirror::screenshot(&serial).await?;
    tokio::fs::create_dir_all(&dest_dir).await.map_err(err)?;
    let path = std::path::Path::new(&dest_dir).join(mirror::timestamped("Screenshot", "png"));
    tokio::fs::write(&path, png).await.map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn record_start(slot: State<'_, Arc<MirrorSlot>>, serial: String, bit_rate_mbps: u32) -> CmdResult<()> {
    let mut rec = slot.recording.lock().await;
    if rec.is_some() {
        return Err("A recording is already running.".into());
    }
    let remote = mirror::recording_remote_path();
    let _ = adb::shell_rc(&serial, &format!("rm -f {}", adb::shell_quote(&remote))).await;
    let stream = mirror::record_start(&serial, &remote, bit_rate_mbps).await?;
    *rec = Some((serial, remote, stream));
    Ok(())
}

/// Stop the recording and save the MP4 into `dest_dir`.
#[tauri::command]
async fn record_stop(slot: State<'_, Arc<MirrorSlot>>, dest_dir: String) -> CmdResult<String> {
    let (serial, remote, stream) = slot.recording.lock().await.take().ok_or("No recording is running.")?;
    tokio::fs::create_dir_all(&dest_dir).await.map_err(err)?;
    let path = std::path::Path::new(&dest_dir).join(mirror::timestamped("Screen Recording", "mp4"));
    let result = mirror::record_finish(&serial, &remote, &path).await;
    drop(stream);
    result?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn record_active(slot: State<'_, Arc<MirrorSlot>>) -> CmdResult<bool> {
    Ok(slot.recording.lock().await.is_some())
}

// ---------- Apps ----------

#[tauri::command]
async fn apps_list(serial: String) -> CmdResult<Vec<apps::AppInfo>> {
    apps::list(&serial).await
}

/// Resolve names/icons in the background; results arrive as `app-meta` events.
#[tauri::command]
async fn apps_resolve(app: AppHandle, serial: String, items: Vec<apps::ResolveReq>) -> usize {
    apps::resolve_many(app, serial, items).await
}

#[tauri::command]
async fn app_details(serial: String, package: String) -> CmdResult<apps::AppDetails> {
    apps::details(&serial, &package).await
}

#[tauri::command]
async fn app_uninstall(serial: String, package: String, keep_data: bool, system: bool) -> CmdResult<()> {
    apps::uninstall(&serial, &package, keep_data, system).await
}

#[tauri::command]
async fn app_set_enabled(serial: String, package: String, enabled: bool) -> CmdResult<()> {
    apps::set_enabled(&serial, &package, enabled).await
}

#[tauri::command]
async fn app_clear_data(serial: String, package: String) -> CmdResult<()> {
    apps::clear_data(&serial, &package).await
}

#[tauri::command]
async fn app_force_stop(serial: String, package: String) -> CmdResult<()> {
    apps::force_stop(&serial, &package).await
}

#[tauri::command]
async fn app_launch(serial: String, package: String) -> CmdResult<()> {
    apps::launch(&serial, &package).await
}

#[tauri::command]
async fn app_open_settings(serial: String, package: String) -> CmdResult<()> {
    apps::open_settings(&serial, &package).await
}

/// Save an app's APK (all split APKs, if any) to the Mac via the transfer engine.
#[tauri::command]
async fn app_extract(app: AppHandle, mgr: Mgr<'_>, serial: String, package: String, label: String, version: String, dest_dir: String) -> CmdResult<u64> {
    let paths = apps::details(&serial, &package).await?.apk_paths;
    if paths.is_empty() {
        return Err("Couldn't find this app's package file".into());
    }
    let safe = |s: &str| s.chars().map(|c| if c == '/' || c == ':' || c.is_control() { '_' } else { c }).collect::<String>();
    let single = paths.len() == 1;
    let name = format!("{}_{}.apk", safe(if label.is_empty() { &package } else { &label }), safe(&version));
    let subdirs = (!single).then(|| paths.iter().map(|p| (p.clone(), format!("{}-{}", package, safe(&version)))).collect());
    Ok(mgr.inner().start(
        app,
        TransferRequest {
            serial,
            direction: Direction::Pull,
            sources: paths,
            dest_dir,
            conflict: transfer::Conflict::KeepBoth,
            verify: false,
            delete_source: false,
            dest_name: single.then_some(name),
            subdirs,
            record_import: false, silent: false, label: None,
        },
    ))
}

/// Install .apk files and .apks/.xapk/.apkm bundles, one after another.
#[tauri::command]
async fn apps_install(serial: String, paths: Vec<String>) -> Vec<apps::InstallOutcome> {
    let mut out = Vec::new();
    for p in paths {
        out.push(apps::install_one(&serial, &p).await);
    }
    out
}

// ---------- Backup ----------

#[tauri::command]
async fn backup_folders(serial: String) -> CmdResult<Vec<backup::BackupFolder>> {
    backup::folders(&serial).await
}

#[tauri::command]
async fn backup_folder_size(serial: String, path: String) -> CmdResult<u64> {
    backup::folder_size(&serial, &path).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedStatus {
    exists: bool,
    has_password: bool,
    path: String,
}

/// Does an encrypted backup already exist for this phone, and is its password in the Keychain?
#[tauri::command]
async fn backup_encrypted_status(dest_root: String, device_name: String, serial: String) -> EncryptedStatus {
    let bundle = backup::bundle_path(&dest_root, &backup::device_folder(&device_name, &serial));
    let has_password = backup::keychain_get(&bundle).await.is_some();
    EncryptedStatus { exists: bundle.exists(), has_password, path: bundle.to_string_lossy().into_owned() }
}

/// Runs the whole backup (progress: transfer tray + `backup-stage` events); resolves when finished.
#[tauri::command]
async fn backup_run(app: AppHandle, mgr: Mgr<'_>, state: State<'_, Arc<backup::BackupState>>, req: backup::BackupRequest) -> CmdResult<backup::BackupSummary> {
    backup::run_backup(app, mgr.inner().clone(), state.inner().clone(), req).await
}

#[tauri::command]
fn backup_cancel(mgr: Mgr<'_>, state: State<'_, Arc<backup::BackupState>>) {
    backup::cancel(&mgr, &state)
}

#[tauri::command]
fn backup_running(state: State<'_, Arc<backup::BackupState>>) -> bool {
    state.running.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
async fn backup_history(serial: String) -> CmdResult<Vec<backup::BackupRecord>> {
    tokio::task::spawn_blocking(move || backup::history(&serial)).await.map_err(err)?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedBackup {
    root: String,
    mounted: bool,
    contents: backup::BackupContents,
}

/// Open a backup folder or encrypted image (unlocking it) and list what's inside.
#[tauri::command]
async fn backup_open(path: String, password: Option<String>) -> CmdResult<OpenedBackup> {
    let p = std::path::PathBuf::from(&path);
    let (root, mounted) = if path.ends_with(".sparsebundle") {
        let pw = match password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None => backup::keychain_get(&p).await.ok_or("This backup is encrypted. Enter its password.")?,
        };
        (backup::attach(&p, &pw).await?, true)
    } else {
        (p, false)
    };
    let r = root.clone();
    let contents = tokio::task::spawn_blocking(move || backup::contents(&r)).await.map_err(err)?;
    Ok(OpenedBackup { root: root.to_string_lossy().into_owned(), mounted, contents })
}

#[tauri::command]
async fn backup_close(root: String) {
    backup::detach(std::path::Path::new(&root)).await;
}

#[tauri::command]
fn backup_restore_files(app: AppHandle, mgr: Mgr<'_>, req: backup::RestoreFilesRequest) -> u64 {
    mgr.inner().start(app, backup::restore_request(&req))
}

#[tauri::command]
async fn backup_restore_apps(serial: String, root: String, dirs: Vec<String>) -> Vec<apps::InstallOutcome> {
    backup::restore_apps(&serial, std::path::Path::new(&root), &dirs).await
}

// ---------- Gallery ----------

#[tauri::command]
async fn media_scan(serial: String) -> CmdResult<usize> {
    media::scan(&serial).await
}

#[tauri::command]
async fn media_list(serial: String) -> CmdResult<Vec<media::MediaItem>> {
    tokio::task::spawn_blocking(move || media::list(&serial)).await.map_err(err)?
}

/// Path to a cached thumbnail. `fast` = the embedded EXIF preview only.
#[tauri::command]
async fn media_thumb(serial: String, req: media::ThumbReq, fast: bool) -> CmdResult<String> {
    media::thumbnail(&serial, &req, fast).await.map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn media_open(app: AppHandle, mgr: Mgr<'_>, serial: String, path: String, kind: String, size: u64) -> CmdResult<String> {
    let p = if kind == "video" { media::open_video(app, mgr.inner().clone(), &serial, &path, size).await? } else { media::open_image(&serial, &path, size).await? };
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn media_info(serial: String, path: String) -> CmdResult<media::MediaInfo> {
    media::info(&serial, &path).await
}

/// Copy photos/videos to the Mac, optionally organized into folders and deleted from the phone
/// afterwards (only files whose SHA-256 matched are deleted).
#[tauri::command]
async fn media_import(app: AppHandle, mgr: Mgr<'_>, serial: String, items: Vec<media::ImportItem>, dest_dir: String, organize: media::Organize, delete_after: bool) -> CmdResult<u64> {
    let paths: Vec<String> = items.iter().map(|i| i.path.clone()).collect();
    let id = mgr.inner().start(
        app.clone(),
        TransferRequest {
            serial: serial.clone(),
            direction: Direction::Pull,
            sources: paths.clone(),
            dest_dir,
            conflict: transfer::Conflict::KeepBoth,
            verify: delete_after,
            delete_source: delete_after,
            dest_name: None,
            subdirs: Some(media::subdirs_for(&items, organize)),
            record_import: true, silent: false, label: None,
        },
    );
    let (mgr, app2) = (mgr.inner().clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        mgr.wait(id).await;
        if delete_after {
            media::forget_missing(&serial, &paths).await;
        }
        let _ = app2.emit("media-changed", ());
    });
    Ok(id)
}

// ---------- storage analyzer & duplicate finder ----------

type StorageState<'a> = State<'a, Arc<storage::State>>;

/// Scan the phone's storage (read-only). Progress arrives as `storage-progress` events.
#[tauri::command]
async fn storage_scan(app: AppHandle, st: StorageState<'_>, serial: String, root: Option<String>) -> CmdResult<storage::Summary> {
    let cancel = st.begin();
    let a = app.clone();
    let scan = storage::scan_device(&serial, root.as_deref().unwrap_or("/sdcard"), &cancel, move |p| {
        let _ = a.emit("storage-progress", &p);
    })
    .await
    .map_err(err)?;
    let summary = scan.summary();
    st.put(&serial, scan);
    Ok(summary)
}

#[tauri::command]
async fn storage_cancel(st: StorageState<'_>) -> CmdResult<()> {
    st.cancel();
    Ok(())
}

#[tauri::command]
async fn storage_summary(st: StorageState<'_>, serial: String) -> CmdResult<Option<storage::Summary>> {
    Ok(st.get(&serial).map(|s| s.lock().unwrap().summary()))
}

#[tauri::command]
async fn storage_children(st: StorageState<'_>, serial: String, path: String) -> CmdResult<Option<Vec<storage::TreeNode>>> {
    Ok(st.get(&serial).and_then(|s| s.lock().unwrap().children(&path)))
}

#[tauri::command]
async fn storage_largest(st: StorageState<'_>, serial: String, category: Option<String>, min_size: u64, limit: usize) -> CmdResult<Vec<storage::FileItem>> {
    let cat = category.as_deref().and_then(storage::Category::parse);
    Ok(st.get(&serial).map(|s| s.lock().unwrap().largest(cat, min_size, limit.min(2000))).unwrap_or_default())
}

/// Find files with identical content. Slow part is hashing on the phone; progress arrives as `storage-progress`.
#[tauri::command]
async fn storage_duplicates(app: AppHandle, st: StorageState<'_>, serial: String, min_size: u64) -> CmdResult<Vec<storage::DupGroup>> {
    let scan = st.get(&serial).ok_or("Scan the phone first")?;
    let groups = scan.lock().unwrap().same_size_groups(min_size);
    let cancel = st.begin();
    let a = app.clone();
    storage::find_duplicates(groups, &storage::PhoneHasher(&serial), &cancel, move |p| {
        let _ = a.emit("storage-progress", &p);
    })
    .await
    .map_err(err)
}

/// Tell the scan these paths were deleted, so its totals stay right without a rescan.
#[tauri::command]
async fn storage_forget(st: StorageState<'_>, serial: String, paths: Vec<String>) -> CmdResult<Option<storage::Summary>> {
    let Some(scan) = st.get(&serial) else { return Ok(None) };
    let mut s = scan.lock().unwrap();
    for p in &paths {
        s.remove(p);
    }
    Ok(Some(s.summary()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();
    store::migrate_legacy(); // before anything opens the database
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(Manager::default()))
        .manage(Arc::new(menubar::MenuBar::default()))
        .manage(Arc::new(backup::BackupState::default()))
        .manage(Arc::new(MirrorSlot::default()))
        .manage(Arc::new(tools::Shells::default()))
        .manage(Arc::new(LogcatSlot::default()))
        .manage(Arc::new(storage::State::default()))
        .setup(|app| {
            menubar::init(app.handle())?;
            device::spawn_tracker(app.handle().clone());
            let _ = std::fs::remove_dir_all(clipboard_stage_root()); // leftovers from a previous run
            std::thread::spawn(|| media::prune_originals(2 * 1024 * 1024 * 1024));
            Ok(())
        })
        .on_window_event(|window, event| menubar::on_window_event(window, event))
        .invoke_handler(tauri::generate_handler![
            list_devices, device_info, list_dir, list_local, device_places, device_volumes, local_home,
            device_mkdir, local_mkdir, device_rename, local_rename, device_delete, local_trash,
            check_conflicts, start_transfer, pause_transfer, resume_transfer, cancel_transfer,
            clear_finished_transfers, install_apk, reveal_in_finder, open_local, preview_device_file, preview_local_file, native_drag, clipboard_write, clipboard_read, clipboard_stage,
            media_scan, media_list, media_thumb, media_open, media_info, media_import,
            backup_folders, backup_folder_size, backup_encrypted_status, backup_run, backup_cancel, backup_running, backup_history, backup_open, backup_close, backup_restore_files, backup_restore_apps,
            shell_start, shell_write, shell_resize, shell_close, logcat_start, logcat_stop, logcat_clear, pids_of_package, device_status, wifi_mdns, wifi_pair, wifi_connect, wifi_disconnect, wifi_go_wireless, wifi_qr, wifi_qr_finish, save_text,
            mirror_start, mirror_input, mirror_stop, phone_screenshot, record_start, record_stop, record_active,
            storage_scan, storage_cancel, storage_summary, storage_children, storage_largest, storage_duplicates, storage_forget,
            apps_list, apps_resolve, app_details, app_uninstall, app_set_enabled, app_clear_data, app_force_stop, app_launch, app_open_settings, app_extract, apps_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the Dock icon while the window is hidden brings it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
                menubar::show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
