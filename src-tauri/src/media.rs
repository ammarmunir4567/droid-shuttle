//! Photo & video library: index the phone's MediaStore, make thumbnails, open originals.
//!
//! Thumbnails come from the files themselves (fast over USB); only videos use the phone's own
//! frame extractor, which is slow (~1.4 s each) but there are far fewer of them.

use crate::adb::{self, sync};
use crate::store::{cache_dir, db};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::sync::Semaphore;

const THUMB_PX: u32 = 360;
const EXIF_HEAD: usize = 256 * 1024;
/// Anything larger than this isn't decoded for a thumbnail (huge panoramas / raw files).
const MAX_DECODE_BYTES: u64 = 60 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: i64,
    pub path: String,
    pub kind: String, // "image" | "video"
    pub mime: String,
    pub size: u64,
    pub date_ms: i64,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub bucket: String,
    pub imported: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: i64,
    pub path: String,
    pub kind: &'static str,
    pub mime: String,
    pub size: Option<u64>,
    pub date_added: Option<i64>,
    pub date_modified: Option<i64>,
    pub date_taken_ms: Option<i64>,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub bucket: String,
}

// ---------- parsing `content query` output ----------

fn projection(video: bool) -> (String, Vec<&'static str>) {
    let mut keys = vec!["_id", "_size", "date_added", "date_modified", "datetaken", "mime_type", "bucket_display_name", "width", "height"];
    if video {
        keys.push("duration");
    }
    keys.push("_data"); // last: free text (paths can contain ", ")
    (keys.join(":"), keys)
}

/// `Row: 3 _id=1, _size=NULL, …, _data=/path/with, commas.jpg` → one `Row`.
pub fn parse_row(line: &str, keys: &[&str], kind: &'static str) -> Option<Row> {
    let rest = line.strip_prefix("Row: ")?.split_once(' ')?.1;
    let mut vals: HashMap<&str, &str> = HashMap::new();
    let mut cursor = 0;
    for (i, key) in keys.iter().enumerate() {
        let prefix = format!("{key}=");
        if !rest[cursor..].starts_with(&prefix) {
            return None;
        }
        let value_start = cursor + prefix.len();
        let end = match keys.get(i + 1) {
            Some(next) => value_start + rest[value_start..].find(&format!(", {next}="))?,
            None => rest.len(),
        };
        vals.insert(key, rest[value_start..end].trim_end_matches('\r'));
        cursor = if i + 1 < keys.len() { end + 2 } else { end };
    }
    let num = |k: &str| vals.get(k).filter(|v| **v != "NULL").and_then(|v| v.parse::<i64>().ok());
    let text = |k: &str| vals.get(k).filter(|v| **v != "NULL").map(|v| v.to_string());
    Some(Row {
        id: num("_id")?,
        path: text("_data")?,
        kind,
        mime: text("mime_type").unwrap_or_default(),
        size: num("_size").filter(|s| *s > 0).map(|s| s as u64),
        date_added: num("date_added"),
        date_modified: num("date_modified"),
        date_taken_ms: num("datetaken").filter(|d| *d > 0),
        width: num("width").unwrap_or(0).max(0) as u32,
        height: num("height").unwrap_or(0).max(0) as u32,
        duration_ms: num("duration").unwrap_or(0).max(0) as u64,
        bucket: text("bucket_display_name").unwrap_or_default(),
    })
}

pub fn parse_output(text: &str, video: bool) -> Vec<Row> {
    let (_, keys) = projection(video);
    let kind = if video { "video" } else { "image" };
    text.lines().filter_map(|l| parse_row(l, &keys, kind)).collect()
}

// ---------- scanning ----------

