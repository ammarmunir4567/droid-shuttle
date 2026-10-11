//! Transfer engine: queued jobs with parallel streams, pause/cancel, conflict
//! policies, atomic writes and optional SHA-256 verification.

pub mod ctl;

use crate::adb::{self, shell_quote, shell_rc, sync, AdbError};
use crate::fs::{basename, join, parent};
use ctl::{Ctl, CtlOwner};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::{sync::Semaphore, task::JoinSet};

const PARALLEL_FILES: usize = 3;
/// Above this size we write to a temp name and rename, so an interrupted copy never leaves a truncated file.
const ATOMIC_PUSH_MIN: u64 = 16 * 1024 * 1024;
const PART_SUFFIX: &str = ".droidshuttle-part";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// Mac → phone.
    Push,
    /// Phone → Mac.
    Pull,
    DeviceCopy,
    DeviceMove,
    LocalCopy,
    LocalMove,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    Replace,
    Skip,
    KeepBoth,
    /// Backups: copy only files that are new or whose size/modified time differ.
    Update,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub serial: String,
    pub direction: Direction,
    pub sources: Vec<String>,
    pub dest_dir: String,
    pub conflict: Conflict,
    #[serde(default)]
    pub verify: bool,
    /// Delete sources after a successful Push/Pull (cross-device move).
    #[serde(default)]
    pub delete_source: bool,
    /// Final name for a single-source transfer (Finder may rename a promised file).
    #[serde(default)]
    pub dest_name: Option<String>,
    /// Pull only: relative sub-folder (inside `dest_dir`) per source path, e.g. "2026/10".
    #[serde(default)]
    pub subdirs: Option<HashMap<String, String>>,
    /// Pull only: remember each successfully copied file so "import new only" can skip it later.
    #[serde(default)]
    pub record_import: bool,
    /// Internal housekeeping (e.g. staging files for the clipboard): no "Finished" toast, and the
    /// row clears itself from the transfers bar.
    #[serde(default)]
    pub silent: bool,
    /// Name shown in the transfers bar instead of the file name.
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Scanning,
    Running,
    Paused,
    /// The phone (or the adb server) went away; the job resumes by itself when it is back.
    Waiting,
    Done,
    Canceled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: u64,
    pub label: String,
    pub direction: Direction,
    pub status: Status,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub files_total: u64,
    pub files_done: u64,
    pub files_skipped: u64,
    pub current: Option<String>,
    pub speed_bps: f64,
    pub errors: Vec<String>,
    pub verified: u64,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
    pub silent: bool,
    /// How many times the phone dropped and the job carried on.
    pub reconnects: u32,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub active: usize,
    pub waiting: usize,
    pub bytes_total: u64,
    pub bytes_done: u64,
}

impl Summary {
    /// 0–100, or `None` while the total is still unknown.
    pub fn percent(&self) -> Option<u8> {
        (self.bytes_total > 0).then(|| (self.bytes_done * 100 / self.bytes_total).min(100) as u8)
    }
}

struct Job {
    owner: CtlOwner,
    snap: Mutex<Snapshot>,
    bytes: AtomicU64,
    /// File tasks currently waiting for the phone to come back.
    waiting: AtomicUsize,
}

#[derive(Default)]
pub struct Manager {
    next: AtomicU64,
    jobs: Mutex<HashMap<u64, Arc<Job>>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Item {
    src: String,
    dst: String,
    size: u64,
    mtime: i64,
}

#[derive(Default)]
struct Plan {
    dirs: Vec<String>,
    files: Vec<Item>,
    skipped: u64,
    errors: Vec<String>,
}

#[derive(Clone)]
enum Side {
    Device(String),
    Local,
}

/// Existence checks with a per-directory listing cache so big trees stay fast.
struct Exists {
    side: Side,
    /// dir → name → (size, mtime) for phone directories listed so far.
    cache: HashMap<String, HashMap<String, (u64, i64)>>,
}

/// Same size and a modified time within 2 s (FAT/MTP-era rounding) counts as "unchanged".
fn same_file(size_a: u64, mtime_a: i64, size_b: u64, mtime_b: i64) -> bool {
    size_a == size_b && (mtime_a - mtime_b).abs() <= 2
}

impl Exists {
    fn new(side: Side) -> Self {
        Self { side, cache: HashMap::new() }
    }
    async fn has(&mut self, path: &str) -> bool {
        match &self.side {
            Side::Local => Path::new(path).symlink_metadata().is_ok(),
            Side::Device(serial) => {
                let dir = parent(path);
                if !self.cache.contains_key(&dir) {
                    let names = sync::list(serial, &dir).await.map(|v| v.into_iter().map(|e| (e.name, (e.size, e.mtime))).collect()).unwrap_or_default();
                    self.cache.insert(dir.clone(), names);
                }
                self.cache[&dir].contains_key(basename(path))
            }
        }
    }
    fn remember(&mut self, path: &str) {
        if matches!(self.side, Side::Device(_)) {
            self.cache.entry(parent(path)).or_default().insert(basename(path).to_string(), (0, 0));
        }
    }
    /// `name (2).ext`, `name (3).ext`, … until free.
    async fn unique(&mut self, path: &str, is_dir: bool) -> String {
        let dir = parent(path);
        let name = basename(path);
        let (stem, ext) = match name.rfind('.') {
            Some(i) if !is_dir && i > 0 => (&name[..i], &name[i..]),
            _ => (name, ""),
        };
        for n in 2.. {
            let cand = join(&dir, &format!("{stem} ({n}){ext}"));
            if !self.has(&cand).await {
                return cand;
            }
        }
        unreachable!()
    }
    /// Apply the conflict policy to a *file* destination. `None` = skip it.
    async fn resolve_file(&mut self, dst: &str, policy: Conflict) -> Option<String> {
        if !self.has(dst).await {
            self.remember(dst);
            return Some(dst.to_string());
        }
        match policy {
            Conflict::Skip => None,
            Conflict::Replace | Conflict::Update => Some(dst.to_string()),
            Conflict::KeepBoth => {
                let u = self.unique(dst, false).await;
                self.remember(&u);
                Some(u)
            }
        }
    }
}

impl Exists {
    /// Like `resolve_file`, but knows the incoming file's size/mtime so `Update` can skip unchanged files.
    async fn resolve_file_with(&mut self, dst: &str, policy: Conflict, size: u64, mtime: i64) -> Option<String> {
        if policy == Conflict::Update && self.has(dst).await {
            let unchanged = match &self.side {
                Side::Local => std::fs::metadata(dst).ok().map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0))),
                Side::Device(_) => self.cache.get(&parent(dst)).and_then(|d| d.get(basename(dst))).copied(),
            }
            .map(|(s, m)| same_file(s, m, size, mtime))
            .unwrap_or(false);
            return if unchanged { None } else { Some(dst.to_string()) };
        }
        self.resolve_file(dst, policy).await
    }
}

