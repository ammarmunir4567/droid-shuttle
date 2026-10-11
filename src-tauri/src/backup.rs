//! Backup & restore: a browsable mirror of chosen phone folders plus your apps' APK files.
//!
//! Layout inside the backup folder (or the mounted encrypted image):
//!   files/<path relative to /sdcard>/…   apps/<package>-<version>/*.apk   apps.json   backup.json
//!
//! Backups are incremental (unchanged files are skipped) and never delete anything from the
//! backup when you delete it from the phone — that's the point of a backup. Encryption uses a
//! native macOS AES-256 disk image, so the contents stay ordinary files you can open in Finder.

use crate::adb::{self, shell_quote, sync};
use crate::fs::{basename, join, parent};
use crate::store::db;
use crate::transfer::{Conflict, Direction, Manager, Snapshot, Status, TransferRequest};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::AsyncWriteExt;

const SDCARD: &str = "/sdcard";

// ---------- what can be backed up ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFolder {
    pub path: String,
    pub label: String,
    /// Sensible to include by default.
    pub recommended: bool,
}

/// Top-level folders worth offering, plus per-app media folders (e.g. WhatsApp). The restricted
/// `Android/data` and `Android/obb` folders are never offered — Android hides them from USB anyway.
pub async fn folders(serial: &str) -> Result<Vec<BackupFolder>, String> {
    const GOOD: [&str; 8] = ["DCIM", "Pictures", "Movies", "Music", "Documents", "Download", "Recordings", "Audiobooks"];
    let top = sync::list(serial, SDCARD).await.map_err(|e| e.to_string())?;
    let mut out: Vec<BackupFolder> = top
        .into_iter()
        .filter(|e| e.is_dir() && e.name != "Android" && !e.name.starts_with('.') && !e.name.starts_with("Alarms") && e.name != "Notifications" && e.name != "Ringtones")
        .map(|e| BackupFolder { recommended: GOOD.contains(&e.name.as_str()), label: e.name.clone(), path: join(SDCARD, &e.name) })
        .collect();
    if let Ok(media) = sync::list(serial, "/sdcard/Android/media").await {
        for e in media.into_iter().filter(|e| e.is_dir()) {
            let wa = e.name == "com.whatsapp" || e.name == "com.whatsapp.w4b";
            out.push(BackupFolder { recommended: wa, label: if wa { "WhatsApp media".into() } else { format!("App media: {}", e.name) }, path: join("/sdcard/Android/media", &e.name) });
        }
    }
    out.sort_by(|a, b| b.recommended.cmp(&a.recommended).then(a.label.to_lowercase().cmp(&b.label.to_lowercase())));
    Ok(out)
}

/// `du` over USB can take a while for huge folders, so the UI asks per folder.
pub async fn folder_size(serial: &str, path: &str) -> Result<u64, String> {
    let (out, rc) = adb::shell_rc(serial, &format!("du -sk {}", shell_quote(path))).await.map_err(|e| e.to_string())?;
    if rc != 0 && out.trim().is_empty() {
        return Err("couldn't measure".into());
    }
    out.split_whitespace().next().and_then(|n| n.parse::<u64>().ok()).map(|k| k * 1024).ok_or_else(|| "couldn't measure".into())
}

// ---------- encrypted image (AES-256 sparse bundle) ----------

const KEYCHAIN_SERVICE: &str = "Droid Shuttle Backup";

pub fn bundle_path(dest_root: &str, name: &str) -> PathBuf {
    Path::new(dest_root).join(format!("{name}.sparsebundle"))
}

