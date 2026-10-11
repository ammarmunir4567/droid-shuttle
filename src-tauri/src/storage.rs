//! Storage analyzer and duplicate finder.
//!
//! One streaming `find … -exec stat` over the phone builds an in-memory size tree (`Scan`). Everything the UI
//! then asks for — folder breakdowns, categories, the biggest files, duplicates — is answered from that tree
//! without touching the phone again, except hashing candidate duplicates.
//!
//! The scan is read-only. Deleting goes through the normal `device_delete` command and then `Scan::remove`
//! keeps the tree in step, so the numbers update without a rescan.

use crate::adb::{self, shell_quote, AdbError};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncReadExt;

/// Children shown per folder before the rest is folded into one “smaller items” tile.
const MAX_CHILDREN: usize = 300;

// ---------- categories ----------

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Images,
    Videos,
    Audio,
    Documents,
    Archives,
    Apps,
    Other,
}

impl Category {
    pub const ALL: [Category; 7] = [Self::Images, Self::Videos, Self::Audio, Self::Documents, Self::Archives, Self::Apps, Self::Other];

    fn idx(self) -> usize {
        Self::ALL.iter().position(|c| *c == self).unwrap()
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.id() == s)
    }
    pub fn id(self) -> &'static str {
        match self {
            Self::Images => "images",
            Self::Videos => "videos",
            Self::Audio => "audio",
            Self::Documents => "documents",
            Self::Archives => "archives",
            Self::Apps => "apps",
            Self::Other => "other",
        }
    }
}

pub fn category_of(name: &str) -> Category {
    let ext = match name.rsplit_once('.') {
        Some((stem, e)) if !stem.is_empty() => e.to_ascii_lowercase(),
        _ => return Category::Other,
    };
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "heif" | "bmp" | "dng" | "raw" | "cr2" | "nef" | "arw" | "avif" => Category::Images,
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "3gp" | "m4v" | "mpg" | "mpeg" => Category::Videos,
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" | "amr" | "wma" => Category::Audio,
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "odt" | "csv" | "epub" | "md" => Category::Documents,
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "tgz" => Category::Archives,
        "apk" | "xapk" | "apks" | "aab" => Category::Apps,
        _ => Category::Other,
    }
}

// ---------- the tree ----------

struct FileRec {
    dir: u32,
    name: String,
    size: u64,
    mtime: i64,
}

struct DirRec {
    name: String,
    parent: Option<u32>,
    size: u64,
    files: u64,
    dirs: HashMap<String, u32>,
    file_ids: Vec<u32>,
    /// Bytes below this folder per `Category::ALL` entry, so a folder can be coloured by what it mostly holds.
    cats: [u64; 7],
}