/// Names (from `sources`) that already exist in `dest_dir`.
pub async fn check_conflicts(serial: &str, direction: Direction, sources: &[String], dest_dir: &str) -> Vec<String> {
    let side = match direction {
        Direction::Push | Direction::DeviceCopy | Direction::DeviceMove => Side::Device(serial.to_string()),
        _ => Side::Local,
    };
    let mut ex = Exists::new(side);
    let mut out = Vec::new();
    for s in sources {
        let name = basename(s);
        if ex.has(&join(dest_dir, name)).await {
            out.push(name.to_string());
        }
    }
    out
}

impl Manager {
    pub fn start<R: Runtime>(self: &Arc<Self>, app: AppHandle<R>, req: TransferRequest) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (owner, ctl) = ctl::channel();
        let label = req.label.clone().unwrap_or_else(|| match req.sources.as_slice() {
            [one] => basename(one).to_string(),
            many => format!("{} items", many.len()),
        });
        let silent = req.silent;
        let job = Arc::new(Job {
            owner,
            bytes: AtomicU64::new(0),
            waiting: AtomicUsize::new(0),
            snap: Mutex::new(Snapshot {
                id, label, direction: req.direction, status: Status::Scanning, bytes_total: 0, bytes_done: 0, files_total: 0,
                files_done: 0, files_skipped: 0, current: None, speed_bps: 0.0, errors: vec![], verified: 0, started_ms: now_ms(), finished_ms: None, silent, reconnects: 0,
            }),
        });
        self.jobs.lock().unwrap().insert(id, job.clone());
        tauri::async_runtime::spawn(run_job(app, job, ctl, req));
        id
    }

    fn get(&self, id: u64) -> Option<Arc<Job>> {
        self.jobs.lock().unwrap().get(&id).cloned()
    }

    /// Resolves once the job has finished (done or canceled).
    pub async fn wait(&self, id: u64) -> Option<Snapshot> {
        loop {
            let snap = self.get(id)?.snap.lock().unwrap().clone();
            if snap.finished_ms.is_some() {
                return Some(snap);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub fn cancel(&self, id: u64) {
        if let Some(j) = self.get(id) {
            j.owner.cancel();
        }
    }

    pub fn set_paused<R: Runtime>(&self, id: u64, paused: bool, app: &AppHandle<R>) {
        if let Some(j) = self.get(id) {
            j.owner.set_paused(paused);
            let mut s = j.snap.lock().unwrap();
            if matches!(s.status, Status::Running | Status::Paused) {
                s.status = if paused { Status::Paused } else { Status::Running };
                let _ = app.emit("transfer-update", &*s);
            }
        }
    }

    /// Aggregate of the visible, unfinished jobs (menu bar, Dock progress).
    pub fn summary(&self) -> Summary {
        let mut sum = Summary::default();
        for j in self.jobs.lock().unwrap().values() {
            let s = j.snap.lock().unwrap();
            if s.silent || s.finished_ms.is_some() {
                continue;
            }
            sum.active += 1;
            sum.waiting += (s.status == Status::Waiting) as usize;
            sum.bytes_total += s.bytes_total;
            sum.bytes_done += j.bytes.load(Ordering::Relaxed).min(s.bytes_total.max(1));
        }
        sum
    }

    /// Forget finished jobs older than the UI needs.
    pub fn clear_finished(&self) {
        self.jobs.lock().unwrap().retain(|_, j| j.snap.lock().unwrap().finished_ms.is_none());
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, job: &Job) {
    let mut s = job.snap.lock().unwrap();
    s.bytes_done = job.bytes.load(Ordering::Relaxed);
    let _ = app.emit("transfer-update", &*s);
}

// ---------- surviving an unplugged cable ----------

/// More than this many reconnects for one step means something else is wrong; give up with the error.
const MAX_RECONNECTS: u32 = 50;
/// Partial files smaller than this are simply restarted.
const MIN_RESUME: u64 = 1024 * 1024;

/// True when the error means the phone (or the adb server) went away, rather than that this file is bad.
/// Local I/O problems (disk full, permission denied) are deliberately not included: waiting would never fix them.
pub fn is_disconnect(e: &AdbError) -> bool {
    use std::io::ErrorKind as K;
    match e {
        AdbError::Io(io) => matches!(
            io.kind(),
            K::UnexpectedEof | K::ConnectionReset | K::ConnectionAborted | K::ConnectionRefused | K::BrokenPipe | K::NotConnected | K::TimedOut
        ),
        AdbError::Fail(m) => {
            let m = m.to_lowercase();
            (m.contains("device") && (m.contains("not found") || m.contains("offline"))) || m.contains("no devices") || m.contains("closed")
        }
        _ => false,
    }
}

/// Poll `probe` until it says the phone is back, or the job is cancelled.
async fn wait_for_device<F, Fut>(probe: F, ctl: &Ctl, every: Duration) -> Result<(), AdbError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    loop {
        if ctl.is_cancelled() {
            return Err(AdbError::Cancelled);
        }
        if probe().await {
            return Ok(());
        }
        tokio::time::sleep(every).await;
    }
}

async fn device_ready(serial: &str) -> bool {
    adb::list_devices().await.map(|l| l.iter().any(|d| d.serial == serial && d.state == adb::AdbState::Ready)).unwrap_or(false)
}

/// Park the job as "Waiting" until the phone is back (the adb server restarts itself when needed).
async fn reconnect<R: Runtime>(app: &AppHandle<R>, job: &Arc<Job>, ctl: &Ctl, serial: &str) -> Result<(), AdbError> {
    if job.waiting.fetch_add(1, Ordering::SeqCst) == 0 {
        job.snap.lock().unwrap().status = Status::Waiting;
        emit(app, job);
    }
    let r = wait_for_device(|| device_ready(serial), ctl, Duration::from_millis(1000)).await;
    if r.is_ok() {
        tokio::time::sleep(Duration::from_millis(400)).await; // let the transport settle
    }
    if job.waiting.fetch_sub(1, Ordering::SeqCst) == 1 {
        {
            let mut s = job.snap.lock().unwrap();
            if s.status == Status::Waiting {
                s.status = Status::Running;
                s.reconnects += 1;
            }
        }
        emit(app, job);
    }
    r
}

/// Run `step`; if the phone drops, wait for it and run it again.
async fn retry_on_disconnect<R, T, F, Fut>(app: &AppHandle<R>, job: &Arc<Job>, ctl: &Ctl, serial: &str, mut step: F) -> Result<T, AdbError>
where
    R: Runtime,
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, AdbError>>,
{
    let mut attempt = 0;
    loop {
        match step(attempt).await {
            Err(e) if is_disconnect(&e) && !ctl.is_cancelled() && attempt < MAX_RECONNECTS => {
                attempt += 1;
                reconnect(app, job, ctl, serial).await?;
            }
            other => return other,
        }
    }
}

/// Where a half-downloaded `.part` can be continued from (0 = start over). Only when the phone's file is unchanged.
async fn resumable_pull_offset(serial: &str, item: &Item, part: &str) -> u64 {
    let Ok(md) = tokio::fs::metadata(part).await else { return 0 };
    if md.len() < MIN_RESUME || md.len() >= item.size {
        return 0;
    }
    match sync::stat(serial, &item.src).await {
        Ok(Some(st)) if st.size == item.size && st.mtime == item.mtime => md.len(),
        _ => 0,
    }
}

/// Where a half-uploaded temp file on the phone can be continued from (0 = start over). Only when the Mac file is unchanged.
async fn resumable_push_offset(serial: &str, item: &Item, target: &str) -> u64 {
    match tokio::fs::metadata(&item.src).await {
        Ok(md) if md.len() == item.size => {}
        _ => return 0,
    }
    match sync::stat(serial, target).await {
        Ok(Some(st)) if st.size >= MIN_RESUME && st.size < item.size => st.size,
        _ => 0,
    }
}

async fn run_job<R: Runtime>(app: AppHandle<R>, job: Arc<Job>, ctl: Ctl, req: TransferRequest) {
    emit(&app, &job);
    let outcome = match req.direction {
        Direction::Pull | Direction::Push => run_streamed(&app, &job, &ctl, &req).await,
        _ => run_simple(&job, &ctl, &req).await,
    };
    let mut s = job.snap.lock().unwrap();
    if let Err(e) = outcome {
        if !matches!(e, AdbError::Cancelled) {
            s.errors.push(e.to_string());
        }
    }
    s.status = if ctl.is_cancelled() { Status::Canceled } else { Status::Done };
    s.bytes_done = job.bytes.load(Ordering::Relaxed);
    s.speed_bps = 0.0;
    s.current = None;
    s.finished_ms = Some(now_ms());
    let _ = app.emit("transfer-update", &*s);
}

// ---------- device↔Mac streaming transfers ----------

async fn run_streamed<R: Runtime>(app: &AppHandle<R>, job: &Arc<Job>, ctl: &Ctl, req: &TransferRequest) -> Result<(), AdbError> {
    let serial = req.serial.as_str();
    let plan = retry_on_disconnect(app, job, ctl, serial, |_| async {
        match req.direction {
            Direction::Pull => plan_pull(serial, req).await,
            _ => plan_push(serial, req).await,
        }
    })
    .await?;
    {
        let mut s = job.snap.lock().unwrap();
        s.bytes_total = plan.files.iter().map(|f| f.size).sum();
        s.files_total = plan.files.len() as u64;
        s.files_skipped = plan.skipped;
        s.errors.extend(plan.errors.clone());
        s.status = Status::Running;
    }
    emit(app, job);

    // Create destination folders first (empty folders included).
    match req.direction {
        Direction::Pull => {
            for d in &plan.dirs {
                tokio::fs::create_dir_all(d).await?;
            }
        }
        _ => {
            retry_on_disconnect(app, job, ctl, serial, |_| async {
                for chunk in plan.dirs.chunks(100) {
                    let args: Vec<String> = chunk.iter().map(|d| shell_quote(d)).collect();
                    shell_rc(serial, &format!("mkdir -p {}", args.join(" "))).await?;
                }
                Ok(())
            })
            .await?;
        }
    }

    // Progress ticker: ~10 Hz updates with a smoothed speed estimate.
    let ticker = {
        let (app, job) = (app.clone(), job.clone());
        tokio::spawn(async move {
            let (mut last_bytes, mut last, mut speed) = (0u64, Instant::now(), 0.0f64);
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let b = job.bytes.load(Ordering::Relaxed);
                let dt = last.elapsed().as_secs_f64();
                if dt > 0.0 {
                    let inst = (b - last_bytes) as f64 / dt;
                    speed = if speed == 0.0 { inst } else { speed * 0.8 + inst * 0.2 };
                }
                (last_bytes, last) = (b, Instant::now());
                {
                    let mut s = job.snap.lock().unwrap();
                    if s.finished_ms.is_some() {
                        break;
                    }
                    s.speed_bps = if s.status == Status::Paused { 0.0 } else { speed };
                }
                emit(&app, &job);
            }
        })
    };

    let sem = Arc::new(Semaphore::new(PARALLEL_FILES));
    let mut set = JoinSet::new();
    let delete_sources = req.delete_source;
    let done_srcs: Arc<Mutex<Vec<String>>> = Arc::default();
    for item in plan.files {
        if ctl.is_cancelled() {
            break;
        }
        let permit = sem.clone().acquire_owned().await.unwrap();
        let (job, ctl, serial, dir, verify, done_srcs, app) = (job.clone(), ctl.clone(), req.serial.clone(), req.direction, req.verify, done_srcs.clone(), app.clone());
        let record = req.record_import;
        set.spawn(async move {
            let _permit = permit;
            job.snap.lock().unwrap().current = Some(basename(&item.src).to_string());
            let res = retry_on_disconnect(&app, &job, &ctl, &serial, |attempt| {
                let counted = Arc::new(AtomicU64::new(0));
                let (job, ctl, item, serial) = (&job, &ctl, &item, &serial);
                async move {
                    let r = transfer_file(serial, dir, item, verify, ctl, job, &counted, attempt > 0).await;
                    if r.is_err() {
                        // The attempt's bytes are not on the destination any more (or will be re-credited by a resume).
                        job.bytes.fetch_sub(counted.load(Ordering::Relaxed), Ordering::Relaxed);
                    }
                    r
                }
            })
            .await;
            if matches!(res, Err(AdbError::Cancelled)) && dir == Direction::Pull {
                let _ = tokio::fs::remove_file(format!("{}{PART_SUFFIX}", item.dst)).await; // cancelled while waiting for the phone
            }
            let mut s = job.snap.lock().unwrap();
            match res {
                Ok(verified) => {
                    s.files_done += 1;
                    if verified {
                        s.verified += 1;
                    }
                    if delete_sources {
                        done_srcs.lock().unwrap().push(item.src.clone());
                    }
                    if record {
                        crate::store::record_import(&serial, &item.src, item.size, &item.dst);
                    }
                }
                Err(AdbError::Cancelled) => {}
                Err(e) => {
                    if s.errors.len() < 50 {
                        s.errors.push(format!("{}: {e}", basename(&item.src)));
                    }
                }
            }
        });
    }
    while set.join_next().await.is_some() {}
    ticker.abort();

    if delete_sources && !ctl.is_cancelled() {
        let srcs = done_srcs.lock().unwrap().clone();
        delete_moved_sources(serial, req, &srcs).await;
    }
    emit(app, job);
    Ok(())
}

/// After a successful cross-device move, remove the copied files, then any now-empty source folders.
async fn delete_moved_sources(serial: &str, req: &TransferRequest, files: &[String]) {
    match req.direction {
        Direction::Pull => {
            let _ = crate::fs::device_delete(serial, files).await;
            for top in &req.sources {
                // Only succeeds for folders that are now empty (find -depth removes deepest first).
                let _ = shell_rc(serial, &format!("find {} -depth -type d -empty -delete", shell_quote(top))).await;
            }
        }
        _ => {
            for f in files {
                let _ = tokio::fs::remove_file(f).await;
            }
            for top in &req.sources {
                let _ = remove_empty_dirs(top);
            }
        }
    }
}

fn remove_empty_dirs(dir: &str) -> std::io::Result<()> {
    let p = Path::new(dir);
    if !p.is_dir() {
        return Ok(());
    }
    for e in std::fs::read_dir(p)? {
        let e = e?;
        if e.file_type()?.is_dir() {
            remove_empty_dirs(&e.path().to_string_lossy())?;
        }
    }
    let _ = std::fs::remove_dir(p); // fails (harmlessly) if not empty
    Ok(())
}

/// Returns `Ok(true)` when the copy was checksum-verified.
/// `resume`: this is a retry after the phone dropped, so a partial file left by the last attempt may be continued.
#[allow(clippy::too_many_arguments)]
async fn transfer_file(serial: &str, dir: Direction, item: &Item, verify: bool, ctl: &Ctl, job: &Arc<Job>, counted: &AtomicU64, resume: bool) -> Result<bool, AdbError> {
    let on_bytes = |n: u64| {
        job.bytes.fetch_add(n, Ordering::Relaxed);
        counted.fetch_add(n, Ordering::Relaxed);
    };
    ctl.gate().await?;
    match dir {
        Direction::Pull => {
            if let Some(p) = Path::new(&item.dst).parent() {
                tokio::fs::create_dir_all(p).await?;
            }
            let part = format!("{}{PART_SUFFIX}", item.dst);
            let from = if resume { resumable_pull_offset(serial, item, &part).await } else { 0 };
            let res = if from > 0 {
                sync::pull_resume(serial, &item.src, Path::new(&part), from, item.size, ctl, on_bytes).await
            } else {
                sync::pull(serial, &item.src, Path::new(&part), ctl, on_bytes).await
            };
            let hash = match res {
                Ok(h) => h,
                Err(e) => {
                    if !is_disconnect(&e) {
                        let _ = tokio::fs::remove_file(&part).await; // keep it when the cable dropped: the retry continues from it
                    }
                    return Err(e);
                }
            };
            let mut verified = false;
            if verify {
                if let Some(remote) = remote_sha256(serial, &item.src).await {
                    if remote != hash {
                        let _ = tokio::fs::remove_file(&part).await;
                        return Err(AdbError::Fail("checksum mismatch — copy discarded".into()));
                    }
                    verified = true;
                }
            }
            if item.mtime > 0 {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&part) {
                    let _ = f.set_modified(UNIX_EPOCH + Duration::from_secs(item.mtime as u64));
                }
            }
            tokio::fs::rename(&part, &item.dst).await?;
            Ok(verified)
        }
        _ => {
            let atomic = item.size >= ATOMIC_PUSH_MIN;
            let target = if atomic { format!("{}{PART_SUFFIX}", item.dst) } else { item.dst.clone() };
            let mtime = if item.mtime > 0 { item.mtime as u32 } else { 0 };
            let from = if resume && atomic { resumable_push_offset(serial, item, &target).await } else { 0 };
            let res = if from > 0 {
                sync::push_resume(serial, Path::new(&item.src), &target, from, item.size, ctl, on_bytes).await
            } else {
                sync::push(serial, Path::new(&item.src), &target, 0o100664, mtime, ctl, on_bytes).await
            };
            let hash = match res {
                Ok(h) => h,
                Err(e) => {
                    if !is_disconnect(&e) {
                        let _ = shell_rc(serial, &format!("rm -f {}", shell_quote(&target))).await; // keep it when the cable dropped
                    }
                    return Err(e);
                }
            };
            if from > 0 && mtime > 0 {
                let _ = shell_rc(serial, &format!("touch -d @{mtime} {}", shell_quote(&target))).await; // resumed files lose the SEND mtime
            }
            if atomic {
                let (out, rc) = shell_rc(serial, &format!("mv -f {} {}", shell_quote(&target), shell_quote(&item.dst))).await?;
                if rc != 0 {
                    return Err(AdbError::Fail(out.trim().to_string()));
                }
            }
            let mut verified = false;
            if verify {
                if let Some(remote) = remote_sha256(serial, &item.dst).await {
                    if remote != hash {
                        let _ = shell_rc(serial, &format!("rm -f {}", shell_quote(&item.dst))).await;
                        return Err(AdbError::Fail("checksum mismatch — copy discarded".into()));
                    }
                    verified = true;
                }
            }
            Ok(verified)
        }
    }
}