/// Re-read the phone's media library into the local index. Returns the number of items.
pub async fn scan(serial: &str) -> Result<usize, String> {
    let mut rows = Vec::new();
    for (video, table) in [(false, "images"), (true, "video")] {
        let (proj, _) = projection(video);
        let out = adb::exec(serial, &format!("content query --uri content://media/external/{table}/media --projection {proj}")).await.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out);
        if text.contains("Error while accessing provider") || text.contains("Exception") {
            return Err(format!("The phone refused the media query: {}", text.lines().next().unwrap_or("")));
        }
        rows.extend(parse_output(&text, video));
    }

    // Freshly added files can have no size/date yet — ask the file system.
    let sem = Arc::new(Semaphore::new(8));
    let mut set = tokio::task::JoinSet::new();
    for (i, r) in rows.iter().enumerate().filter(|(_, r)| r.size.is_none()) {
        let (sem, serial, path) = (sem.clone(), serial.to_string(), r.path.clone());
        set.spawn(async move {
            let _p = sem.acquire().await;
            (i, sync::stat(&serial, &path).await.ok().flatten())
        });
    }
    let mut stats: HashMap<usize, Option<sync::RawEntry>> = HashMap::new();
    while let Some(Ok((i, st))) = set.join_next().await {
        stats.insert(i, st);
    }
    let mut keep = Vec::with_capacity(rows.len());
    for (i, mut r) in rows.into_iter().enumerate() {
        if let Some(st) = stats.remove(&i) {
            match st {
                Some(st) => {
                    r.size = Some(st.size);
                    r.date_modified = r.date_modified.or(Some(st.mtime));
                }
                None => continue, // listed in MediaStore but gone from storage
            }
        }
        keep.push(r);
    }

    let serial = serial.to_string();
    let n = keep.len();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = db().lock().map_err(|e| e.to_string())?;
        let scan_id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(1);
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut up = tx
                .prepare(
                    "INSERT INTO media (serial, path, id, kind, mime, size, date_ms, width, height, duration_ms, bucket, scan)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                     ON CONFLICT (serial, path) DO UPDATE SET id=?3, kind=?4, mime=?5, size=?6, date_ms=?7, width=?8, height=?9, duration_ms=?10, bucket=?11, scan=?12",
                )
                .map_err(|e| e.to_string())?;
            for r in &keep {
                let date_ms = r.date_taken_ms.or(r.date_modified.map(|s| s * 1000)).or(r.date_added.map(|s| s * 1000)).unwrap_or(0);
                up.execute(params![serial, r.path, r.id, r.kind, r.mime, r.size.unwrap_or(0) as i64, date_ms, r.width, r.height, r.duration_ms as i64, r.bucket, scan_id])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.execute("DELETE FROM media WHERE serial = ?1 AND scan <> ?2", params![serial, scan_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(n)
}

pub fn list(serial: &str) -> Result<Vec<MediaItem>, String> {
    let conn = db().lock().map_err(|e| e.to_string())?;
    let mut st = conn
        .prepare(
            "SELECT m.id, m.path, m.kind, m.mime, m.size, m.date_ms, m.width, m.height, m.duration_ms, m.bucket, i.path IS NOT NULL
             FROM media m LEFT JOIN imports i ON i.serial = m.serial AND i.path = m.path AND i.size = m.size
             WHERE m.serial = ?1 ORDER BY m.date_ms DESC, m.id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([serial], |r| {
            Ok(MediaItem {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                mime: r.get(3)?,
                size: r.get::<_, i64>(4)? as u64,
                date_ms: r.get(5)?,
                width: r.get(6)?,
                height: r.get(7)?,
                duration_ms: r.get::<_, i64>(8)? as u64,
                bucket: r.get(9)?,
                imported: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Drop index rows for files that were deleted (e.g. "delete after import").
pub async fn forget_missing(serial: &str, paths: &[String]) {
    for p in paths {
        if matches!(sync::stat(serial, p).await, Ok(None)) {
            if let Ok(conn) = db().lock() {
                let _ = conn.execute("DELETE FROM media WHERE serial = ?1 AND path = ?2", params![serial, p]);
            }
        }
    }
}

// ---------- thumbnails ----------

fn key(path: &str, size: u64) -> String {
    let h = Sha256::digest(format!("{path}|{size}").as_bytes());
    sync::hex(&h[..8])
}

fn is_decodable(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "gif")
}

fn needs_sips(ext: &str) -> bool {
    matches!(ext, "heic" | "heif" | "dng" | "tif" | "tiff" | "bmp" | "avif" | "raw" | "arw" | "cr2" | "nef")
}

fn ext_of(p: &str) -> String {
    Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn pull_sem() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(6))
}

fn phone_thumb_sem() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(2)) // each one starts a JVM on the phone
}

fn orientation_of(bytes: &[u8]) -> u32 {
    exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()
        .and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)))
        .unwrap_or(1)
}

fn apply_orientation(img: image::DynamicImage, o: u32) -> image::DynamicImage {
    match o {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn save_jpeg(img: &image::DynamicImage, dst: &Path) -> Result<(), String> {
    let mut f = std::fs::File::create(dst).map_err(|e| e.to_string())?;
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 80).encode_image(&img.to_rgb8()).map_err(|e| e.to_string())
}

/// The ~160px JPEG most cameras embed in the EXIF header.
pub fn exif_thumbnail(head: &[u8]) -> Option<Vec<u8>> {
    let exif = exif::Reader::new().read_from_container(&mut Cursor::new(head)).ok()?;
    let off = exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?.value.get_uint(0)? as usize;
    let len = exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?.value.get_uint(0)? as usize;
    exif.buf().get(off..off.checked_add(len)?).map(|s| s.to_vec())
}

fn thumb_from_file(src: &Path, dst: &Path) -> Result<(), String> {
    let bytes = std::fs::read(src).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let t = apply_orientation(img.thumbnail(THUMB_PX, THUMB_PX), orientation_of(&bytes));
    save_jpeg(&t, dst)
}

async fn sips(src: &Path, dst: &Path, max_px: Option<u32>) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("sips");
    if let Some(px) = max_px {
        cmd.args(["-Z", &px.to_string()]);
    }
    let out = cmd.args(["-s", "format", "jpeg", "-s", "formatOptions", "80"]).arg(src).arg("--out").arg(dst).output().await.map_err(|e| e.to_string())?;
    if out.status.success() && dst.exists() { Ok(()) } else { Err("sips could not convert this file".into()) }
}

async fn phone_thumbnail(serial: &str, id: i64, kind: &str, dst: &Path) -> Result<(), String> {
    let _p = phone_thumb_sem().acquire().await.map_err(|e| e.to_string())?;
    let table = if kind == "video" { "video" } else { "images" };
    let bytes = adb::exec(serial, &format!("content read --uri content://media/external/{table}/media/{id}/thumbnail")).await.map_err(|e| e.to_string())?;
    if bytes.len() < 200 || !(bytes.starts_with(&[0xFF, 0xD8]) || bytes.starts_with(b"\x89PNG")) {
        return Err("the phone has no thumbnail for this item".into());
    }
    tokio::fs::write(dst, bytes).await.map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbReq {
    pub id: i64,
    pub path: String,
    pub kind: String,
    pub size: u64,
}

/// `fast` = just the embedded EXIF preview (instant, low-res); otherwise a proper 360px thumbnail.
pub async fn thumbnail(serial: &str, req: &ThumbReq, fast: bool) -> Result<PathBuf, String> {
    let dir = cache_dir().join("thumbs").join(serial);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let k = key(&req.path, req.size);
    let (full, lo) = (dir.join(format!("{k}.jpg")), dir.join(format!("{k}.lo.jpg")));
    if full.exists() {
        return Ok(full);
    }
    let ext = ext_of(&req.path);

    if fast {
        if lo.exists() {
            return Ok(lo);
        }
        if req.kind != "image" || ext == "png" || req.size < 1_200_000 {
            return Err("no fast preview".into()); // small files are cheap to do properly
        }
        let _p = pull_sem().acquire().await.map_err(|e| e.to_string())?;
        let head = sync::pull_prefix(serial, &req.path, EXIF_HEAD).await.map_err(|e| e.to_string())?;
        let thumb = exif_thumbnail(&head).ok_or("no embedded preview")?;
        let o = orientation_of(&head);
        let img = image::load_from_memory(&thumb).map_err(|e| e.to_string())?;
        let tmp = lo.with_extension("part");
        save_jpeg(&apply_orientation(img, o), &tmp)?;
        tokio::fs::rename(&tmp, &lo).await.map_err(|e| e.to_string())?;
        return Ok(lo);
    }

    let tmp = full.with_extension("part");
    let result: Result<(), String> = async {
        if req.kind == "video" {
            return phone_thumbnail(serial, req.id, "video", &tmp).await;
        }
        let local_src = dir.join(format!("{k}.src"));
        if req.size > MAX_DECODE_BYTES {
            return phone_thumbnail(serial, req.id, "image", &tmp).await;
        }
        let pulled = {
            let _p = pull_sem().acquire().await.map_err(|e| e.to_string())?;
            let (_o, ctl) = crate::transfer::ctl::channel();
            sync::pull(serial, &req.path, &local_src, &ctl, |_| {}).await.map_err(|e| e.to_string())
        };
        let made = match pulled {
            Ok(_) if needs_sips(&ext) => sips(&local_src, &tmp, Some(THUMB_PX)).await,
            Ok(_) if is_decodable(&ext) => {
                let (s, d) = (local_src.clone(), tmp.clone());
                tokio::task::spawn_blocking(move || thumb_from_file(&s, &d)).await.map_err(|e| e.to_string())?
            }
            Ok(_) => Err("unsupported format".into()),
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_file(&local_src).await;
        match made {
            Ok(()) => Ok(()),
            Err(_) => phone_thumbnail(serial, req.id, "image", &tmp).await, // last resort
        }
    }
    .await;
    match result {
        Ok(()) => {
            tokio::fs::rename(&tmp, &full).await.map_err(|e| e.to_string())?;
            let _ = tokio::fs::remove_file(&lo).await;
            Ok(full)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e)
        }
    }
}

// ---------- originals (viewer) ----------

/// Local, browser-displayable copy of a photo (HEIC/DNG/… are converted to JPEG).
pub async fn open_image(serial: &str, path: &str, size: u64) -> Result<PathBuf, String> {
    let dir = cache_dir().join("originals").join(serial);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let name = format!("{}_{}", key(path, size), path.rsplit('/').next().unwrap_or("image"));
    let local = dir.join(&name);
    let ext = ext_of(path);
    let shown = if needs_sips(&ext) { local.with_extension("view.jpg") } else { local.clone() };
    if shown.exists() {
        return Ok(shown);
    }
    if !local.exists() {
        let part = local.with_extension(format!("{ext}.part"));
        let (_o, ctl) = crate::transfer::ctl::channel();
        let _p = pull_sem().acquire().await.map_err(|e| e.to_string())?;
        sync::pull(serial, path, &part, &ctl, |_| {}).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(&part, &local).await.map_err(|e| e.to_string())?;
    }
    if needs_sips(&ext) {
        sips(&local, &shown, None).await?;
    }
    Ok(shown)
}

/// Local copy of a video for the viewer. Uses the transfer engine so progress shows in the tray.
pub async fn open_video<R: tauri::Runtime>(app: tauri::AppHandle<R>, mgr: Arc<crate::transfer::Manager>, serial: &str, path: &str, size: u64) -> Result<PathBuf, String> {
    let dir = cache_dir().join("originals").join(serial);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let name = format!("{}_{}", key(path, size), path.rsplit('/').next().unwrap_or("video"));
    let local = dir.join(&name);
    if tokio::fs::metadata(&local).await.map(|m| m.len() == size).unwrap_or(false) {
        return Ok(local);
    }
    let id = mgr.start(
        app,
        crate::transfer::TransferRequest {
            serial: serial.to_string(),
            direction: crate::transfer::Direction::Pull,
            sources: vec![path.to_string()],
            dest_dir: dir.to_string_lossy().into_owned(),
            conflict: crate::transfer::Conflict::Replace,
            verify: false,
            delete_source: false,
            dest_name: Some(name),
            subdirs: None,
            record_import: false, silent: false, label: None,
        },
    );
    let snap = mgr.wait(id).await.ok_or("transfer vanished")?;
    if let Some(e) = snap.errors.first() {
        return Err(e.clone());
    }
    if snap.status != crate::transfer::Status::Done {
        return Err("canceled".into());
    }
    Ok(local)
}

/// Delete cached originals beyond `cap` bytes, oldest first.
pub fn prune_originals(cap: u64) {
    let root = cache_dir().join("originals");
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<(std::time::SystemTime, u64, PathBuf)>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                match e.metadata() {
                    Ok(m) if m.is_dir() => walk(&p, out),
                    Ok(m) => out.push((m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), p)),
                    _ => {}
                }
            }
        }
    }
    walk(&root, &mut files);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort();
    for (_, len, p) in files {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(p).is_ok() {
            total -= len;
        }
    }
}