pub struct Scan {
    root: String,
    dirs: Vec<DirRec>,
    files: Vec<Option<FileRec>>, // `None` once removed
    pub finished_ms: u64,
    pub took_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    /// Empty for the folded “smaller items” tile.
    pub path: String,
    pub size: u64,
    /// Files inside (1 for a file).
    pub files: u64,
    pub is_dir: bool,
    /// A file's kind; for a folder, the kind that takes the most space inside it.
    pub category: Option<Category>,
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotal {
    pub id: &'static str,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: i64,
    pub category: Category,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub root: String,
    pub total_bytes: u64,
    pub total_files: u64,
    pub categories: Vec<CategoryTotal>,
    pub finished_ms: u64,
    pub took_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Scan {
    pub fn new(root: &str) -> Self {
        let root = root.trim_end_matches('/').to_string();
        let name = root.rsplit('/').next().unwrap_or("").to_string();
        Self { root, dirs: vec![DirRec { name, parent: None, size: 0, files: 0, dirs: HashMap::new(), file_ids: vec![], cats: [0; 7] }], files: vec![], finished_ms: 0, took_ms: 0 }
    }

    /// Add one `size mtime path` line as printed by `stat -c '%s %Y %n'`. Anything else (errors, blanks) is ignored.
    pub fn add_line(&mut self, line: &str) -> bool {
        let mut it = line.splitn(3, ' ');
        let (Some(size), Some(mtime), Some(path)) = (it.next(), it.next(), it.next()) else { return false };
        let (Ok(size), Ok(mtime)) = (size.parse::<u64>(), mtime.parse::<i64>()) else { return false };
        let Some(rel) = path.strip_prefix(self.root.as_str()).and_then(|r| r.strip_prefix('/')) else { return false };
        let mut parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
        let Some(name) = parts.pop() else { return false };
        let mut cur = 0u32;
        for part in parts {
            cur = match self.dirs[cur as usize].dirs.get(part) {
                Some(&i) => i,
                None => {
                    let i = self.dirs.len() as u32;
                    self.dirs.push(DirRec { name: part.to_string(), parent: Some(cur), size: 0, files: 0, dirs: HashMap::new(), file_ids: vec![], cats: [0; 7] });
                    self.dirs[cur as usize].dirs.insert(part.to_string(), i);
                    i
                }
            };
        }
        let id = self.files.len() as u32;
        self.files.push(Some(FileRec { dir: cur, name: name.to_string(), size, mtime }));
        self.dirs[cur as usize].file_ids.push(id);
        let mut cats = [0i128; 7];
        cats[category_of(name).idx()] = size as i128;
        self.bump(cur, size as i128, 1, cats);
        true
    }

    fn bump(&mut self, mut dir: u32, size: i128, files: i64, cats: [i128; 7]) {
        loop {
            let d = &mut self.dirs[dir as usize];
            d.size = (d.size as i128 + size).max(0) as u64;
            d.files = (d.files as i64 + files).max(0) as u64;
            for (c, delta) in d.cats.iter_mut().zip(cats) {
                *c = (*c as i128 + delta).max(0) as u64;
            }
            match d.parent {
                Some(p) => dir = p,
                None => break,
            }
        }
    }

    pub fn total_bytes(&self) -> u64 {
        self.dirs[0].size
    }
    pub fn total_files(&self) -> u64 {
        self.dirs[0].files
    }

    fn dir_path(&self, mut i: u32) -> String {
        let mut parts = Vec::new();
        while let Some(p) = self.dirs[i as usize].parent {
            parts.push(self.dirs[i as usize].name.as_str());
            i = p;
        }
        parts.reverse();
        if parts.is_empty() { self.root.clone() } else { format!("{}/{}", self.root, parts.join("/")) }
    }

    fn file_path(&self, f: &FileRec) -> String {
        format!("{}/{}", self.dir_path(f.dir), f.name)
    }

    fn find_dir(&self, path: &str) -> Option<u32> {
        let rel = path.trim_end_matches('/').strip_prefix(self.root.as_str())?;
        let mut cur = 0u32;
        for part in rel.split('/').filter(|p| !p.is_empty()) {
            cur = *self.dirs[cur as usize].dirs.get(part)?;
        }
        Some(cur)
    }

    fn item(&self, f: &FileRec) -> FileItem {
        FileItem { path: self.file_path(f), name: f.name.clone(), size: f.size, mtime: f.mtime, category: category_of(&f.name) }
    }

    /// Biggest-first contents of a folder, capped; the remainder is folded into one tile so sizes still add up.
    pub fn children(&self, path: &str) -> Option<Vec<TreeNode>> {
        let d = self.find_dir(path)?;
        let dir = &self.dirs[d as usize];
        let base = self.dir_path(d);
        let mut out: Vec<TreeNode> = dir
            .dirs
            .values()
            .map(|&i| {
                let c = &self.dirs[i as usize];
                let dominant = (0..7).max_by_key(|&k| c.cats[k]).filter(|&k| c.cats[k] > 0).map(|k| Category::ALL[k]);
                TreeNode { name: c.name.clone(), path: format!("{base}/{}", c.name), size: c.size, files: c.files, is_dir: true, category: dominant, mtime: 0 }
            })
            .filter(|n| n.files > 0)
            .collect();
        out.extend(dir.file_ids.iter().filter_map(|&i| self.files[i as usize].as_ref()).map(|f| TreeNode {
            name: f.name.clone(),
            path: format!("{base}/{}", f.name),
            size: f.size,
            files: 1,
            is_dir: false,
            category: Some(category_of(&f.name)),
            mtime: f.mtime,
        }));
        out.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
        if out.len() > MAX_CHILDREN {
            let rest = out.split_off(MAX_CHILDREN);
            out.push(TreeNode {
                name: format!("{} smaller items", rest.len()),
                path: String::new(),
                size: rest.iter().map(|n| n.size).sum(),
                files: rest.iter().map(|n| n.files).sum(),
                is_dir: false,
                category: None,
                mtime: 0,
            });
        }
        Some(out)
    }

    pub fn categories(&self) -> Vec<CategoryTotal> {
        let mut totals: HashMap<Category, (u64, u64)> = HashMap::new();
        for f in self.files.iter().flatten() {
            let e = totals.entry(category_of(&f.name)).or_default();
            e.0 += f.size;
            e.1 += 1;
        }
        let mut v: Vec<CategoryTotal> = Category::ALL.iter().map(|c| CategoryTotal { id: c.id(), bytes: totals.get(c).map_or(0, |t| t.0), files: totals.get(c).map_or(0, |t| t.1) }).collect();
        v.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        v
    }

    pub fn summary(&self) -> Summary {
        Summary { root: self.root.clone(), total_bytes: self.total_bytes(), total_files: self.total_files(), categories: self.categories(), finished_ms: self.finished_ms, took_ms: self.took_ms }
    }

    /// Largest files, optionally of one category and at least `min_size` bytes.
    pub fn largest(&self, category: Option<Category>, min_size: u64, limit: usize) -> Vec<FileItem> {
        let mut v: Vec<&FileRec> = self.files.iter().flatten().filter(|f| f.size >= min_size && category.is_none_or(|c| category_of(&f.name) == c)).collect();
        v.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
        v.into_iter().take(limit).map(|f| self.item(f)).collect()
    }

    /// Files sharing a size with at least one other file: the only ones that can be duplicates.
    pub fn same_size_groups(&self, min_size: u64) -> Vec<Vec<FileItem>> {
        let mut by_size: HashMap<u64, Vec<&FileRec>> = HashMap::new();
        for f in self.files.iter().flatten().filter(|f| f.size >= min_size.max(1)) {
            by_size.entry(f.size).or_default().push(f);
        }
        let mut groups: Vec<Vec<FileItem>> = by_size
            .into_values()
            .filter(|g| g.len() > 1)
            .map(|g| {
                let mut items: Vec<FileItem> = g.into_iter().map(|f| self.item(f)).collect();
                items.sort_by(|a, b| a.mtime.cmp(&b.mtime).then_with(|| a.path.cmp(&b.path)));
                items
            })
            .collect();
        groups.sort_by(|a, b| (b[0].size * b.len() as u64).cmp(&(a[0].size * a.len() as u64)).then_with(|| a[0].path.cmp(&b[0].path)));
        groups
    }

    /// Forget deleted files/folders so every number stays right without a rescan.
    pub fn remove(&mut self, path: &str) {
        let path = path.trim_end_matches('/');
        if let Some(d) = self.find_dir(path).filter(|&d| d != 0) {
            let (size, files, parent, name, cats) = {
                let r = &self.dirs[d as usize];
                (r.size, r.files, r.parent.unwrap(), r.name.clone(), r.cats.map(|c| -(c as i128)))
            };
            // Tombstone every file below, then cut the folder off its parent.
            let mut stack = vec![d];
            while let Some(i) = stack.pop() {
                let ids = std::mem::take(&mut self.dirs[i as usize].file_ids);
                for id in ids {
                    self.files[id as usize] = None;
                }
                stack.extend(self.dirs[i as usize].dirs.values().copied());
                self.dirs[i as usize].dirs.clear();
                self.dirs[i as usize].size = 0;
                self.dirs[i as usize].files = 0;
                self.dirs[i as usize].cats = [0; 7];
            }
            self.dirs[parent as usize].dirs.remove(&name);
            self.bump(parent, -(size as i128), -(files as i64), cats);
            return;
        }
        let Some((dir_path, name)) = path.rsplit_once('/') else { return };
        let Some(d) = self.find_dir(dir_path) else { return };
        let hit = self.dirs[d as usize].file_ids.iter().position(|&id| self.files[id as usize].as_ref().is_some_and(|f| f.name == name));
        if let Some(pos) = hit {
            let id = self.dirs[d as usize].file_ids.remove(pos);
            if let Some(f) = self.files[id as usize].take() {
                let mut cats = [0i128; 7];
                cats[category_of(&f.name).idx()] = -(f.size as i128);
                self.bump(d, -(f.size as i128), -1, cats);
            }
        }
    }
}

// ---------- scanning the phone ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub files: u64,
    pub bytes: u64,
    /// Bytes to process in total, when known (hashing).
    pub total: u64,
}

/// Stream `find … stat` output into a `Scan`. `cancel` is checked between chunks.
pub async fn scan_device(serial: &str, root: &str, cancel: &AtomicBool, mut on_progress: impl FnMut(Progress)) -> Result<Scan, AdbError> {
    let started = Instant::now();
    let root = root.trim_end_matches('/');
    let mut scan = Scan::new(root);
    let mut s = adb::connect().await?;
    adb::send(&mut s, &format!("host:transport:{serial}")).await?;
    // Trailing slash so a symlinked root such as /sdcard is followed; -type f ignores symlinks inside it.
    let cmd = format!("find {}/ -type f -exec stat -c '%s %Y %n' {{}} + 2>/dev/null", shell_quote(root));
    adb::send(&mut s, &format!("exec:{cmd}")).await?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut pending: Vec<u8> = Vec::new();
    let mut last_emit = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(AdbError::Cancelled);
        }
        let n = s.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        while let Some(nl) = pending.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&pending[..nl]).into_owned();
            pending.drain(..=nl);
            scan.add_line(line.trim_end_matches('\r'));
        }
        if last_emit.elapsed().as_millis() >= 200 {
            last_emit = Instant::now();
            on_progress(Progress { phase: "scan", files: scan.total_files(), bytes: scan.total_bytes(), total: 0 });
        }
    }
    if !pending.is_empty() {
        scan.add_line(String::from_utf8_lossy(&pending).trim_end());
    }
    scan.took_ms = started.elapsed().as_millis() as u64;
    scan.finished_ms = now_ms();
    on_progress(Progress { phase: "scan", files: scan.total_files(), bytes: scan.total_bytes(), total: 0 });
    Ok(scan)
}