async fn remote_sha256(serial: &str, path: &str) -> Option<String> {
    let (out, rc) = shell_rc(serial, &format!("sha256sum {}", shell_quote(path))).await.ok()?;
    let first = out.split_whitespace().next()?;
    (rc == 0 && first.len() == 64).then(|| first.to_string())
}

// ---------- planning ----------

async fn plan_pull(serial: &str, req: &TransferRequest) -> Result<Plan, AdbError> {
    let mut plan = Plan::default();
    let mut ex = Exists::new(Side::Local);
    for src in &req.sources {
        let Some(st) = sync::stat(serial, src).await? else {
            plan.errors.push(format!("{}: no longer exists", basename(src)));
            continue;
        };
        let top = req.dest_name.as_deref().filter(|_| req.sources.len() == 1).unwrap_or(basename(src));
        let base_dir = match req.subdirs.as_ref().and_then(|m| m.get(src)) {
            Some(sub) if !sub.is_empty() => join(&req.dest_dir, sub),
            _ => req.dest_dir.clone(),
        };
        let mut dst = join(&base_dir, top);
        if st.is_dir() {
            if ex.has(&dst).await && req.conflict == Conflict::KeepBoth {
                dst = ex.unique(&dst, true).await;
            }
            plan.dirs.push(dst.clone());
            let mut stack = vec![(src.clone(), dst)];
            while let Some((rdir, ldir)) = stack.pop() {
                for e in sync::list(serial, &rdir).await? {
                    let (rp, lp) = (join(&rdir, &e.name), join(&ldir, &e.name));
                    let e = if e.is_symlink() {
                        match sync::stat(serial, &rp).await? { Some(t) => t, None => continue }
                    } else { e };
                    if e.is_dir() {
                        plan.dirs.push(lp.clone());
                        stack.push((rp, lp));
                    } else if let Some(d) = ex.resolve_file_with(&lp, req.conflict, e.size, e.mtime).await {
                        plan.files.push(Item { src: rp, dst: d, size: e.size, mtime: e.mtime });
                    } else {
                        plan.skipped += 1;
                    }
                }
            }
        } else if let Some(d) = ex.resolve_file_with(&dst, req.conflict, st.size, st.mtime).await {
            plan.files.push(Item { src: src.clone(), dst: d, size: st.size, mtime: st.mtime });
        } else {
            plan.skipped += 1;
        }
    }
    Ok(plan)
}