async fn run(cmd: &str, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    if stdin.is_some() {
        c.stdin(std::process::Stdio::piped());
    }
    let mut child = c.spawn().map_err(|e| format!("{cmd}: {e}"))?;
    if let (Some(input), Some(mut si)) = (stdin, child.stdin.take()) {
        si.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
        drop(si);
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

/// Passwords saved before the app was renamed live under the old Keychain service name.
const LEGACY_KEYCHAIN_SERVICE: &str = "Droidbridge Backup";

pub async fn keychain_get(bundle: &Path) -> Option<String> {
    for service in [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE] {
        let got = run("security", &["find-generic-password", "-s", service, "-a", &bundle.to_string_lossy(), "-w"], None).await.ok().map(|s| s.trim_end_matches('\n').to_string()).filter(|s| !s.is_empty());
        if got.is_some() {
            return got;
        }
    }
    None
}

async fn keychain_set(bundle: &Path, password: &str) -> Result<(), String> {
    run("security", &["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", &bundle.to_string_lossy(), "-w", password], None).await.map(|_| ())
}

/// Create an encrypted image (once) and remember its password in the Keychain.
pub async fn create_encrypted(bundle: &Path, volname: &str, password: &str) -> Result<(), String> {
    if bundle.exists() {
        return Ok(());
    }
    if password.len() < 6 {
        return Err("Choose a password of at least 6 characters.".into());
    }
    if let Some(p) = bundle.parent() {
        tokio::fs::create_dir_all(p).await.map_err(|e| e.to_string())?;
    }
    run("hdiutil", &["create", "-size", "2t", "-type", "SPARSEBUNDLE", "-fs", "APFS", "-encryption", "AES-256", "-stdinpass", "-volname", volname, &bundle.to_string_lossy()], Some(password)).await?;
    keychain_set(bundle, password).await
}

/// Mount the image and return its mount point.
pub async fn attach(bundle: &Path, password: &str) -> Result<PathBuf, String> {
    let mp = std::env::temp_dir().join(format!("droidshuttle-vol-{}", std::process::id()));
    let _ = tokio::fs::create_dir_all(&mp).await;
    run("hdiutil", &["attach", "-stdinpass", "-nobrowse", "-mountpoint", &mp.to_string_lossy(), &bundle.to_string_lossy()], Some(password)).await.map_err(|e| format!("Couldn't unlock the encrypted backup: {e}"))?;
    Ok(mp)
}

pub async fn detach(mount: &Path) {
    for _ in 0..3 {
        if run("hdiutil", &["detach", &mount.to_string_lossy()], None).await.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
    let _ = tokio::fs::remove_dir(mount).await;
}

// ---------- running a backup ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRequest {
    pub serial: String,
    pub device_name: String,
    /// Parent folder; a sub-folder named after the device is created inside.
    pub dest_root: String,
    pub folders: Vec<String>,
    pub include_apps: bool,
    /// Only these packages (default: every user-installed app).
    #[serde(default)]
    pub apps: Option<Vec<String>>,
    pub verify: bool,
    /// Store inside an AES-256 encrypted disk image. `password` is only needed the first time.
    pub encrypt: bool,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub dest: String,
    pub files_copied: u64,
    pub files_skipped: u64,
    pub bytes: u64,
    pub apps: u64,
    pub errors: Vec<String>,
    pub canceled: bool,
    pub started_ms: i64,
    pub finished_ms: i64,
    pub encrypted: bool,
}

#[derive(Default)]
pub struct BackupState {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub job: AtomicU64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn safe_name(s: &str) -> String {
    let c: String = s.chars().map(|c| if c == '/' || c == ':' || c.is_control() { '_' } else { c }).collect();
    let c = c.trim().to_string();
    if c.is_empty() { "Android phone".into() } else { c }
}

/// Folder name for a device's backups: readable and unique per phone.
pub fn device_folder(device_name: &str, serial: &str) -> String {
    let tail: String = serial.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{} ({})", safe_name(device_name), tail)
}

/// Relative parent folder inside `files/` for a phone path (`/sdcard/Android/media/x` → `Android/media`).
pub fn rel_parent(device_path: &str) -> String {
    let rel = device_path.strip_prefix("/sdcard/").or_else(|| device_path.strip_prefix("/storage/emulated/0/")).unwrap_or(device_path.trim_start_matches('/'));
    let p = parent(&format!("/{rel}"));
    p.trim_matches('/').to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct AppEntry {
    package: String,
    label: String,
    version_name: String,
    version_code: i64,
    dir: String,
    files: Vec<String>,
}

pub struct Progress<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<R: Runtime> Progress<'_, R> {
    fn stage(&self, stage: &str, detail: &str) {
        let _ = self.app.emit("backup-stage", serde_json::json!({ "stage": stage, "detail": detail }));
    }
}

async fn run_job<R: Runtime>(app: &AppHandle<R>, mgr: &Arc<Manager>, state: &BackupState, req: TransferRequest) -> Snapshot {
    let id = mgr.start(app.clone(), req);
    state.job.store(id, Ordering::SeqCst);
    let snap = mgr.wait(id).await.unwrap_or_else(|| panic!("job {id} vanished"));
    state.job.store(0, Ordering::SeqCst);
    snap
}

pub async fn run_backup<R: Runtime>(app: AppHandle<R>, mgr: Arc<Manager>, state: Arc<BackupState>, req: BackupRequest) -> Result<BackupSummary, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A backup is already running.".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let result = run_backup_inner(&app, &mgr, &state, &req).await;
    state.running.store(false, Ordering::SeqCst);
    result
}

async fn run_backup_inner<R: Runtime>(app: &AppHandle<R>, mgr: &Arc<Manager>, state: &BackupState, req: &BackupRequest) -> Result<BackupSummary, String> {
    let progress = Progress { app };
    let started = now_ms();
    let name = device_folder(&req.device_name, &req.serial);
    let mut mount: Option<PathBuf> = None;

    // 1. Where does it go?
    let root: PathBuf = if req.encrypt {
        progress.stage("unlocking", "Unlocking the encrypted backup…");
        let bundle = bundle_path(&req.dest_root, &name);
        if !bundle.exists() {
            create_encrypted(&bundle, &name, req.password.as_deref().ok_or("Choose a password for the encrypted backup.")?).await?;
        }
        let pw = match &req.password {
            Some(p) if !p.is_empty() => p.clone(),
            _ => keychain_get(&bundle).await.ok_or("The backup password isn't in your Keychain. Enter it to continue.")?,
        };
        let mp = attach(&bundle, &pw).await?;
        mount = Some(mp.clone());
        mp
    } else {
        Path::new(&req.dest_root).join(&name)
    };
    tokio::fs::create_dir_all(&root).await.map_err(|e| format!("Can't write to {}: {e}", root.display()))?;

    let outcome = backup_into(app, mgr, state, req, &root, &progress).await;
    if let Some(mp) = mount {
        progress.stage("locking", "Locking the encrypted backup…");
        detach(&mp).await;
    }
    let (mut summary, err) = match outcome {
        Ok(s) => (s, None),
        Err(e) => (BackupSummary { dest: root.to_string_lossy().into_owned(), files_copied: 0, files_skipped: 0, bytes: 0, apps: 0, errors: vec![e.clone()], canceled: false, started_ms: started, finished_ms: now_ms(), encrypted: req.encrypt }, Some(e)),
    };
    summary.started_ms = started;
    summary.finished_ms = now_ms();
    summary.encrypted = req.encrypt;
    if req.encrypt {
        summary.dest = bundle_path(&req.dest_root, &name).to_string_lossy().into_owned();
    }
    if let Ok(conn) = db().lock() {
        let _ = conn.execute(
            "INSERT INTO backups (serial, device, dest, started_ms, finished_ms, files_copied, files_skipped, bytes, apps, errors, what) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![req.serial, req.device_name, summary.dest, summary.started_ms, summary.finished_ms, summary.files_copied as i64, summary.files_skipped as i64, summary.bytes as i64, summary.apps as i64, summary.errors.len() as i64, req.folders.join("\n")],
        );
    }
    let _ = app.emit("backup-done", &summary);
    match err {
        Some(e) => Err(e),
        None => Ok(summary),
    }
}

async fn backup_into<R: Runtime>(app: &AppHandle<R>, mgr: &Arc<Manager>, state: &BackupState, req: &BackupRequest, root: &Path, progress: &Progress<'_, R>) -> Result<BackupSummary, String> {
    let mut summary = BackupSummary { dest: root.to_string_lossy().into_owned(), files_copied: 0, files_skipped: 0, bytes: 0, apps: 0, errors: vec![], canceled: false, started_ms: now_ms(), finished_ms: 0, encrypted: false };

    // 2. Files
    let mut sources = Vec::new();
    let mut subdirs = HashMap::new();
    for f in &req.folders {
        if matches!(sync::stat(&req.serial, f).await, Ok(Some(e)) if e.is_dir()) {
            subdirs.insert(f.clone(), rel_parent(f));
            sources.push(f.clone());
        } else {
            summary.errors.push(format!("{}: folder no longer exists on the phone", basename(f)));
        }
    }
    if !sources.is_empty() {
        progress.stage("files", "Copying new and changed files…");
        let snap = run_job(
            app,
            mgr,
            state,
            TransferRequest {
                serial: req.serial.clone(),
                direction: Direction::Pull,
                sources,
                dest_dir: root.join("files").to_string_lossy().into_owned(),
                conflict: Conflict::Update,
                verify: req.verify,
                delete_source: false,
                dest_name: None,
                subdirs: Some(subdirs),
                record_import: false, silent: false, label: None,
            },
        )
        .await;
        summary.files_copied += snap.files_done;
        summary.files_skipped += snap.files_skipped;
        summary.bytes += snap.bytes_done;
        summary.errors.extend(snap.errors.clone());
        if snap.status == Status::Canceled || state.cancel.load(Ordering::SeqCst) {
            summary.canceled = true;
            return Ok(summary);
        }
    }

    // 3. Apps
    if req.include_apps {
        progress.stage("apps", "Saving your apps' installers…");
        match backup_apps(app, mgr, state, req, root).await {
            Ok((n, snap)) => {
                summary.apps = n;
                if let Some(s) = snap {
                    summary.files_copied += s.files_done;
                    summary.files_skipped += s.files_skipped;
                    summary.bytes += s.bytes_done;
                    summary.errors.extend(s.errors.clone());
                    if s.status == Status::Canceled {
                        summary.canceled = true;
                        return Ok(summary);
                    }
                }
            }
            Err(e) => summary.errors.push(format!("Apps: {e}")),
        }
    }

    // 4. Manifest
    progress.stage("finishing", "Writing the backup manifest…");
    let manifest = serde_json::json!({
        "app": "Droid Shuttle", "device": req.device_name, "serial": req.serial, "lastBackupMs": now_ms(),
        "folders": req.folders, "includesApps": req.include_apps,
    });
    let _ = tokio::fs::write(root.join("backup.json"), serde_json::to_vec_pretty(&manifest).unwrap_or_default()).await;
    Ok(summary)
}

async fn backup_apps<R: Runtime>(app: &AppHandle<R>, mgr: &Arc<Manager>, state: &BackupState, req: &BackupRequest, root: &Path) -> Result<(u64, Option<Snapshot>), String> {
    let apps = crate::apps::list(&req.serial).await?;
    let user: Vec<_> = apps.into_iter().filter(|a| !a.system && req.apps.as_ref().map(|only| only.contains(&a.package)).unwrap_or(true)).collect();
    // Every split of every app.
    let sem = Arc::new(tokio::sync::Semaphore::new(6));
    let mut set = tokio::task::JoinSet::new();
    for a in user {
        let (sem, serial) = (sem.clone(), req.serial.clone());
        set.spawn(async move {
            let _p = sem.acquire().await.ok()?;
            let d = crate::apps::details(&serial, &a.package).await.ok()?;
            Some((a, d.apk_paths))
        });
    }
    let mut entries: Vec<AppEntry> = Vec::new();
    let mut sources = Vec::new();
    let mut subdirs = HashMap::new();
    while let Some(Ok(Some((a, paths)))) = set.join_next().await {
        if paths.is_empty() {
            continue;
        }
        let dir = format!("{}-{}", a.package, safe_name(&a.version_name));
        for p in &paths {
            subdirs.insert(p.clone(), format!("apps/{dir}"));
            sources.push(p.clone());
        }
        entries.push(AppEntry { package: a.package.clone(), label: a.label.clone(), version_name: a.version_name.clone(), version_code: a.version_code, dir, files: paths.iter().map(|p| basename(p).to_string()).collect() });
    }
    entries.sort_by(|a, b| a.package.cmp(&b.package));
    if sources.is_empty() {
        return Ok((0, None));
    }
    let snap = run_job(
        app,
        mgr,
        state,
        TransferRequest {
            serial: req.serial.clone(),
            direction: Direction::Pull,
            sources,
            dest_dir: root.to_string_lossy().into_owned(),
            conflict: Conflict::Update,
            verify: false,
            delete_source: false,
            dest_name: None,
            subdirs: Some(subdirs),
            record_import: false, silent: false, label: None,
        },
    )
    .await;
    let _ = tokio::fs::write(root.join("apps.json"), serde_json::to_vec_pretty(&entries).unwrap_or_default()).await;
    Ok((entries.len() as u64, Some(snap)))
}

pub fn cancel(mgr: &Manager, state: &BackupState) {
    state.cancel.store(true, Ordering::SeqCst);
    let id = state.job.load(Ordering::SeqCst);
    if id != 0 {
        mgr.cancel(id);
    }
}

// ---------- history & inspection ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: i64,
    pub device: String,
    pub dest: String,
    pub started_ms: i64,
    pub finished_ms: i64,
    pub files_copied: i64,
    pub files_skipped: i64,
    pub bytes: i64,
    pub apps: i64,
    pub errors: i64,
    pub folders: Vec<String>,
}

pub fn history(serial: &str) -> Result<Vec<BackupRecord>, String> {
    let conn = db().lock().map_err(|e| e.to_string())?;
    let mut st = conn
        .prepare("SELECT id, device, dest, started_ms, finished_ms, files_copied, files_skipped, bytes, apps, errors, what FROM backups WHERE serial = ?1 ORDER BY started_ms DESC LIMIT 50")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([serial], |r| {
            Ok(BackupRecord {
                id: r.get(0)?, device: r.get(1)?, dest: r.get(2)?, started_ms: r.get(3)?, finished_ms: r.get(4)?, files_copied: r.get(5)?, files_skipped: r.get(6)?,
                bytes: r.get(7)?, apps: r.get(8)?, errors: r.get(9)?, folders: r.get::<_, String>(10)?.lines().map(str::to_string).collect(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupContents {
    /// Folders inside `files/` (relative to /sdcard), with sizes.
    pub folders: Vec<ContentFolder>,
    pub apps: Vec<AppItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentFolder {
    pub rel: String,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppItem {
    pub package: String,
    pub label: String,
    pub version_name: String,
    pub dir: String,
    pub bytes: u64,
}

fn dir_stats(p: &Path) -> (u64, u64) {
    let (mut bytes, mut files) = (0, 0);
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                let (b, f) = dir_stats(&e.path());
                bytes += b;
                files += f;
            } else {
                bytes += m.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// Top-level restorable folders under `files/`. "Android/media/<pkg>" counts as one unit, like on the phone.
pub fn contents(root: &Path) -> BackupContents {
    let files = root.join("files");
    let mut folders = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&files) {
        for e in rd.flatten().filter(|e| e.path().is_dir()) {
            let n = e.file_name().to_string_lossy().into_owned();
            if n == "Android" {
                if let Ok(media) = std::fs::read_dir(e.path().join("media")) {
                    for m in media.flatten().filter(|m| m.path().is_dir()) {
                        let (bytes, files) = dir_stats(&m.path());
                        folders.push(ContentFolder { rel: format!("Android/media/{}", m.file_name().to_string_lossy()), bytes, files });
                    }
                }
                continue;
            }
            let (bytes, files) = dir_stats(&e.path());
            folders.push(ContentFolder { rel: n, bytes, files });
        }
    }
    folders.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    let apps = std::fs::read_to_string(root.join("apps.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<AppEntry>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|a| AppItem { bytes: dir_stats(&root.join("apps").join(&a.dir)).0, package: a.package, label: a.label, version_name: a.version_name, dir: a.dir })
        .collect();
    BackupContents { folders, apps }
}

// ---------- restore ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFilesRequest {
    pub serial: String,
    pub root: String,
    pub folders: Vec<String>,
    /// Where on the phone to restore to (normally `/sdcard`).
    pub dest_base: String,
    /// `update` skips identical files; `keepBoth` never overwrites.
    pub conflict: Conflict,
}

pub fn restore_request(r: &RestoreFilesRequest) -> TransferRequest {
    let mut subdirs = HashMap::new();
    let mut sources = Vec::new();
    for rel in &r.folders {
        let src = Path::new(&r.root).join("files").join(rel).to_string_lossy().into_owned();
        subdirs.insert(src.clone(), rel_parent(&format!("/sdcard/{rel}")));
        sources.push(src);
    }
    TransferRequest {
        serial: r.serial.clone(),
        direction: Direction::Push,
        sources,
        dest_dir: r.dest_base.clone(),
        conflict: r.conflict,
        verify: false,
        delete_source: false,
        dest_name: None,
        subdirs: Some(subdirs),
        record_import: false, silent: false, label: None,
    }
}

/// Install apps from a backup (`apps/<dir>/*.apk`), each app's splits together.
pub async fn restore_apps(serial: &str, root: &Path, dirs: &[String]) -> Vec<crate::apps::InstallOutcome> {
    let mut out = Vec::new();
    for d in dirs {
        let folder = root.join("apps").join(d);
        let mut apks: Vec<String> = std::fs::read_dir(&folder).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "apk").unwrap_or(false)).map(|p| p.to_string_lossy().into_owned()).collect()).unwrap_or_default();
        apks.sort();
        out.push(crate::apps::install_set(serial, d, &apks).await);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_relative_paths() {
        assert_eq!(rel_parent("/sdcard/DCIM"), "");
        assert_eq!(rel_parent("/sdcard/Android/media/com.whatsapp"), "Android/media");
        assert_eq!(rel_parent("/storage/emulated/0/Music/Rock"), "Music");
        assert_eq!(device_folder("Samsung SM-A075F", "R8VYB0143NB"), "Samsung SM-A075F (43NB)");
        assert_eq!(device_folder("a/b:c", "XY"), "a_b_c (XY)");
        assert_eq!(safe_name("  "), "Android phone");
    }

    #[test]
    fn contents_treats_app_media_as_units_and_reads_the_app_list() {
        let root = std::env::temp_dir().join(format!("db-contents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("files/DCIM/Camera")).unwrap();
        std::fs::create_dir_all(root.join("files/Android/media/com.whatsapp/Media")).unwrap();
        std::fs::create_dir_all(root.join("apps/com.foo-1.0")).unwrap();
        std::fs::write(root.join("files/DCIM/Camera/a.jpg"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("files/Android/media/com.whatsapp/Media/b.jpg"), vec![0u8; 50]).unwrap();
        std::fs::write(root.join("apps/com.foo-1.0/base.apk"), vec![0u8; 10]).unwrap();
        std::fs::write(root.join("apps.json"), r#"[{"package":"com.foo","label":"Foo","versionName":"1.0","versionCode":1,"dir":"com.foo-1.0","files":["base.apk"]}]"#).unwrap();
        let c = contents(&root);
        let rels: Vec<(&str, u64, u64)> = c.folders.iter().map(|f| (f.rel.as_str(), f.bytes, f.files)).collect();
        assert_eq!(rels, vec![("Android/media/com.whatsapp", 50, 1), ("DCIM", 100, 1)]);
        assert_eq!((c.apps[0].package.as_str(), c.apps[0].bytes), ("com.foo", 10));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restore_maps_backup_folders_back_to_their_phone_locations() {
        let r = restore_request(&RestoreFilesRequest { serial: "s".into(), root: "/bk".into(), folders: vec!["DCIM".into(), "Android/media/com.whatsapp".into()], dest_base: "/sdcard".into(), conflict: Conflict::Update });
        assert_eq!(r.sources, vec!["/bk/files/DCIM".to_string(), "/bk/files/Android/media/com.whatsapp".to_string()]);
        let sub = r.subdirs.unwrap();
        assert_eq!(sub["/bk/files/DCIM"], "");
        assert_eq!(sub["/bk/files/Android/media/com.whatsapp"], "Android/media");
        assert_eq!(r.direction, Direction::Push);
    }

    /// Real macOS disk-image encryption round trip (small image, temp dir): `cargo test live_encrypted -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn live_encrypted_image_roundtrip() {
        let dir = std::env::temp_dir().join(format!("db-enc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bundle = bundle_path(&dir.to_string_lossy(), "Test Phone (0001)");
        create_encrypted(&bundle, "Droid ShuttleTest", "correct horse battery").await.unwrap();
        assert!(bundle.exists());
        assert_eq!(keychain_get(&bundle).await.as_deref(), Some("correct horse battery"));

        // Wrong password must not unlock it.
        assert!(attach(&bundle, "wrong password").await.is_err());

        let mp = attach(&bundle, "correct horse battery").await.unwrap();
        std::fs::write(mp.join("secret.txt"), "top secret photos").unwrap();
        detach(&mp).await;

        // Nothing readable on disk without the password.
        let mut leaked = false;
        for e in walk(&bundle) {
            if let Ok(bytes) = std::fs::read(&e) {
                if bytes.windows(17).any(|w| w == b"top secret photos") {
                    leaked = true;
                }
            }
        }
        assert!(!leaked, "plaintext found inside the encrypted bundle");

        let mp = attach(&bundle, &keychain_get(&bundle).await.unwrap()).await.unwrap();
        assert_eq!(std::fs::read_to_string(mp.join("secret.txt")).unwrap(), "top secret photos");
        detach(&mp).await;

        let _ = run("security", &["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", &bundle.to_string_lossy()], None).await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn walk(p: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let q = e.path();
                if q.is_dir() { out.extend(walk(&q)) } else { out.push(q) }
            }
        }
        out
    }

    fn req(serial: &str, dest: &Path, folders: Vec<String>, apps: Option<Vec<String>>) -> BackupRequest {
        BackupRequest { serial: serial.into(), device_name: "Test Phone".into(), dest_root: dest.to_string_lossy().into(), folders, include_apps: apps.is_some(), apps, verify: true, encrypt: false, password: None }
    }

    /// Real phone: `cargo test live_backup -- --ignored --nocapture --test-threads=1`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_backup_incremental_restore_cancel() {
        let serial = adb::list_devices().await.unwrap().into_iter().find(|d| d.state == adb::AdbState::Ready).expect("device").serial;
        let app = tauri::test::mock_app();
        let mgr = Arc::new(Manager::default());
        let state = Arc::new(BackupState::default());
        let tmp = std::env::temp_dir().join(format!("db-backup-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        // What is offered, and what's small enough to test with?
        let offered = folders(&serial).await.unwrap();
        println!("offered: {:?}", offered.iter().map(|f| format!("{}{}", f.label, if f.recommended { "*" } else { "" })).collect::<Vec<_>>());
        assert!(offered.iter().any(|f| f.path == "/sdcard/DCIM"));
        assert!(!offered.iter().any(|f| f.label == "Android"), "restricted Android folder is never offered");
        let mut small = None;
        for f in &offered {
            if let Ok(sz) = folder_size(&serial, &f.path).await {
                println!("  {:<28} {:>8.1} MB", f.label, sz as f64 / 1e6);
                if sz > 50_000 && sz < 60_000_000 && small.is_none() { small = Some((f.path.clone(), sz)); }
            }
        }
        let (folder, _) = small.expect("a small folder to test with");

        // The two smallest user apps.
        let mut apps = crate::apps::list(&serial).await.unwrap();
        apps.retain(|a| !a.system && a.app_size > 0);
        apps.sort_by_key(|a| a.app_size);
        let picked: Vec<String> = apps.iter().take(2).map(|a| a.package.clone()).collect();

        // 1. First backup.
        let r = req(&serial, &tmp, vec![folder.clone()], Some(picked.clone()));
        let s1 = run_backup(app.handle().clone(), mgr.clone(), state.clone(), r.clone()).await.unwrap();
        println!("backup #1: {} copied, {} skipped, {:.1} MB, {} apps, errors {:?}", s1.files_copied, s1.files_skipped, s1.bytes as f64 / 1e6, s1.apps, s1.errors);
        assert!(s1.errors.is_empty(), "{:?}", s1.errors);
        assert!(s1.files_copied > 0 && s1.apps == 2);
        let root = tmp.join(device_folder("Test Phone", &serial));
        let rel = rel_parent(&folder);
        let base = if rel.is_empty() { root.join("files") } else { root.join("files").join(&rel) };
        assert!(base.join(basename(&folder)).is_dir(), "mirror lives at files/<path relative to /sdcard>");
        assert!(root.join("backup.json").exists() && root.join("apps.json").exists());
        let c = contents(&root);
        assert_eq!(c.apps.len(), 2);
        assert!(c.apps.iter().all(|a| a.bytes > 0));

        // 2. Second backup: nothing changed → nothing copied.
        let s2 = run_backup(app.handle().clone(), mgr.clone(), state.clone(), r.clone()).await.unwrap();
        println!("backup #2: {} copied, {} skipped, {} bytes", s2.files_copied, s2.files_skipped, s2.bytes);
        assert_eq!((s2.files_copied, s2.bytes), (0, 0));
        assert!(s2.files_skipped >= s1.files_copied);

        // 3. A damaged / deleted backup file is repaired on the next run; extra files are never deleted.
        let mirror = base.join(basename(&folder));
        let mut files: Vec<PathBuf> = vec![];
        fn collect(p: &Path, out: &mut Vec<PathBuf>) { if let Ok(rd) = std::fs::read_dir(p) { for e in rd.flatten() { let q = e.path(); if q.is_dir() { collect(&q, out) } else { out.push(q) } } } }
        collect(&mirror, &mut files);
        files.sort();
        std::fs::write(&files[0], b"damaged").unwrap(); // size changes → must be re-copied
        if files.len() > 1 { std::fs::remove_file(&files[1]).unwrap(); }
        let extra = mirror.join("kept-after-phone-delete.txt");
        std::fs::write(&extra, "I was deleted from the phone but must survive").unwrap();
        let s3 = run_backup(app.handle().clone(), mgr.clone(), state.clone(), r.clone()).await.unwrap();
        println!("backup #3 (repair): {} copied", s3.files_copied);
        assert_eq!(s3.files_copied as usize, files.len().min(2));
        assert!(extra.exists(), "files that no longer exist on the phone stay in the backup");

        // 4. Restore into a scratch folder on the phone, then again (should skip).
        let scratch = "/sdcard/Download/db-restore-test";
        let _ = crate::fs::device_delete(&serial, &[scratch.to_string()]).await;
        crate::fs::device_mkdir(&serial, scratch).await.unwrap();
        let rel_dir = basename(&folder).to_string();
        let rreq = RestoreFilesRequest { serial: serial.clone(), root: root.to_string_lossy().into(), folders: vec![if rel.is_empty() { rel_dir.clone() } else { format!("{rel}/{rel_dir}") }], dest_base: scratch.into(), conflict: Conflict::Update };
        let mut t = restore_request(&rreq);
        t.verify = true;
        let id = mgr.start(app.handle().clone(), t.clone());
        let snap = mgr.wait(id).await.unwrap();
        println!("restore: {} files pushed, errors {:?}", snap.files_done, snap.errors);
        assert!(snap.errors.is_empty() && snap.files_done > 0);
        let restored = crate::fs::list_device(&serial, &format!("{scratch}/{}{}", if rel.is_empty() { String::new() } else { format!("{rel}/") }, rel_dir)).await.unwrap();
        assert!(!restored.is_empty());
        let id = mgr.start(app.handle().clone(), t);
        let snap2 = mgr.wait(id).await.unwrap();
        assert_eq!(snap2.files_done, 0, "second restore skips identical files");
        assert!(snap2.files_skipped > 0);
        let _ = crate::fs::device_delete(&serial, &[scratch.to_string()]).await;

        // 5. Restoring from a corrupt app folder fails politely instead of crashing.
        std::fs::create_dir_all(root.join("apps/bogus-1.0")).unwrap();
        std::fs::write(root.join("apps/bogus-1.0/base.apk"), "not an apk").unwrap();
        let out = restore_apps(&serial, &root, &["bogus-1.0".to_string()]).await;
        println!("bogus restore -> {:?}", out[0].message);
        assert!(!out[0].ok && !out[0].message.is_empty());

        // 6. Cancel mid-flight (all apps ≈ GBs): stops quickly, leaves no half-written files.
        let big = req(&serial, &tmp.join("cancel-test"), vec![], Some(vec![]));
        let mut big = big;
        big.apps = None;
        big.include_apps = true;
        big.verify = false;
        let (a2, m2, st2) = (app.handle().clone(), mgr.clone(), state.clone());
        let task = tokio::spawn(async move { run_backup(a2, m2, st2, big).await });
        tokio::time::sleep(std::time::Duration::from_millis(4000)).await;
        let t0 = std::time::Instant::now();
        cancel(&mgr, &state);
        let s = task.await.unwrap().unwrap();
        println!("cancelled after {:.1}s: canceled={} copied {}", t0.elapsed().as_secs_f64(), s.canceled, s.files_copied);
        assert!(s.canceled, "cancel flag set");
        assert!(t0.elapsed().as_secs() < 15);
        let mut left = vec![];
        collect(&tmp.join("cancel-test"), &mut left);
        assert!(!left.iter().any(|p| p.to_string_lossy().ends_with(".droidshuttle-part")), "no half-written files");

        // history was recorded; clean up the test rows so real history stays real
        let h = history(&serial).unwrap();
        assert!(h.iter().filter(|r| r.dest.contains("db-backup-")).count() >= 3);
        db().lock().unwrap().execute("DELETE FROM backups WHERE dest LIKE '%db-backup-%'", []).unwrap();
        std::fs::remove_dir_all(tmp).unwrap();
        assert!(!state.running.load(Ordering::SeqCst));
    }
}