// ---------- duplicates ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub size: u64,
    pub hash: String,
    /// Oldest first, so “keep the first” keeps the original.
    pub files: Vec<FileItem>,
}

impl DupGroup {
    /// Bytes freed by keeping one copy.
    pub fn wasted(&self) -> u64 {
        self.size * (self.files.len() as u64 - 1)
    }
}

/// Hashes files wherever they live. Real impl runs on the phone; tests use an in-memory one.
#[allow(async_fn_in_trait)]
pub trait Hasher {
    /// Hash of the first MiB of each file (cheap).
    async fn partial(&self, paths: &[String]) -> Result<HashMap<String, String>, AdbError>;
    /// Hash of the whole file.
    async fn full(&self, paths: &[String]) -> Result<HashMap<String, String>, AdbError>;
}

pub struct PhoneHasher<'a>(pub &'a str);

/// `hash  path` lines → map.
pub fn parse_hashes(out: &str) -> HashMap<String, String> {
    out.lines()
        .filter_map(|l| {
            let (h, p) = l.split_once("  ")?;
            (h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| (p.to_string(), h.to_string()))
        })
        .collect()
}

impl Hasher for PhoneHasher<'_> {
    async fn partial(&self, paths: &[String]) -> Result<HashMap<String, String>, AdbError> {
        let list = paths.iter().map(|p| shell_quote(p)).collect::<Vec<_>>().join(" ");
        let script = format!("for f in {list}; do echo \"$(head -c 1048576 \"$f\" | sha256sum | cut -d' ' -f1)  $f\"; done");
        Ok(parse_hashes(&adb::shell(self.0, &script).await?))
    }
    async fn full(&self, paths: &[String]) -> Result<HashMap<String, String>, AdbError> {
        let list = paths.iter().map(|p| shell_quote(p)).collect::<Vec<_>>().join(" ");
        Ok(parse_hashes(&adb::shell(self.0, &format!("sha256sum {list}")).await?))
    }
}