fn walk_local(root: &Path, dst_root: &str, dirs: &mut Vec<String>, files: &mut Vec<(String, String, u64, i64)>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(md) = std::fs::metadata(e.path()) else { continue };
        let dst = join(dst_root, &name);
        if md.is_dir() {
            dirs.push(dst.clone());
            walk_local(&e.path(), &dst, dirs, files);
        } else {
            let mt = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
            files.push((e.path().to_string_lossy().into_owned(), dst, md.len(), mt));
        }
    }
}

async fn plan_push(serial: &str, req: &TransferRequest) -> Result<Plan, AdbError> {
    let mut plan = Plan::default();
    let mut ex = Exists::new(Side::Device(serial.to_string()));
    for src in &req.sources {
        let Ok(md) = std::fs::metadata(src) else {
            plan.errors.push(format!("{}: cannot read", basename(src)));
            continue;
        };
        let base_dir = match req.subdirs.as_ref().and_then(|m| m.get(src)) {
            Some(sub) if !sub.is_empty() => join(&req.dest_dir, sub),
            _ => req.dest_dir.clone(),
        };
        let mut dst = join(&base_dir, basename(src));
        let mut found: Vec<(String, String, u64, i64)> = Vec::new();
        if md.is_dir() {
            if ex.has(&dst).await && req.conflict == Conflict::KeepBoth {
                dst = ex.unique(&dst, true).await;
            }
            plan.dirs.push(dst.clone());
            let (root, droot) = (src.clone(), dst.clone());
            let mut dirs = Vec::new();
            let r = tokio::task::spawn_blocking(move || {
                let mut files = Vec::new();
                walk_local(Path::new(&root), &droot, &mut dirs, &mut files);
                (dirs, files)
            })
            .await
            .map_err(|e| AdbError::Fail(e.to_string()))?;
            plan.dirs.extend(r.0);
            found = r.1;
        } else {
            let mt = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
            found.push((src.clone(), dst, md.len(), mt));
        }
        for (s, d, size, mtime) in found {
            match ex.resolve_file_with(&d, req.conflict, size, mtime).await {
                Some(dst) => plan.files.push(Item { src: s, dst, size, mtime }),
                None => plan.skipped += 1,
            }
        }
    }
    Ok(plan)
}