// ---------- EXIF details ----------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub taken: Option<String>,
    pub exposure: Option<String>,
    pub aperture: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub software: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

fn gps_coord(exif: &exif::Exif, tag: exif::Tag, ref_tag: exif::Tag) -> Option<f64> {
    let f = exif.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Rational(v) = &f.value else { return None };
    if v.len() < 3 {
        return None;
    }
    let deg = v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0;
    let r = exif.get_field(ref_tag, exif::In::PRIMARY)?.display_value().to_string();
    Some(if r.contains('S') || r.contains('W') { -deg } else { deg })
}

pub fn info_from_head(head: &[u8]) -> MediaInfo {
    let Ok(exif) = exif::Reader::new().read_from_container(&mut Cursor::new(head)) else { return MediaInfo::default() };
    let get = |t: exif::Tag| exif.get_field(t, exif::In::PRIMARY).map(|f| f.display_value().with_unit(&exif).to_string().trim_matches('"').trim().to_string()).filter(|s| !s.is_empty());
    let make = get(exif::Tag::Make);
    let model = get(exif::Tag::Model);
    let camera = match (make, model) {
        (Some(a), Some(b)) if b.starts_with(&a) => Some(b),
        (Some(a), Some(b)) => Some(format!("{a} {b}")),
        (a, b) => a.or(b),
    };
    MediaInfo {
        camera,
        lens: get(exif::Tag::LensModel),
        taken: get(exif::Tag::DateTimeOriginal),
        exposure: get(exif::Tag::ExposureTime),
        aperture: get(exif::Tag::FNumber),
        iso: get(exif::Tag::PhotographicSensitivity),
        focal_length: get(exif::Tag::FocalLength),
        software: get(exif::Tag::Software),
        latitude: gps_coord(&exif, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef),
        longitude: gps_coord(&exif, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef),
    }
}