/// Split into batches that keep each shell command short and cancellation prompt.
fn batches(items: &[FileItem], max_files: usize, max_bytes: u64) -> Vec<Vec<String>> {
    let mut out = vec![];
    let (mut cur, mut bytes): (Vec<String>, u64) = (vec![], 0);
    for f in items {
        if !cur.is_empty() && (cur.len() >= max_files || bytes + f.size > max_bytes) {
            out.push(std::mem::take(&mut cur));
            bytes = 0;
        }
        bytes += f.size;
        cur.push(f.path.clone());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Confirm duplicates among same-size candidates: a cheap partial hash first, a full hash only for what still matches.
pub async fn find_duplicates(
    groups: Vec<Vec<FileItem>>,
    hasher: &impl Hasher,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(Progress),
) -> Result<Vec<DupGroup>, AdbError> {
    let total: u64 = groups.iter().flatten().map(|f| f.size).sum();
    let mut done = 0u64;
    let report = |phase: &'static str, done: u64, on: &mut dyn FnMut(Progress)| on(Progress { phase, files: 0, bytes: done, total });

    // Phase 1: first-MiB fingerprint; regroup by (size, fingerprint).
    let all: Vec<FileItem> = groups.iter().flatten().cloned().collect();
    let mut partial: HashMap<String, String> = HashMap::new();
    for batch in batches(&all, 100, 512 << 20) {
        if cancel.load(Ordering::SeqCst) {
            return Err(AdbError::Cancelled);
        }
        partial.extend(hasher.partial(&batch).await?);
        done += batch.len() as u64 * 1024 * 1024 / 8; // fingerprinting is cheap: count it as a small slice of the work
        report("fingerprint", done.min(total / 10), &mut on_progress);
    }
    let mut candidates: Vec<Vec<FileItem>> = vec![];
    for g in groups {
        let mut by_fp: HashMap<&str, Vec<FileItem>> = HashMap::new();
        for f in &g {
            if let Some(h) = partial.get(&f.path) {
                by_fp.entry(h.as_str()).or_default().push(f.clone());
            }
        }
        candidates.extend(by_fp.into_values().filter(|v| v.len() > 1));
    }

    // Phase 2: full hash of the survivors.
    let to_hash: Vec<FileItem> = candidates.iter().flatten().cloned().collect();
    let hash_total: u64 = to_hash.iter().map(|f| f.size).sum();
    let mut full: HashMap<String, String> = HashMap::new();
    let mut hashed = 0u64;
    let sizes: HashMap<&str, u64> = to_hash.iter().map(|f| (f.path.as_str(), f.size)).collect();
    for batch in batches(&to_hash, 40, 256 << 20) {
        if cancel.load(Ordering::SeqCst) {
            return Err(AdbError::Cancelled);
        }
        let got = hasher.full(&batch).await?;
        hashed += batch.iter().map(|p| sizes.get(p.as_str()).copied().unwrap_or(0)).sum::<u64>();
        full.extend(got);
        on_progress(Progress { phase: "hash", files: 0, bytes: hashed, total: hash_total });
    }

    let mut out: Vec<DupGroup> = vec![];
    for g in candidates {
        let mut by_hash: HashMap<&str, Vec<FileItem>> = HashMap::new();
        for f in &g {
            if let Some(h) = full.get(&f.path) {
                by_hash.entry(h.as_str()).or_default().push(f.clone());
            }
        }
        for (hash, files) in by_hash {
            if files.len() > 1 {
                out.push(DupGroup { size: files[0].size, hash: hash.to_string(), files });
            }
        }
    }
    out.sort_by(|a, b| b.wasted().cmp(&a.wasted()).then_with(|| a.files[0].path.cmp(&b.files[0].path)));
    Ok(out)
}

// ---------- shared state ----------

#[derive(Default)]
pub struct State {
    scans: Mutex<HashMap<String, Arc<Mutex<Scan>>>>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl State {
    /// Start a storage job: cancels whatever was running and returns the new job's cancel flag.
    pub fn begin(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(old) = self.cancel.lock().unwrap().replace(flag.clone()) {
            old.store(true, Ordering::SeqCst);
        }
        flag
    }
    pub fn cancel(&self) {
        if let Some(f) = self.cancel.lock().unwrap().as_ref() {
            f.store(true, Ordering::SeqCst);
        }
    }
    pub fn put(&self, serial: &str, scan: Scan) {
        self.scans.lock().unwrap().insert(serial.to_string(), Arc::new(Mutex::new(scan)));
    }
    pub fn get(&self, serial: &str) -> Option<Arc<Mutex<Scan>>> {
        self.scans.lock().unwrap().get(serial).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Scan {
        let mut s = Scan::new("/sdcard/");
        for l in [
            "3000000 1700000000 /sdcard/DCIM/Camera/IMG_1.jpg",
            "3000000 1700000100 /sdcard/DCIM/Camera/IMG_1 copy.jpg",
            "9000000 1700000200 /sdcard/DCIM/Camera/VID_1.mp4",
            "500 1700000300 /sdcard/Download/notes.txt",
            "70000000 1700000400 /sdcard/Download/big file (1).zip",
            "120 1700000500 /sdcard/.hidden",
            "stat: '/sdcard/Android/data/x': Permission denied",
            "",
        ] {
            s.add_line(l);
        }
        s
    }

    #[test]
    fn builds_totals_and_ignores_noise() {
        let s = sample();
        assert_eq!(s.total_files(), 6);
        assert_eq!(s.total_bytes(), 3_000_000 * 2 + 9_000_000 + 500 + 70_000_000 + 120);
        assert_eq!(s.summary().root, "/sdcard");
    }

    #[test]
    fn children_are_biggest_first_and_paths_with_spaces_survive() {
        let s = sample();
        let top = s.children("/sdcard").unwrap();
        assert_eq!(top.iter().map(|n| (n.name.as_str(), n.size, n.is_dir)).collect::<Vec<_>>(), vec![("Download", 70_000_500, true), ("DCIM", 15_000_000, true), (".hidden", 120, false)]);
        let dl = s.children("/sdcard/Download").unwrap();
        assert_eq!(dl[0].path, "/sdcard/Download/big file (1).zip");
        assert_eq!(dl[0].category, Some(Category::Archives));
        assert!(s.children("/sdcard/nope").is_none());
        // Folder sizes always equal the sum of their children.
        for n in s.children("/sdcard").unwrap().iter().filter(|n| n.is_dir) {
            assert_eq!(n.size, s.children(&n.path).unwrap().iter().map(|c| c.size).sum::<u64>());
        }
    }

    #[test]
    fn folders_are_labelled_with_what_takes_most_space_and_stay_right_after_deletes() {
        let mut s = sample();
        let kind = |s: &Scan, name: &str| s.children("/sdcard").unwrap().into_iter().find(|n| n.name == name).unwrap().category;
        assert_eq!(kind(&s, "DCIM"), Some(Category::Videos), "9 MB of video beats 6 MB of photos");
        assert_eq!(kind(&s, "Download"), Some(Category::Archives));
        assert_eq!(kind(&s, ".hidden"), Some(Category::Other), "a file reports its own kind");
        s.remove("/sdcard/DCIM/Camera/VID_1.mp4");
        assert_eq!(kind(&s, "DCIM"), Some(Category::Images));
        s.remove("/sdcard/Download");
        assert_eq!(s.children("/sdcard").unwrap().iter().filter(|n| n.is_dir).count(), 1);
        assert!(Scan::new("/sdcard").children("/sdcard").unwrap().is_empty());
    }

    #[test]
    fn crowded_folders_fold_the_tail_into_one_tile_without_losing_bytes() {
        let mut s = Scan::new("/sdcard");
        for i in 0..(MAX_CHILDREN + 50) {
            s.add_line(&format!("{} 1 /sdcard/f{i}.bin", 1000 + i));
        }
        let kids = s.children("/sdcard").unwrap();
        assert_eq!(kids.len(), MAX_CHILDREN + 1);
        let tail = kids.last().unwrap();
        assert_eq!((tail.path.as_str(), tail.name.as_str()), ("", "50 smaller items"));
        assert_eq!(kids.iter().map(|n| n.size).sum::<u64>(), s.total_bytes());
    }

    #[test]
    fn categories_and_largest() {
        let s = sample();
        let cats: HashMap<_, _> = s.categories().into_iter().map(|c| (c.id, (c.bytes, c.files))).collect();
        assert_eq!(cats["images"], (6_000_000, 2));
        assert_eq!(cats["videos"], (9_000_000, 1));
        assert_eq!(cats["archives"], (70_000_000, 1));
        assert_eq!(cats["documents"], (500, 1));
        assert_eq!(cats["other"], (120, 1)); // dot-file has no extension
        let big = s.largest(None, 0, 2);
        assert_eq!(big.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["big file (1).zip", "VID_1.mp4"]);
        assert_eq!(s.largest(Some(Category::Images), 0, 10).len(), 2);
        assert_eq!(s.largest(None, 10_000_000, 10).len(), 1);
        assert_eq!(category_of("Photo.JPG"), Category::Images);
        assert_eq!(category_of(".nomedia"), Category::Other);
        assert_eq!(category_of("noext"), Category::Other);
    }

    #[test]
    fn removing_files_and_folders_keeps_every_total_consistent() {
        let mut s = sample();
        s.remove("/sdcard/DCIM/Camera/IMG_1 copy.jpg");
        assert_eq!((s.total_files(), s.total_bytes()), (5, 3_000_000 + 9_000_000 + 500 + 70_000_000 + 120));
        assert_eq!(s.children("/sdcard/DCIM").unwrap()[0].size, 12_000_000);
        s.remove("/sdcard/DCIM");
        assert_eq!((s.total_files(), s.total_bytes()), (3, 70_000_620));
        assert!(s.children("/sdcard/DCIM").is_none());
        assert_eq!(s.categories().iter().find(|c| c.id == "images").unwrap().files, 0);
        assert!(s.largest(None, 0, 10).iter().all(|f| !f.path.contains("DCIM")));
        s.remove("/sdcard/never-existed"); // harmless
        s.remove("/sdcard"); // the root itself is never removed
        assert_eq!(s.total_files(), 3);
    }

    #[test]
    fn only_same_size_files_are_duplicate_candidates() {
        let s = sample();
        let g = s.same_size_groups(1);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["IMG_1.jpg", "IMG_1 copy.jpg"], "oldest first");
        assert!(s.same_size_groups(4_000_000).is_empty(), "min size filters small files out");
    }

    #[tokio::test]
    async fn scans_a_phone_over_adb_and_can_be_canceled() {
        let _g = crate::adb::fake::LOCK.lock().await;
        let phone = crate::adb::fake::start().await;
        phone.put("/sdcard/DCIM/a.jpg", vec![0; 3000]);
        phone.put("/sdcard/DCIM/b.jpg", vec![0; 2000]);
        phone.put("/sdcard/Download/My notes.txt", vec![0; 10]);
        phone.put("/storage/other/ignored.bin", vec![0; 99]);
        let mut seen = 0;
        let scan = scan_device(crate::adb::fake::SERIAL, "/sdcard", &AtomicBool::new(false), |p| seen = p.files).await.unwrap();
        assert_eq!((scan.total_files(), scan.total_bytes()), (3, 5010), "noise lines and other volumes are ignored");
        assert_eq!(seen, 3, "a final progress update reports the finished totals");
        assert_eq!(scan.children("/sdcard/Download").unwrap()[0].name, "My notes.txt");
        assert!(scan.finished_ms > 0);
        let r = scan_device(crate::adb::fake::SERIAL, "/sdcard", &AtomicBool::new(true), |_| {}).await;
        assert!(matches!(r, Err(AdbError::Cancelled)));
    }

    struct Mem(HashMap<String, (&'static str, &'static str)>); // path → (first-MiB hash, full hash)
    impl Hasher for Mem {
        async fn partial(&self, paths: &[String]) -> Result<HashMap<String, String>, AdbError> {
            Ok(paths.iter().map(|p| (p.clone(), self.0[p].0.to_string())).collect())
        }
        async fn full(&self, paths: &[String]) -> Result<HashMap<String, String>, AdbError> {
            Ok(paths.iter().map(|p| (p.clone(), self.0[p].1.to_string())).collect())
        }
    }

    fn item(path: &str, size: u64, mtime: i64) -> FileItem {
        FileItem { path: path.into(), name: path.rsplit('/').next().unwrap().into(), size, mtime, category: category_of(path) }
    }

    #[tokio::test]
    async fn duplicates_need_matching_content_not_just_size() {
        // a/b/c are the same size. a≡b fully. c shares a's first MiB but differs later; d is unrelated.
        let groups = vec![vec![item("/s/a.mp4", 5, 1), item("/s/b.mp4", 5, 2), item("/s/c.mp4", 5, 3)], vec![item("/s/d.bin", 9, 1), item("/s/e.bin", 9, 2)]];
        let mem = Mem(HashMap::from([
            ("/s/a.mp4".into(), ("p1", "F1")),
            ("/s/b.mp4".into(), ("p1", "F1")),
            ("/s/c.mp4".into(), ("p1", "F2")),
            ("/s/d.bin".into(), ("p2", "F3")),
            ("/s/e.bin".into(), ("p3", "F4")), // differs in the first MiB: never fully hashed
        ]));
        let mut phases = vec![];
        let out = find_duplicates(groups, &mem, &AtomicBool::new(false), |p| phases.push(p.phase)).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["a.mp4", "b.mp4"]);
        assert_eq!((out[0].size, out[0].wasted()), (5, 5));
        assert!(phases.contains(&"fingerprint") && phases.contains(&"hash"));
    }

    #[tokio::test]
    async fn canceling_stops_hashing() {
        let groups = vec![vec![item("/s/a", 5, 1), item("/s/b", 5, 2)]];
        let mem = Mem(HashMap::from([("/s/a".into(), ("p", "F")), ("/s/b".into(), ("p", "F"))]));
        let r = find_duplicates(groups, &mem, &AtomicBool::new(true), |_| {}).await;
        assert!(matches!(r, Err(AdbError::Cancelled)));
    }

    #[test]
    fn parses_sha256sum_output() {
        let h = "a".repeat(64);
        let m = parse_hashes(&format!("{h}  /sdcard/My Photos/a b.jpg\nsha256sum: /x: No such file\n{h}  /sdcard/c.jpg\n"));
        assert_eq!(m.len(), 2);
        assert_eq!(m["/sdcard/My Photos/a b.jpg"], h);
    }

    #[test]
    fn batches_respect_file_and_byte_limits() {
        let items: Vec<FileItem> = (0..5).map(|i| item(&format!("/s/{i}"), 100, 0)).collect();
        assert_eq!(batches(&items, 2, u64::MAX).iter().map(Vec::len).collect::<Vec<_>>(), vec![2, 2, 1]);
        assert_eq!(batches(&items, 100, 250).iter().map(Vec::len).collect::<Vec<_>>(), vec![2, 2, 1]);
        let huge = vec![item("/s/huge", 10_000, 0)];
        assert_eq!(batches(&huge, 10, 100).len(), 1, "an oversize file still gets its own batch");
    }
}