// ---------- on-device and on-Mac copy/move (no streaming) ----------

async fn run_simple(job: &Arc<Job>, ctl: &Ctl, req: &TransferRequest) -> Result<(), AdbError> {
    let on_device = matches!(req.direction, Direction::DeviceCopy | Direction::DeviceMove);
    let is_move = matches!(req.direction, Direction::DeviceMove | Direction::LocalMove);
    let mut ex = Exists::new(if on_device { Side::Device(req.serial.clone()) } else { Side::Local });
    job.snap.lock().unwrap().files_total = req.sources.len() as u64;
    job.snap.lock().unwrap().status = Status::Running;

    for src in &req.sources {
        ctl.gate().await?;
        job.snap.lock().unwrap().current = Some(basename(src).to_string());
        let mut dst = join(&req.dest_dir, basename(src));
        if src.trim_end_matches('/') == dst.trim_end_matches('/') && !is_move {
            // Duplicate in place → always keep both.
            dst = ex.unique(&dst, false).await;
        } else if ex.has(&dst).await {
            match req.conflict {
                Conflict::Skip => {
                    job.snap.lock().unwrap().files_skipped += 1;
                    continue;
                }
                Conflict::KeepBoth => dst = ex.unique(&dst, false).await,
                Conflict::Replace | Conflict::Update => {}
            }
        }
        let result: Result<(), String> = if on_device {
            let verb = if is_move { "mv -f" } else { "cp -r" };
            // `cp -r a b` into an existing dir would nest; replace it explicitly.
            let pre = if req.conflict == Conflict::Replace && !is_move { format!("rm -rf {}; ", shell_quote(&dst)) } else { String::new() };
            shell_rc(&req.serial, &format!("{pre}{verb} {} {}", shell_quote(src), shell_quote(&dst)))
                .await
                .map_err(|e| e.to_string())
                .and_then(|(o, rc)| if rc == 0 { Ok(()) } else { Err(o.trim().to_string()) })
        } else {
            let (s, d) = (src.clone(), dst.clone());
            let replace = req.conflict == Conflict::Replace;
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                if replace && Path::new(&d).exists() {
                    if Path::new(&d).is_dir() { std::fs::remove_dir_all(&d) } else { std::fs::remove_file(&d) }.map_err(|e| e.to_string())?;
                }
                let status = std::process::Command::new(if is_move { "mv" } else { "cp" })
                    .args(if is_move { vec!["-f"] } else { vec!["-Rc"] }) // -c: APFS clone, instant + no extra space
                    .arg(&s)
                    .arg(&d)
                    .status()
                    .map_err(|e| e.to_string())?;
                status.success().then_some(()).ok_or_else(|| "copy failed".to_string())
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
        };
        let mut s = job.snap.lock().unwrap();
        match result {
            Ok(()) => s.files_done += 1,
            Err(e) => s.errors.push(format!("{}: {e}", basename(src))),
        }
    }
    Ok(())
}