pub async fn info(serial: &str, path: &str) -> Result<MediaInfo, String> {
    let head = sync::pull_prefix(serial, path, EXIF_HEAD).await.map_err(|e| e.to_string())?;
    Ok(info_from_head(&head))
}

// ---------- importing ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub path: String,
    pub bucket: String,
    pub date_ms: i64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Organize {
    Flat,
    Album,
    Month,
}

/// Civil date (UTC) for a unix timestamp — enough for folder names, no date crate needed.
pub fn year_month(ms: i64) -> (i64, u32) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32)
}

fn safe_component(s: &str) -> String {
    let c: String = s.chars().map(|c| if c == '/' || c == ':' || c.is_control() { '_' } else { c }).collect();
    let c = c.trim().trim_start_matches('.').to_string();
    if c.is_empty() { "Other".into() } else { c }
}

pub fn subdirs_for(items: &[ImportItem], organize: Organize) -> HashMap<String, String> {
    items
        .iter()
        .map(|i| {
            let sub = match organize {
                Organize::Flat => String::new(),
                Organize::Album => safe_component(&i.bucket),
                Organize::Month => {
                    let (y, m) = year_month(i.date_ms);
                    format!("{y}/{m:02}")
                }
            };
            (i.path.clone(), sub)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEYS_IMG: &[&str] = &["_id", "_size", "date_added", "date_modified", "datetaken", "mime_type", "bucket_display_name", "width", "height", "_data"];

    #[test]
    fn parses_rows_with_nulls_and_awkward_names() {
        let line = "Row: 0 _id=44969, _size=NULL, date_added=1791112497, date_modified=NULL, datetaken=NULL, mime_type=image/jpeg, bucket_display_name=Camera, width=NULL, height=NULL, _data=/storage/emulated/0/DCIM/Camera/20260412_021849 (2).jpg";
        let r = parse_row(line, KEYS_IMG, "image").unwrap();
        assert_eq!((r.id, r.size, r.date_modified, r.date_taken_ms), (44969, None, None, None));
        assert_eq!((r.bucket.as_str(), r.date_added), ("Camera", Some(1791112497)));

        let tricky = "Row: 7 _id=5, _size=1024, date_added=1, date_modified=2, datetaken=1700000000123, mime_type=image/jpeg, bucket_display_name=Trips, 2026, width=900, height=1600, _data=/sdcard/Pictures/a, b, _data=odd.jpg";
        let r = parse_row(tricky, KEYS_IMG, "image").unwrap();
        assert_eq!((r.bucket.as_str(), r.width, r.height), ("Trips, 2026", 900, 1600));
        assert_eq!(r.path, "/sdcard/Pictures/a, b, _data=odd.jpg");
        assert_eq!((r.size, r.date_taken_ms), (Some(1024), Some(1700000000123)));
    }

    #[test]
    fn parses_video_duration_and_skips_garbage() {
        let (_, keys) = projection(true);
        let out = "Row: 0 _id=9, _size=10, date_added=1, date_modified=2, datetaken=NULL, mime_type=video/mp4, bucket_display_name=WhatsApp Video, width=1024, height=576, duration=39833, _data=/x/v.mp4\nnoise line\n";
        let rows = parse_output(out, true);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].duration_ms, rows[0].kind), (39833, "video"));
        assert!(parse_row("not a row", &keys, "video").is_none());
    }

    #[test]
    fn year_month_matches_known_dates() {
        assert_eq!(year_month(1_700_000_000_000), (2023, 11)); // 2023-11-14
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(951_782_400_000), (2000, 2)); // 2000-02-29
    }

    #[test]
    fn organizes_into_subfolders() {
        let items = vec![ImportItem { path: "/a.jpg".into(), bucket: "Camera/Roll".into(), date_ms: 1_700_000_000_000 }];
        assert_eq!(subdirs_for(&items, Organize::Month)["/a.jpg"], "2023/11");
        assert_eq!(subdirs_for(&items, Organize::Album)["/a.jpg"], "Camera_Roll");
        assert_eq!(subdirs_for(&items, Organize::Flat)["/a.jpg"], "");
    }

    #[test]
    fn index_roundtrip_and_import_ledger() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::init(&conn).unwrap();
        conn.execute("INSERT INTO media (serial,path,id,kind,mime,size,date_ms) VALUES ('s','/a.jpg',1,'image','image/jpeg',100,5)", []).unwrap();
        conn.execute("INSERT INTO imports (serial,path,size,dest,at_ms) VALUES ('s','/a.jpg',100,'/d',1)", []).unwrap();
        let imported: bool = conn
            .query_row("SELECT i.path IS NOT NULL FROM media m LEFT JOIN imports i ON i.serial=m.serial AND i.path=m.path AND i.size=m.size", [], |r| r.get(0))
            .unwrap();
        assert!(imported);
        conn.execute("UPDATE media SET size = 200", []).unwrap(); // file changed on the phone → counts as new again
        let imported: bool = conn
            .query_row("SELECT i.path IS NOT NULL FROM media m LEFT JOIN imports i ON i.serial=m.serial AND i.path=m.path AND i.size=m.size", [], |r| r.get(0))
            .unwrap();
        assert!(!imported);
    }

    /// A JPEG with a hand-built EXIF block: orientation, camera, GPS and an embedded thumbnail.
    fn jpeg_with_exif() -> Vec<u8> {
        use exif::{experimental::Writer, Field, In, Rational, Tag, Value};
        let enc = |w: u32, h: u32| {
            let mut out = Vec::new();
            let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(w, h, image::Rgb([200, 40, 40])));
            image::codecs::jpeg::JpegEncoder::new(&mut out).encode_image(&img.to_rgb8()).unwrap();
            out
        };
        let (thumb, main) = (enc(16, 12), enc(64, 48));
        let fields = vec![
            Field { tag: Tag::Orientation, ifd_num: In::PRIMARY, value: Value::Short(vec![6]) },
            Field { tag: Tag::Make, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"Acme".to_vec()]) },
            Field { tag: Tag::Model, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"Cam 1".to_vec()]) },
            Field { tag: Tag::GPSLatitudeRef, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"N".to_vec()]) },
            Field { tag: Tag::GPSLatitude, ifd_num: In::PRIMARY, value: Value::Rational(vec![Rational { num: 40, denom: 1 }, Rational { num: 30, denom: 1 }, Rational { num: 0, denom: 1 }]) },
            Field { tag: Tag::GPSLongitudeRef, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"W".to_vec()]) },
            Field { tag: Tag::GPSLongitude, ifd_num: In::PRIMARY, value: Value::Rational(vec![Rational { num: 74, denom: 1 }, Rational { num: 0, denom: 1 }, Rational { num: 0, denom: 1 }]) },
        ];
        let mut w = Writer::new();
        for f in &fields {
            w.push_field(f);
        }
        w.set_jpeg(&thumb, In::THUMBNAIL);
        let mut tiff = Cursor::new(Vec::new());
        w.write(&mut tiff, false).unwrap();
        let tiff = tiff.into_inner();
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(&tiff);
        out.extend_from_slice(&main[2..]); // everything after the main JPEG's own SOI
        out
    }

    #[test]
    fn reads_exif_preview_orientation_camera_and_gps() {
        let jpeg = jpeg_with_exif();
        // Only the first few KB are ever fetched from the phone — prove a truncated head still works.
        let head = &jpeg[..jpeg.len().min(4096)];

        let thumb = exif_thumbnail(head).expect("embedded preview");
        let t = image::load_from_memory(&thumb).unwrap();
        assert_eq!((t.width(), t.height()), (16, 12));

        let o = orientation_of(head);
        assert_eq!(o, 6);
        let upright = apply_orientation(t, o);
        assert_eq!((upright.width(), upright.height()), (12, 16), "rotated to portrait");

        let info = info_from_head(head);
        assert_eq!(info.camera.as_deref(), Some("Acme Cam 1"));
        assert!((info.latitude.unwrap() - 40.5).abs() < 1e-9);
        assert!((info.longitude.unwrap() + 74.0).abs() < 1e-9, "west is negative: {:?}", info.longitude);
    }

    #[test]
    fn plain_jpeg_without_exif_degrades_gracefully() {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut out).encode_image(&image::RgbImage::new(8, 8)).unwrap();
        assert!(exif_thumbnail(&out).is_none());
        assert_eq!(orientation_of(&out), 1);
        assert!(info_from_head(&out).camera.is_none());
    }

    /// Against a real phone: `cargo test live_gallery -- --ignored --nocapture --test-threads=1`
    #[tokio::test]
    #[ignore]
    async fn live_gallery_pipeline() {
        let serial = crate::adb::list_devices().await.unwrap().into_iter().find(|d| d.state == crate::adb::AdbState::Ready).expect("device").serial;
        let t = std::time::Instant::now();
        let n = scan(&serial).await.unwrap();
        let items = list(&serial).unwrap();
        println!("scan: {n} items in {:.1}s; list = {}", t.elapsed().as_secs_f64(), items.len());
        assert!(n > 0 && items.len() == n);
        assert!(items.windows(2).all(|w| w[0].date_ms >= w[1].date_ms), "newest first");
        assert!(items.iter().all(|i| i.size > 0), "sizes filled in");
        let albums: std::collections::BTreeSet<_> = items.iter().map(|i| i.bucket.clone()).collect();
        println!("albums: {albums:?}");

        let req = |i: &MediaItem| ThumbReq { id: i.id, path: i.path.clone(), kind: i.kind.clone(), size: i.size };
        let small = items.iter().find(|i| i.kind == "image" && i.size < 1_000_000).expect("small image");
        let big = items.iter().find(|i| i.kind == "image" && i.size > 1_500_000);
        let video = items.iter().filter(|i| i.kind == "video").min_by_key(|i| i.size);

        let t = std::time::Instant::now();
        let p = thumbnail(&serial, &req(small), false).await.unwrap();
        let img = image::open(&p).unwrap();
        println!("small image thumb {}x{} in {:.0}ms", img.width(), img.height(), t.elapsed().as_millis());
        assert!(img.width().max(img.height()) <= THUMB_PX);

        if let Some(big) = big {
            let t = std::time::Instant::now();
            match thumbnail(&serial, &req(big), true).await {
                Ok(p) => println!("big image fast preview {:?} in {:.0}ms", image::image_dimensions(&p).unwrap(), t.elapsed().as_millis()),
                Err(e) => println!("big image has no fast preview: {e}"),
            }
            let t = std::time::Instant::now();
            let p = thumbnail(&serial, &req(big), false).await.unwrap();
            println!("big image ({} MB) full thumb {:?} in {:.0}ms", big.size / 1_000_000, image::image_dimensions(&p).unwrap(), t.elapsed().as_millis());
        } else {
            println!("(no photo > 1.5 MB on this phone)");
        }
        if let Some(v) = video {
            let t = std::time::Instant::now();
            let p = thumbnail(&serial, &req(v), false).await.unwrap();
            println!("video thumb {:?} in {:.0}ms", image::image_dimensions(&p).unwrap(), t.elapsed().as_millis());
        }

        let local = open_image(&serial, &small.path, small.size).await.unwrap();
        assert_eq!(std::fs::metadata(&local).unwrap().len(), small.size);
        let info = info(&serial, &small.path).await.unwrap();
        println!("exif: {info:?}");

        // Import two items, organized by month, then check the ledger and cleanup.
        let app = tauri::test::mock_app();
        let mgr = Arc::new(crate::transfer::Manager::default());
        let dest = std::env::temp_dir().join(format!("db-gallery-{}", std::process::id()));
        let pick: Vec<&MediaItem> = items.iter().filter(|i| i.size < 3_000_000).take(2).collect();
        let imp: Vec<ImportItem> = pick.iter().map(|i| ImportItem { path: i.path.clone(), bucket: i.bucket.clone(), date_ms: i.date_ms }).collect();
        let id = mgr.start(
            app.handle().clone(),
            crate::transfer::TransferRequest {
                serial: serial.clone(), direction: crate::transfer::Direction::Pull, sources: imp.iter().map(|i| i.path.clone()).collect(),
                dest_dir: dest.to_string_lossy().into(), conflict: crate::transfer::Conflict::KeepBoth, verify: true, delete_source: false,
                dest_name: None, subdirs: Some(subdirs_for(&imp, Organize::Month)), record_import: true, silent: false, label: None,
            },
        );
        let snap = mgr.wait(id).await.unwrap();
        assert!(snap.errors.is_empty(), "{:?}", snap.errors);
        for (i, p) in pick.iter().zip(&imp) {
            let (y, m) = year_month(i.date_ms);
            let f = dest.join(format!("{y}/{m:02}")).join(p.path.rsplit('/').next().unwrap());
            assert_eq!(std::fs::metadata(&f).unwrap().len(), i.size, "{f:?}");
        }
        let after = list(&serial).unwrap();
        assert!(pick.iter().all(|p| after.iter().find(|a| a.path == p.path).unwrap().imported), "marked imported");
        assert_eq!(after.iter().filter(|a| a.imported).count(), 2.min(after.iter().filter(|a| a.imported).count()));
        // Clean up so the user's real "new only" state is untouched.
        { let c = db().lock().unwrap(); for p in &imp { c.execute("DELETE FROM imports WHERE serial=?1 AND path=?2", params![serial, p.path]).unwrap(); } }
        std::fs::remove_dir_all(dest).unwrap();
    }
}