/// Install an APK on the device (replace existing, allow downgrade of debuggable test builds not included).
pub async fn install_apk(serial: &str, apk: &str) -> Result<String, AdbError> {
    let bin = adb::adb_binary()?;
    let out = tokio::process::Command::new(bin).args(["-s", serial, "install", "-r", apk]).output().await?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() && text.contains("Success") {
        Ok("Installed".into())
    } else {
        Err(AdbError::Fail(text.trim().lines().last().unwrap_or("install failed").to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn keep_both_naming() {
        let dir = std::env::temp_dir().join(format!("db-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        std::fs::write(dir.join("a (2).txt"), "x").unwrap();
        let mut ex = Exists::new(Side::Local);
        let p = join(&dir.to_string_lossy(), "a.txt");
        assert!(ex.unique(&p, false).await.ends_with("a (3).txt"));
        assert_eq!(ex.resolve_file(&p, Conflict::Skip).await, None);
        assert_eq!(ex.resolve_file(&p, Conflict::Replace).await.as_deref(), Some(p.as_str()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    // ---------- unplugged-cable behaviour, against the in-process fake adb server ----------

    use crate::adb::fake;

    fn pseudo(n: usize) -> Vec<u8> {
        (0..n).map(|i| ((i as u64).wrapping_mul(2654435761) >> 13) as u8).collect()
    }

    fn fake_req(dir: Direction, source: &str, dest: &str) -> TransferRequest {
        TransferRequest { serial: fake::SERIAL.into(), direction: dir, sources: vec![source.into()], dest_dir: dest.into(), conflict: Conflict::Replace, verify: true, delete_source: false, dest_name: None, subdirs: None, record_import: false, silent: false, label: None }
    }

    #[test]
    fn only_connection_problems_count_as_disconnects() {
        use std::io::{Error, ErrorKind as K};
        for k in [K::UnexpectedEof, K::ConnectionReset, K::BrokenPipe, K::ConnectionRefused, K::TimedOut] {
            assert!(is_disconnect(&AdbError::Io(Error::from(k))), "{k:?}");
        }
        assert!(is_disconnect(&AdbError::Fail("device 'R8VYB0143NB' not found".into())));
        assert!(is_disconnect(&AdbError::Fail("device offline".into())));
        assert!(is_disconnect(&AdbError::Fail("no devices/emulators found".into())));
        // Problems on the Mac or with one file must fail fast instead of waiting forever.
        assert!(!is_disconnect(&AdbError::Io(Error::from(K::PermissionDenied))));
        assert!(!is_disconnect(&AdbError::Io(Error::from(K::StorageFull))));
        assert!(!is_disconnect(&AdbError::Fail("remote object '/sdcard/x' does not exist".into())));
        assert!(!is_disconnect(&AdbError::Cancelled));
    }

    #[tokio::test]
    async fn waiting_for_the_phone_ends_when_it_returns_or_the_job_is_cancelled() {
        let (_owner, ctl) = ctl::channel();
        let polls = AtomicU64::new(0);
        wait_for_device(|| async { polls.fetch_add(1, Ordering::SeqCst) >= 2 }, &ctl, Duration::from_millis(5)).await.unwrap();
        assert_eq!(polls.load(Ordering::SeqCst), 3);

        let (owner, ctl) = ctl::channel();
        owner.cancel();
        assert!(matches!(wait_for_device(|| async { false }, &ctl, Duration::from_millis(5)).await, Err(AdbError::Cancelled)));
    }

    #[tokio::test]
    async fn download_continues_from_the_partial_file_after_the_cable_is_pulled() {
        let _g = fake::LOCK.lock().await;
        let phone = fake::start().await;
        let data = pseudo(8 * 1024 * 1024);
        phone.put("/sdcard/big.bin", data.clone());
        *phone.drop_pull_after.lock().unwrap() = Some(3 * 1024 * 1024);
        phone.offline_ms.store(700, Ordering::SeqCst);

        let dest = std::env::temp_dir().join(format!("ds-resume-pull-{}", std::process::id()));
        std::fs::create_dir_all(&dest).unwrap();
        let app = tauri::test::mock_app();
        let snap = run_to_end(&Arc::new(Manager::default()), app.handle(), fake_req(Direction::Pull, "/sdcard/big.bin", &dest.to_string_lossy())).await;

        assert!(snap.errors.is_empty(), "{:?}", snap.errors);
        assert_eq!((snap.status, snap.files_done, snap.verified), (Status::Done, 1, 1));
        assert!(snap.reconnects >= 1, "the job should have waited for the phone");
        assert_eq!(snap.bytes_done, data.len() as u64, "progress must not double-count the resumed part");
        assert_eq!(std::fs::read(dest.join("big.bin")).unwrap(), data);
        assert!(!dest.join(format!("big.bin{PART_SUFFIX}")).exists());
        // One normal download that was cut, then one ranged continuation (not a restart from zero).
        assert_eq!((phone.recv.load(Ordering::SeqCst), phone.tail.load(Ordering::SeqCst)), (1, 1));
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[tokio::test]
    async fn upload_continues_from_the_partial_file_after_the_cable_is_pulled() {
        let _g = fake::LOCK.lock().await;
        let phone = fake::start().await;
        let data = pseudo(20 * 1024 * 1024); // over ATOMIC_PUSH_MIN, so it goes through a temp name
        *phone.drop_push_after.lock().unwrap() = Some(6 * 1024 * 1024);
        phone.offline_ms.store(700, Ordering::SeqCst);

        let src_dir = std::env::temp_dir().join(format!("ds-resume-push-{}", std::process::id()));
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("f.bin");
        std::fs::write(&src, &data).unwrap();
        let app = tauri::test::mock_app();
        let snap = run_to_end(&Arc::new(Manager::default()), app.handle(), fake_req(Direction::Push, &src.to_string_lossy(), "/sdcard/up")).await;

        assert!(snap.errors.is_empty(), "{:?}", snap.errors);
        assert_eq!((snap.status, snap.files_done, snap.verified), (Status::Done, 1, 1));
        assert!(snap.reconnects >= 1);
        assert_eq!(snap.bytes_done, data.len() as u64);
        assert_eq!(phone.get("/sdcard/up/f.bin").as_deref(), Some(data.as_slice()));
        assert!(phone.get(&format!("/sdcard/up/f.bin{PART_SUFFIX}")).is_none(), "temp file must be renamed away");
        assert_eq!((phone.send.load(Ordering::SeqCst), phone.cat.load(Ordering::SeqCst)), (1, 1));
        std::fs::remove_dir_all(src_dir).unwrap();
    }

    #[tokio::test]
    async fn canceling_while_waiting_for_the_phone_leaves_nothing_behind() {
        let _g = fake::LOCK.lock().await;
        let phone = fake::start().await;
        phone.put("/sdcard/big.bin", pseudo(8 * 1024 * 1024));
        *phone.drop_pull_after.lock().unwrap() = Some(3 * 1024 * 1024);
        phone.offline_ms.store(120_000, Ordering::SeqCst); // the phone does not come back

        let dest = std::env::temp_dir().join(format!("ds-resume-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dest).unwrap();
        let app = tauri::test::mock_app();
        let mgr = Arc::new(Manager::default());
        let id = mgr.start(app.handle().clone(), fake_req(Direction::Pull, "/sdcard/big.bin", &dest.to_string_lossy()));
        let mut waited = false;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if mgr.get(id).unwrap().snap.lock().unwrap().status == Status::Waiting {
                waited = true;
                break;
            }
        }
        assert!(waited, "job should report Waiting while the phone is gone");
        assert_eq!(mgr.summary().waiting, 1);
        mgr.cancel(id);
        let snap = tokio::time::timeout(Duration::from_secs(10), mgr.wait(id)).await.expect("cancel should end the wait").unwrap();
        assert_eq!(snap.status, Status::Canceled);
        assert!(std::fs::read_dir(&dest).unwrap().next().is_none(), "partial file should be removed");
        std::fs::remove_dir_all(dest).unwrap();
    }

    /// Needs a real phone: `cargo test live_ -- --ignored --nocapture --test-threads=1`.
    #[tokio::test]
    #[ignore]
    async fn live_push_list_pull_roundtrip() {
        let serial = crate::adb::list_devices().await.unwrap().into_iter().find(|d| d.state == crate::adb::AdbState::Ready).expect("device").serial;
        let remote_dir = "/sdcard/Download/droidshuttle-test";
        crate::fs::device_mkdir(&serial, remote_dir).await.unwrap();
        let tmp = std::env::temp_dir().join(format!("db-live-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        // 50 MB of pseudo-random bytes.
        let data: Vec<u8> = (0..50u64 * 1024 * 1024).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        let src = tmp.join("blob.bin");
        std::fs::write(&src, &data).unwrap();
        let (_o, ctl) = ctl::channel();

        let t = Instant::now();
        let h_push = sync::push(&serial, &src, &format!("{remote_dir}/blob.bin"), 0o100664, 1_700_000_000, &ctl, |_| {}).await.unwrap();
        let push_s = t.elapsed().as_secs_f64();

        let listing = crate::fs::list_device(&serial, remote_dir).await.unwrap();
        let e = listing.iter().find(|e| e.name == "blob.bin").expect("listed");
        assert_eq!(e.size, data.len() as u64);
        assert_eq!(e.mtime, 1_700_000_000);

        let back = tmp.join("back.bin");
        let t = Instant::now();
        let h_pull = sync::pull(&serial, &format!("{remote_dir}/blob.bin"), &back, &ctl, |_| {}).await.unwrap();
        let pull_s = t.elapsed().as_secs_f64();
        assert_eq!(h_push, h_pull);
        assert_eq!(std::fs::read(&back).unwrap(), data);
        assert_eq!(remote_sha256(&serial, &format!("{remote_dir}/blob.bin")).await.as_deref(), Some(h_push.as_str()));
        println!("push {:.1} MB/s, pull {:.1} MB/s", 50.0 / push_s, 50.0 / pull_s);

        crate::fs::device_delete(&serial, &[remote_dir.to_string()]).await.unwrap();
        assert!(sync::stat(&serial, remote_dir).await.unwrap().is_none());
        std::fs::remove_dir_all(tmp).unwrap();
    }

    async fn run_to_end(mgr: &Arc<Manager>, app: &tauri::AppHandle<tauri::test::MockRuntime>, req: TransferRequest) -> Snapshot {
        let id = mgr.start(app.clone(), req);
        for _ in 0..600 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let s = mgr.get(id).unwrap().snap.lock().unwrap().clone();
            if s.finished_ms.is_some() {
                return s;
            }
        }
        panic!("job did not finish");
    }

    fn tree_bytes(root: &Path) -> Vec<(String, Vec<u8>)> {
        fn rec(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
                if p.is_dir() { out.push((format!("{rel}/"), vec![])); rec(base, &p, out) } else { out.push((rel, std::fs::read(&p).unwrap())) }
            }
        }
        let mut v = vec![];
        rec(root, root, &mut v);
        v.sort();
        v
    }

    /// Whole engine against a real phone: push tree, conflicts, verify, pull, move, cancel.
    /// `cargo test live_engine -- --ignored --nocapture --test-threads=1`
    #[tokio::test]
    #[ignore]
    async fn live_engine_end_to_end() {
        let serial = crate::adb::list_devices().await.unwrap().into_iter().find(|d| d.state == crate::adb::AdbState::Ready).expect("device").serial;
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let mgr = Arc::new(Manager::default());
        let remote = "/sdcard/Download/db-e2e";
        let _ = crate::fs::device_delete(&serial, &[remote.to_string()]).await;
        crate::fs::device_mkdir(&serial, remote).await.unwrap();

        let tmp = std::env::temp_dir().join(format!("db-e2e-{}", std::process::id()));
        let tree = tmp.join("src_tree");
        std::fs::create_dir_all(tree.join("sub/deep")).unwrap();
        std::fs::create_dir_all(tree.join("empty_dir")).unwrap();
        std::fs::write(tree.join("a.txt"), "hello phone").unwrap();
        std::fs::write(tree.join("sub/b.bin"), (0..5_000_000u32).map(|i| (i % 251) as u8).collect::<Vec<_>>()).unwrap();
        std::fs::write(tree.join("sub/deep/c with space's.txt"), "quote ' test").unwrap();
        let req = |dir, sources: Vec<String>, dest: &str, conflict| TransferRequest { serial: serial.clone(), direction: dir, sources, dest_dir: dest.into(), conflict, verify: true, delete_source: false, dest_name: None, subdirs: None, record_import: false, silent: false, label: None };
        let src = tree.to_string_lossy().to_string();

        // 1. push a tree with verification
        let s = run_to_end(&mgr, &handle, req(Direction::Push, vec![src.clone()], remote, Conflict::KeepBoth)).await;
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert_eq!((s.files_done, s.verified), (3, 3));
        assert!(crate::fs::list_device(&serial, &format!("{remote}/src_tree")).await.unwrap().iter().any(|e| e.name == "empty_dir" && e.is_dir));

        // 2. same again with Skip → everything skipped
        let s = run_to_end(&mgr, &handle, req(Direction::Push, vec![src.clone()], remote, Conflict::Skip)).await;
        assert_eq!((s.files_done, s.files_skipped), (0, 3));

        // 3. KeepBoth on an existing folder → "src_tree (2)"
        let s = run_to_end(&mgr, &handle, req(Direction::Push, vec![src.clone()], remote, Conflict::KeepBoth)).await;
        assert_eq!(s.files_done, 3);
        assert!(sync::stat(&serial, &format!("{remote}/src_tree (2)/a.txt")).await.unwrap().is_some());

        // 4. pull back and compare byte for byte
        let out = tmp.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let s = run_to_end(&mgr, &handle, req(Direction::Pull, vec![format!("{remote}/src_tree")], &out.to_string_lossy(), Conflict::KeepBoth)).await;
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert_eq!(tree_bytes(&tree), tree_bytes(&out.join("src_tree")));
        assert!(!tree_bytes(&out).iter().any(|(n, _)| n.ends_with(PART_SUFFIX)));

        // 5. on-device copy (duplicate in place) and move
        let one = format!("{remote}/src_tree/a.txt");
        let s = run_to_end(&mgr, &handle, req(Direction::DeviceCopy, vec![one.clone()], &format!("{remote}/src_tree"), Conflict::KeepBoth)).await;
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert!(sync::stat(&serial, &format!("{remote}/src_tree/a (2).txt")).await.unwrap().is_some());
        let s = run_to_end(&mgr, &handle, req(Direction::DeviceMove, vec![one.clone()], remote, Conflict::Replace)).await;
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert!(sync::stat(&serial, &one).await.unwrap().is_none());
        assert!(sync::stat(&serial, &format!("{remote}/a.txt")).await.unwrap().is_some());

        // 6. cross-device move: pull with delete_source removes the phone copy
        let mut r = req(Direction::Pull, vec![format!("{remote}/src_tree (2)")], &out.to_string_lossy(), Conflict::KeepBoth);
        r.delete_source = true;
        let s = run_to_end(&mgr, &handle, r).await;
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert!(sync::stat(&serial, &format!("{remote}/src_tree (2)")).await.unwrap().is_none(), "source should be gone after move");
        assert!(out.join("src_tree (2)/sub/b.bin").exists());

        // 7. cancel mid-flight leaves no partial file behind
        let big = tmp.join("big.bin");
        std::fs::write(&big, vec![7u8; 150 * 1024 * 1024]).unwrap();
        let id = mgr.start(handle.clone(), req(Direction::Push, vec![big.to_string_lossy().into()], remote, Conflict::Replace));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        mgr.cancel(id);
        let mut st = Status::Running;
        for _ in 0..100 { tokio::time::sleep(Duration::from_millis(100)).await; let g = mgr.get(id).unwrap().snap.lock().unwrap().clone(); if g.finished_ms.is_some() { st = g.status; break; } }
        assert_eq!(st, Status::Canceled);
        let left = crate::fs::list_device(&serial, remote).await.unwrap();
        assert!(!left.iter().any(|e| e.name.starts_with("big.bin")), "partial upload left behind: {:?}", left.iter().map(|e| &e.name).collect::<Vec<_>>());

        crate::fs::device_delete(&serial, &[remote.to_string()]).await.unwrap();
        std::fs::remove_dir_all(tmp).unwrap();
    }

    /// Proves files over 4 GiB list and transfer correctly (u64 sizes). ~4 min; writes 4.2 GB then deletes it.
    /// `cargo test live_big_file -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_big_file_over_4gb() {
        let serial = crate::adb::list_devices().await.unwrap().into_iter().find(|d| d.state == crate::adb::AdbState::Ready).expect("device").serial;
        let remote = "/sdcard/Download/db-big";
        crate::fs::device_mkdir(&serial, remote).await.unwrap();
        let tmp = std::env::temp_dir().join(format!("db-big-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let big = tmp.join("huge.bin");
        let size: u64 = 4 * 1024 * 1024 * 1024 + 200 * 1024 * 1024;
        std::fs::File::create(&big).unwrap().set_len(size).unwrap(); // sparse
        let (_o, ctl) = ctl::channel();
        let sent = AtomicU64::new(0);
        let t = Instant::now();
        sync::push(&serial, &big, &format!("{remote}/huge.bin"), 0o100664, 0, &ctl, |n| { sent.fetch_add(n, Ordering::Relaxed); }).await.unwrap();
        println!("pushed {} bytes in {:.0}s", sent.load(Ordering::Relaxed), t.elapsed().as_secs_f64());
        let listed = crate::fs::list_device(&serial, remote).await.unwrap();
        let on_phone = listed.iter().find(|e| e.name == "huge.bin").expect("listed").size;
        let stat = sync::stat(&serial, &format!("{remote}/huge.bin")).await.unwrap().unwrap().size;
        crate::fs::device_delete(&serial, &[remote.to_string()]).await.unwrap();
        std::fs::remove_dir_all(tmp).unwrap();
        assert_eq!((on_phone, stat), (size, size));
    }

    /// ⌘C staging: phone file + folder land on the Mac as real, byte-identical files.
    /// `cargo test live_stage -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_stage_for_clipboard() {
        let serial = crate::adb::list_devices().await.unwrap().into_iter().find(|d| d.state == crate::adb::AdbState::Ready).expect("device").serial;
        let remote = "/sdcard/Download/db-stage";
        crate::fs::device_mkdir(&serial, &format!("{remote}/folder")).await.unwrap();
        let tmp = std::env::temp_dir().join(format!("db-stage-src-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("one.txt"), "first").unwrap();
        std::fs::write(tmp.join("two.txt"), "second").unwrap();
        let (_o, ctl) = ctl::channel();
        sync::push(&serial, &tmp.join("one.txt"), &format!("{remote}/one.txt"), 0o100664, 0, &ctl, |_| {}).await.unwrap();
        sync::push(&serial, &tmp.join("two.txt"), &format!("{remote}/folder/two.txt"), 0o100664, 0, &ctl, |_| {}).await.unwrap();

        let app = tauri::test::mock_app();
        let items = vec![
            crate::native_drag::DragItemSpec { path: format!("{remote}/one.txt"), is_dir: false },
            crate::native_drag::DragItemSpec { path: format!("{remote}/folder"), is_dir: true },
        ];
        let staged = crate::stage_items(app.handle().clone(), Arc::new(Manager::default()), serial.clone(), items).await.unwrap();
        assert_eq!(staged.len(), 2);
        assert_eq!(std::fs::read_to_string(&staged[0].path).unwrap(), "first");
        assert!(staged[1].is_dir);
        assert_eq!(std::fs::read_to_string(format!("{}/two.txt", staged[1].path)).unwrap(), "second");

        // A second stage replaces the first one's files.
        let again = crate::stage_items(app.handle().clone(), Arc::new(Manager::default()), serial.clone(), vec![crate::native_drag::DragItemSpec { path: format!("{remote}/one.txt"), is_dir: false }]).await.unwrap();
        assert!(!Path::new(&staged[0].path).exists() && Path::new(&again[0].path).exists());

        let _ = std::fs::remove_dir_all(crate::fs::local_home() + "/Library/Caches/ai.arqanum.droidshuttle/clipboard");
        crate::fs::device_delete(&serial, &[remote.to_string()]).await.unwrap();
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
