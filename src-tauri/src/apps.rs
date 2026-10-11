//! Installed-app manager: list, names & icons, details, install / uninstall / extract.
//!
//! Everything comes from stock Android tools over ADB (`pm`, `dumpsys`, `cmd`). App names and
//! icons live inside each APK, so we read just the needed pieces over a ranged connection
//! (`remote_zip`) instead of pulling whole packages, and cache the result.

use crate::adb::{self, shell_quote, shell_rc, sync};
use crate::remote_zip::RemoteFile;
use crate::store::{cache_dir, db};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub package: String,
    /// Human name once resolved from the APK; empty until then.
    pub label: String,
    pub icon: Option<String>,
    pub version_name: String,
    pub version_code: i64,
    pub target_sdk: u32,
    pub system: bool,
    /// Disabled by the user (or by default for some system apps).
    pub disabled: bool,
    pub first_install: String,
    pub last_update: String,
    pub installer: String,
    pub apk_path: String,
    pub app_size: u64,
    pub data_size: u64,
    pub cache_size: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppDetails {
    pub apk_paths: Vec<String>,
    pub granted: Vec<String>,
    pub denied: Vec<String>,
}

// ---------- parsing ----------

#[derive(Debug, Default, Clone, PartialEq)]
pub struct PkgRecord {
    pub version_name: String,
    pub version_code: i64,
    pub target_sdk: u32,
    pub system: bool,
    pub installed: bool,
    pub enabled_state: u8,
    pub first_install: String,
    pub last_update: String,
    pub installer: String,
}

/// Parse the `Packages:` section of `dumpsys package packages`.
pub fn parse_dumpsys_packages(text: &str) -> HashMap<String, PkgRecord> {
    let mut out = HashMap::new();
    let mut cur: Option<(String, PkgRecord)> = None;
    let mut flags_seen = false;
    for line in text.lines() {
        if !line.starts_with(' ') && !line.is_empty() && !line.starts_with("Packages:") {
            break; // next top-level section ("Hidden system packages:", …)
        }
        if let Some(rest) = line.strip_prefix("  Package [") {
            if let Some((n, r)) = cur.take() {
                out.insert(n, r);
            }
            flags_seen = false;
            let name = rest.split(']').next().unwrap_or("").to_string();
            cur = Some((name, PkgRecord { installed: true, ..Default::default() }));
            continue;
        }
        let Some((_, r)) = cur.as_mut() else { continue };
        let t = line.trim();
        if let Some(v) = t.strip_prefix("versionCode=") {
            let mut it = v.split_whitespace();
            r.version_code = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            r.target_sdk = it.find_map(|kv| kv.strip_prefix("targetSdk=")?.parse().ok()).unwrap_or(0);
        } else if let Some(v) = t.strip_prefix("versionName=") {
            r.version_name = v.to_string();
        } else if t.starts_with("flags=[") && !flags_seen {
            flags_seen = true;
            r.system = t.split_whitespace().any(|w| w == "SYSTEM");
        } else if let Some(v) = t.strip_prefix("lastUpdateTime=") {
            r.last_update = v.to_string();
        } else if let Some(v) = t.strip_prefix("firstInstallTime=") {
            if r.first_install.is_empty() {
                r.first_install = v.to_string();
            }
        } else if let Some(v) = t.strip_prefix("installerPackageName=") {
            r.installer = v.to_string();
        } else if t.starts_with("User 0:") {
            r.installed = !t.contains("installed=false");
            r.enabled_state = t.split_whitespace().find_map(|kv| kv.strip_prefix("enabled=")?.parse().ok()).unwrap_or(0);
        }
    }
    if let Some((n, r)) = cur {
        out.insert(n, r);
    }
    out
}

/// `package:/path/base.apk=com.pkg versionCode:123` → (package, apk path).
pub fn parse_pm_list(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let rest = l.trim().strip_prefix("package:")?;
            let (path, tail) = rest.rsplit_once('=')?;
            let pkg = tail.split_whitespace().next()?;
            Some((pkg.to_string(), path.to_string()))
        })
        .collect()
}

/// Per-package sizes from the JSON-ish arrays at the end of `dumpsys diskstats`.
pub fn parse_diskstats(text: &str) -> HashMap<String, (u64, u64, u64)> {
    let arr = |key: &str| -> Vec<serde_json::Value> {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key))
            .and_then(|rest| serde_json::from_str::<Vec<serde_json::Value>>(rest.trim()).ok())
            .unwrap_or_default()
    };
    let (names, app, data, cache) = (arr("Package Names: "), arr("App Sizes: "), arr("App Data Sizes: "), arr("Cache Sizes: "));
    let n = |v: &[serde_json::Value], i: usize| v.get(i).and_then(|x| x.as_u64()).unwrap_or(0);
    names.iter().enumerate().filter_map(|(i, p)| Some((p.as_str()?.to_string(), (n(&app, i), n(&data, i), n(&cache, i))))).collect()
}

/// Granted / denied permissions from a single package's `dumpsys package <pkg>`.
pub fn parse_permissions(text: &str) -> (Vec<String>, Vec<String>) {
    let (mut granted, mut denied) = (Vec::new(), Vec::new());
    let mut in_runtime = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("runtime permissions:") {
            in_runtime = true;
            continue;
        }
        if in_runtime {
            let Some((name, rest)) = t.split_once(": granted=") else {
                if !t.is_empty() && !t.contains(": granted=") && !line.starts_with("        ") {
                    in_runtime = false;
                }
                continue;
            };
            let short = name.strip_prefix("android.permission.").unwrap_or(name).to_string();
            if rest.starts_with("true") { granted.push(short) } else { denied.push(short) }
        }
    }
    (granted, denied)
}

// ---------- listing ----------

fn icon_path(serial: &str, package: &str, version_code: i64) -> PathBuf {
    cache_dir().join("icons").join(serial).join(format!("{package}_{version_code}.png"))
}

pub async fn list(serial: &str) -> Result<Vec<AppInfo>, String> {
    let (dump, pm, disk) = tokio::try_join!(
        adb::shell(serial, "dumpsys package packages"),
        adb::shell(serial, "pm list packages -f"),
        adb::shell(serial, "dumpsys diskstats"),
    )
    .map_err(|e| e.to_string())?;
    let records = parse_dumpsys_packages(&dump);
    let paths: HashMap<String, String> = parse_pm_list(&pm).into_iter().collect();
    let sizes = parse_diskstats(&disk);

    let cached: HashMap<String, (i64, String, bool)> = {
        let conn = db().lock().map_err(|e| e.to_string())?;
        let mut st = conn.prepare("SELECT package, version_code, label, has_icon FROM app_meta WHERE serial = ?1").map_err(|e| e.to_string())?;
        let rows = st.query_map([serial], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?)))).map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };

    let mut apps: Vec<AppInfo> = records
        .into_iter()
        .filter(|(pkg, r)| r.installed && paths.contains_key(pkg))
        .map(|(pkg, r)| {
            let (label, icon) = match cached.get(&pkg) {
                Some((vc, label, has_icon)) if *vc == r.version_code => (label.clone(), has_icon.then(|| icon_path(serial, &pkg, r.version_code).to_string_lossy().into_owned())),
                _ => (String::new(), None),
            };
            let (app_size, data_size, cache_size) = sizes.get(&pkg).copied().unwrap_or_default();
            AppInfo {
                apk_path: paths.get(&pkg).cloned().unwrap_or_default(),
                label, icon, version_name: r.version_name, version_code: r.version_code, target_sdk: r.target_sdk, system: r.system,
                disabled: matches!(r.enabled_state, 2 | 3 | 4), first_install: r.first_install, last_update: r.last_update, installer: r.installer,
                app_size, data_size, cache_size, package: pkg,
            }
        })
        .collect();
    apps.sort_by(|a, b| a.package.cmp(&b.package));
    Ok(apps)
}

pub async fn details(serial: &str, package: &str) -> Result<AppDetails, String> {
    let (dump_cmd, path_cmd) = (format!("dumpsys package {}", shell_quote(package)), format!("pm path {}", shell_quote(package)));
    let (dump, paths) = tokio::try_join!(adb::shell(serial, &dump_cmd), adb::shell(serial, &path_cmd)).map_err(|e| e.to_string())?;
    let (granted, denied) = parse_permissions(&dump);
    let apk_paths = paths.lines().filter_map(|l| l.trim().strip_prefix("package:")).map(str::to_string).collect();
    Ok(AppDetails { apk_paths, granted, denied })
}

// ---------- names & icons ----------

const DENSITY: [&str; 5] = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

fn is_bitmap(ext: &str) -> bool {
    matches!(ext, "png" | "webp" | "jpg" | "jpeg")
}

fn ext_of(p: &str) -> String {
    Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn density_rank(name: &str) -> i32 {
    // Match whole directory tokens: "xxhdpi" must not be mistaken for "hdpi".
    name.split(['/', '-']).filter_map(|tok| DENSITY.iter().position(|d| *d == tok)).max().map(|i| i as i32).unwrap_or(-1)
}

fn stem_of(n: &str) -> &str {
    Path::new(n).file_stem().and_then(|s| s.to_str()).unwrap_or("")
}

/// Which bitmap inside the APK to show. A direct png/webp is used as is; for adaptive/vector
/// icons (`.xml`) we look for a same-named bitmap in other densities, then for the classic
/// `ic_launcher*` bitmaps most apps still ship, and take the sharpest.
pub fn pick_icon(icon: &str, names: &[String]) -> Option<String> {
    if is_bitmap(&ext_of(icon)) {
        return Some(icon.to_string());
    }
    let stem = stem_of(icon);
    let bitmaps = || names.iter().filter(|n| n.starts_with("res/") && is_bitmap(&ext_of(n)));
    if let Some(best) = bitmaps().filter(|n| stem_of(n) == stem).max_by_key(|n| density_rank(n)) {
        return Some(best.clone());
    }
    let layer = |s: &str| ["foreground", "background", "monochrome", "adaptive", "notification"].iter().any(|w| s.contains(w));
    bitmaps()
        .filter(|n| {
            let s = stem_of(n).to_ascii_lowercase();
            (s == "ic_launcher" || s == "ic_launcher_round" || s == "icon" || s == "app_icon" || s == "launcher_icon" || s.starts_with("ic_launcher")) && !layer(&s)
        })
        .max_by_key(|n| (density_rank(n), !stem_of(n).contains("round")))
        .cloned()
}

pub struct ResolvedMeta {
    pub label: String,
    pub icon_png: Option<Vec<u8>>,
    /// Bytes actually read from the phone (typically 5–15% of the APK).
    pub fetched: u64,
}

/// Blocking: read name + icon from an APK on the phone via ranged reads.
pub fn resolve_blocking(handle: tokio::runtime::Handle, serial: &str, apk: &str, size: u64) -> Result<ResolvedMeta, String> {
    let remote = RemoteFile::new(handle, serial, apk, size);
    let mut zip = zip::ZipArchive::new(remote).map_err(|e| format!("not a readable APK: {e}"))?;

    // apk-info wants a file: write a mini archive with just the manifest and resource table.
    let tmp = std::env::temp_dir().join(format!("droidshuttle-meta-{}-{}.apk", std::process::id(), apk.len() ^ size as usize));
    {
        let mut w = zip::ZipWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for name in ["AndroidManifest.xml", "resources.arsc"] {
            if let Ok(mut f) = zip.by_name(name) {
                let mut buf = Vec::with_capacity(f.size() as usize);
                f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
                w.start_file(name, opts).map_err(|e| e.to_string())?;
                w.write_all(&buf).map_err(|e| e.to_string())?;
            }
        }
        w.finish().map_err(|e| e.to_string())?;
    }
    let parsed = apk_info::Apk::new(&tmp);
    let _ = std::fs::remove_file(&tmp);
    let parsed = parsed.map_err(|e| format!("manifest unreadable: {e:?}"))?;

    let label = parsed.get_application_label().filter(|l| !l.starts_with('@')).unwrap_or_default();
    let names: Vec<String> = zip.file_names().map(str::to_string).collect();
    let icon_png = parsed.get_application_icon().and_then(|i| pick_icon(&i, &names)).and_then(|entry| {
        let mut f = zip.by_name(&entry).ok()?;
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).ok()?;
        let img = image::load_from_memory(&bytes).ok()?;
        let mut out = Vec::new();
        img.thumbnail(96, 96).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
        Some(out)
    });
    Ok(ResolvedMeta { label, icon_png, fetched: zip.into_inner().fetched })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveReq {
    pub package: String,
    pub apk_path: String,
    pub version_code: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetaEvent {
    package: String,
    label: String,
    icon: Option<String>,
}

/// Resolve names/icons for `items` in the background (3 at a time), emitting `app-meta` per app.
pub async fn resolve_many<R: Runtime>(app: AppHandle<R>, serial: String, items: Vec<ResolveReq>) -> usize {
    let sem = Arc::new(Semaphore::new(3));
    let handle = tokio::runtime::Handle::current();
    let mut set = tokio::task::JoinSet::new();
    for it in items {
        let (sem, app, serial, handle) = (sem.clone(), app.clone(), serial.clone(), handle.clone());
        set.spawn(async move {
            let _p = sem.acquire().await.ok()?;
            let size = sync::stat(&serial, &it.apk_path).await.ok()??.size;
            let (s2, p2, h2) = (serial.clone(), it.apk_path.clone(), handle.clone());
            let meta = tokio::task::spawn_blocking(move || resolve_blocking(h2, &s2, &p2, size)).await.ok()?;
            let (label, has_icon, icon, fetched) = match meta {
                Ok(m) => {
                    let ip = icon_path(&serial, &it.package, it.version_code);
                    let has = match &m.icon_png {
                        Some(bytes) => {
                            let _ = tokio::fs::create_dir_all(ip.parent().unwrap()).await;
                            tokio::fs::write(&ip, bytes).await.is_ok()
                        }
                        None => false,
                    };
                    (m.label, has, has.then(|| ip.to_string_lossy().into_owned()), m.fetched)
                }
                Err(e) => {
                    tracing::debug!("app meta {}: {e}", it.package);
                    return None; // don't cache failures that may be transient
                }
            };
            if let Ok(conn) = db().lock() {
                let _ = conn.execute(
                    "INSERT INTO app_meta (serial, package, version_code, label, has_icon) VALUES (?1,?2,?3,?4,?5)
                     ON CONFLICT (serial, package) DO UPDATE SET version_code=?3, label=?4, has_icon=?5",
                    params![serial, it.package, it.version_code, label, has_icon],
                );
            }
            tracing::debug!("app meta {} read {} B", it.package, fetched);
            let _ = app.emit("app-meta", MetaEvent { package: it.package, label, icon });
            Some(())
        });
    }
    let mut n = 0;
    while let Some(r) = set.join_next().await {
        if matches!(r, Ok(Some(()))) {
            n += 1;
        }
    }
    n
}

// ---------- actions ----------

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

pub async fn uninstall(serial: &str, package: &str, keep_data: bool, system: bool) -> Result<(), String> {
    let cmd = format!("pm uninstall{}{} {}", if keep_data { " -k" } else { "" }, if system { " --user 0" } else { "" }, shell_quote(package));
    let (out, _) = shell_rc(serial, &cmd).await.map_err(|e| e.to_string())?;
    if out.contains("Success") { Ok(()) } else { Err(explain_failure(&out)) }
}

pub async fn set_enabled(serial: &str, package: &str, enabled: bool) -> Result<(), String> {
    let cmd = if enabled { format!("pm enable {}", shell_quote(package)) } else { format!("pm disable-user --user 0 {}", shell_quote(package)) };
    let (out, rc) = shell_rc(serial, &cmd).await.map_err(|e| e.to_string())?;
    if rc == 0 && !out.contains("Exception") { Ok(()) } else { Err(first_line(&out)) }
}

pub async fn clear_data(serial: &str, package: &str) -> Result<(), String> {
    let (out, _) = shell_rc(serial, &format!("pm clear {}", shell_quote(package))).await.map_err(|e| e.to_string())?;
    if out.contains("Success") { Ok(()) } else { Err(first_line(&out)) }
}

pub async fn force_stop(serial: &str, package: &str) -> Result<(), String> {
    shell_rc(serial, &format!("am force-stop {}", shell_quote(package))).await.map(|_| ()).map_err(|e| e.to_string())
}

pub async fn launch(serial: &str, package: &str) -> Result<(), String> {
    let (out, _) = shell_rc(serial, &format!("monkey -p {} -c android.intent.category.LAUNCHER 1", shell_quote(package))).await.map_err(|e| e.to_string())?;
    if out.contains("No activities found") { Err("This app has no launchable screen".into()) } else { Ok(()) }
}

pub async fn open_settings(serial: &str, package: &str) -> Result<(), String> {
    shell_rc(serial, &format!("am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:{}", shell_quote(package))).await.map(|_| ()).map_err(|e| e.to_string())
}

/// Plain-English reason for the common `pm install` failures.
pub fn explain_failure(out: &str) -> String {
    let table = [
        ("INSTALL_FAILED_VERSION_DOWNGRADE", "A newer version of this app is already installed. Uninstall it first to install an older one."),
        ("INSTALL_FAILED_UPDATE_INCOMPATIBLE", "This app is signed differently from the installed copy. Uninstall the installed app first (its data will be lost)."),
        ("INSTALL_FAILED_INSUFFICIENT_STORAGE", "The phone doesn't have enough free storage."),
        ("INSTALL_FAILED_OLDER_SDK", "This app needs a newer version of Android than your phone has."),
        ("INSTALL_FAILED_NEWER_SDK", "This app was built for an older version of Android and can't be installed."),
        ("INSTALL_FAILED_NO_MATCHING_ABIS", "This app doesn't include code for your phone's processor."),
        ("INSTALL_FAILED_USER_RESTRICTED", "The phone blocked the install. Enable “Install via USB” in Developer options, then try again."),
        ("INSTALL_FAILED_ABORTED", "The install was declined on the phone. Approve the prompt on the screen and try again."),
        ("INSTALL_PARSE_FAILED_NO_CERTIFICATES", "This APK isn't signed, so Android won't install it."),
        ("INSTALL_PARSE_FAILED_NOT_APK", "This file isn't a valid APK."),
        ("INSTALL_FAILED_ALREADY_EXISTS", "This app is already installed."),
        ("DELETE_FAILED_DEVICE_POLICY_MANAGER", "This app is protected by a device policy and can't be removed."),
        ("DELETE_FAILED_USER_RESTRICTED", "Removing apps is restricted on this phone."),
    ];
    for (code, msg) in table {
        if out.contains(code) {
            return msg.to_string();
        }
    }
    let line = out.lines().map(str::trim).rfind(|l| l.contains("Failure") || l.contains("Error")).unwrap_or_else(|| out.trim());
    if line.is_empty() { "The phone reported an unknown error.".into() } else { line.to_string() }
}

// ---------- install (apk / xapk / apks / apkm) ----------

/// Keep the base APK plus only the config splits that match this phone.
pub fn select_splits(names: &[String], abis: &[String], density: &str, langs: &[&str]) -> Vec<String> {
    const ABIS: [&str; 5] = ["arm64_v8a", "armeabi_v7a", "armeabi", "x86_64", "x86"];
    const DENS: [&str; 7] = ["ldpi", "mdpi", "tvdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
    names
        .iter()
        .filter(|n| n.to_ascii_lowercase().ends_with(".apk"))
        .filter(|n| {
            let stem = Path::new(n.as_str()).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().replace('-', "_");
            let token = stem.rsplit(['.', '_']).next().unwrap_or("");
            let full_abi = ABIS.iter().find(|a| stem.ends_with(*a));
            if let Some(a) = full_abi {
                return abis.iter().any(|d| d.replace('-', "_") == *a);
            }
            if DENS.contains(&token) {
                return token == density;
            }
            if stem.contains("config") || stem.contains("split") {
                // a language split ends in a 2–3 letter code
                if token.len() <= 3 && token.chars().all(|c| c.is_ascii_lowercase()) && token != "apk" {
                    return langs.contains(&token);
                }
            }
            true
        })
        .cloned()
        .collect()
}

pub fn density_bucket(dpi: u32) -> &'static str {
    match dpi {
        0..=140 => "ldpi",
        141..=200 => "mdpi",
        201..=260 => "hdpi",
        261..=360 => "xhdpi",
        361..=500 => "xxhdpi",
        _ => "xxxhdpi",
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub file: String,
    pub ok: bool,
    pub message: String,
}

async fn run_adb(args: &[String]) -> Result<String, String> {
    let bin = adb::adb_binary().map_err(|e| e.to_string())?;
    let out = tokio::process::Command::new(bin).args(args).output().await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr))
}

pub async fn install_one(serial: &str, file: &str) -> InstallOutcome {
    let name = file.rsplit('/').next().unwrap_or(file).to_string();
    let result = install_inner(serial, file).await;
    match result {
        Ok(()) => InstallOutcome { file: name, ok: true, message: "Installed".into() },
        Err(m) => InstallOutcome { file: name, ok: false, message: m },
    }
}

/// Install one app's APK files together (base + splits), e.g. when restoring from a backup.
pub async fn install_set(serial: &str, name: &str, apks: &[String]) -> InstallOutcome {
    if apks.is_empty() {
        return InstallOutcome { file: name.into(), ok: false, message: "No APK files found in this backup.".into() };
    }
    let mut args: Vec<String> = vec!["-s".into(), serial.into()];
    args.extend(if apks.len() == 1 { vec!["install".to_string(), "-r".into()] } else { vec!["install-multiple".to_string(), "-r".into()] });
    args.extend(apks.iter().cloned());
    match run_adb(&args).await {
        Ok(o) if o.contains("Success") => InstallOutcome { file: name.into(), ok: true, message: "Installed".into() },
        Ok(o) => InstallOutcome { file: name.into(), ok: false, message: explain_failure(&o) },
        Err(e) => InstallOutcome { file: name.into(), ok: false, message: e },
    }
}

async fn install_inner(serial: &str, file: &str) -> Result<(), String> {
    let ext = ext_of(file);
    let mut args: Vec<String> = vec!["-s".into(), serial.into()];
    let mut cleanup: Option<PathBuf> = None;
    let mut obbs: Vec<(PathBuf, String)> = Vec::new();

    if ext == "apk" {
        args.extend(["install".into(), "-r".into(), file.into()]);
    } else if matches!(ext.as_str(), "apks" | "xapk" | "apkm") {
        let dir = std::env::temp_dir().join(format!("droidshuttle-bundle-{}-{}", std::process::id(), file.len()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        cleanup = Some(dir.clone());
        let abis = shell_rc(serial, "getprop ro.product.cpu.abilist").await.map(|(o, _)| o.trim().split(',').map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
        let dpi: u32 = shell_rc(serial, "getprop ro.sf.lcd_density").await.ok().and_then(|(o, _)| o.trim().parse().ok()).unwrap_or(420);
        let (names, extracted) = {
            let (f, d) = (file.to_string(), dir.clone());
            tokio::task::spawn_blocking(move || -> Result<(Vec<String>, Vec<(String, PathBuf)>), String> {
                let mut z = zip::ZipArchive::new(std::fs::File::open(&f).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                let mut names = Vec::new();
                let mut got = Vec::new();
                for i in 0..z.len() {
                    let mut e = z.by_index(i).map_err(|e| e.to_string())?;
                    let n = e.name().to_string();
                    if e.is_dir() || n.contains("..") {
                        continue;
                    }
                    let low = n.to_ascii_lowercase();
                    if low.ends_with(".apk") || low.ends_with(".obb") {
                        let out = d.join(format!("{i}_{}", n.rsplit('/').next().unwrap_or("x")));
                        std::io::copy(&mut e, &mut std::fs::File::create(&out).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                        if low.ends_with(".apk") { names.push(out.to_string_lossy().into_owned()) }
                        got.push((n, out));
                    }
                }
                Ok((names, got))
            })
            .await
            .map_err(|e| e.to_string())??
        };
        let apks: Vec<String> = if ext == "xapk" { names.clone() } else { select_splits(&names, &abis, density_bucket(dpi), &["en"]) };
        if apks.is_empty() {
            return Err("No APK files found inside this bundle.".into());
        }
        args.extend(["install-multiple".into(), "-r".into()]);
        args.extend(apks);
        for (name, path) in extracted {
            if name.to_ascii_lowercase().ends_with(".obb") {
                obbs.push((path, name));
            }
        }
    } else {
        return Err(format!("“.{ext}” isn't an installable app file."));
    }

    let out = run_adb(&args).await;
    let result = match out {
        Ok(o) if o.contains("Success") => Ok(()),
        Ok(o) => Err(explain_failure(&o)),
        Err(e) => Err(e),
    };
    if result.is_ok() {
        for (path, name) in &obbs {
            // xapk layout: Android/obb/<package>/<file>.obb
            let target = format!("/sdcard/{}", name.trim_start_matches('/'));
            let _ = shell_rc(serial, &format!("mkdir -p {}", shell_quote(&crate::fs::parent(&target)))).await;
            let (_o, ctl) = crate::transfer::ctl::channel();
            let _ = sync::push(serial, path, &target, 0o100664, 0, &ctl, |_| {}).await;
        }
    }
    if let Some(d) = cleanup {
        let _ = std::fs::remove_dir_all(d);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = "Packages:
  Package [com.whatsapp] (7a05874):
    codePath=/data/app/~~x/com.whatsapp-y==
    versionCode=263707322 minSdk=23 targetSdk=36
    versionName=2.26.37.73
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    lastUpdateTime=2026-09-29 22:32:56
    installerPackageName=com.android.vending
    pkgFlags=[ HAS_CODE ]
    User 0: ceDataInode=22306 installed=true hidden=false stopped=false enabled=0 instant=false
      firstInstallTime=2026-04-07 20:42:26
      runtime permissions:
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET]
        android.permission.READ_CALL_LOG: granted=false, flags=[ X]
  Package [com.samsung.sys] (1):
    versionCode=5 minSdk=30 targetSdk=34
    versionName=1.0
    flags=[ SYSTEM HAS_CODE ]
    User 0: ceDataInode=1 installed=true hidden=false stopped=false enabled=3 instant=false
  Package [com.gone] (2):
    versionCode=1 minSdk=1 targetSdk=1
    User 0: ceDataInode=1 installed=false hidden=false stopped=false enabled=0 instant=false
Hidden system packages:
  Package [com.hidden] (3):
    versionCode=9 minSdk=1 targetSdk=1
";

    #[test]
    fn parses_package_records() {
        let r = parse_dumpsys_packages(DUMP);
        assert_eq!(r.len(), 3, "hidden section is not part of the list");
        let w = &r["com.whatsapp"];
        assert_eq!((w.version_code, w.target_sdk, w.version_name.as_str()), (263707322, 36, "2.26.37.73"));
        assert!(!w.system && w.installed && w.enabled_state == 0);
        assert_eq!((w.first_install.as_str(), w.last_update.as_str(), w.installer.as_str()), ("2026-04-07 20:42:26", "2026-09-29 22:32:56", "com.android.vending"));
        assert!(r["com.samsung.sys"].system);
        assert_eq!(r["com.samsung.sys"].enabled_state, 3);
        assert!(!r["com.gone"].installed);
    }

    #[test]
    fn parses_pm_list_diskstats_permissions() {
        let pm = "package:/data/app/~~a==/com.foo-b==/base.apk=com.foo\npackage:/system/app/X/X.apk=com.x versionCode:3\n";
        assert_eq!(parse_pm_list(pm), vec![("com.foo".to_string(), "/data/app/~~a==/com.foo-b==/base.apk".to_string()), ("com.x".to_string(), "/system/app/X/X.apk".to_string())]);

        let disk = "Latency: 1ms\nPackage Names: [\"com.a\",\"com.b\"]\nApp Sizes: [100,200]\nApp Data Sizes: [10,20]\nCache Sizes: [1,2]\n";
        let s = parse_diskstats(disk);
        assert_eq!(s["com.b"], (200, 20, 2));

        let (g, d) = parse_permissions(DUMP);
        assert_eq!((g, d), (vec!["POST_NOTIFICATIONS".to_string()], vec!["READ_CALL_LOG".to_string()]));
    }

    #[test]
    fn picks_the_sharpest_bitmap_for_adaptive_icons() {
        let names: Vec<String> = ["res/mipmap-mdpi-v4/ic_launcher.png", "res/mipmap-xxhdpi-v4/ic_launcher.png", "res/mipmap-hdpi-v4/ic_launcher.png", "res/mipmap-anydpi-v26/ic_launcher.xml", "res/mipmap-xxhdpi-v4/other.png"].map(String::from).to_vec();
        assert_eq!(pick_icon("res/mipmap-anydpi-v26/ic_launcher.xml", &names).as_deref(), Some("res/mipmap-xxhdpi-v4/ic_launcher.png"));
        assert_eq!(pick_icon("res/j96.webp", &names).as_deref(), Some("res/j96.webp"));
        // No same-named bitmap, so fall back to the classic launcher bitmap…
        assert_eq!(pick_icon("res/drawable/nope.xml", &names).as_deref(), Some("res/mipmap-xxhdpi-v4/ic_launcher.png"));
        // …and with nothing launcher-like at all, show nothing (the UI draws a letter avatar).
        let none: Vec<String> = ["res/drawable/banner.png", "res/color/tint.xml"].map(String::from).to_vec();
        assert_eq!(pick_icon("res/BW.xml", &none), None);
        // Adaptive icon whose layers are vectors: fall back to the classic launcher bitmap, never a foreground layer.
        let adaptive: Vec<String> = ["res/mipmap-anydpi-v26/ic_launcher.xml", "res/mipmap-xhdpi/ic_launcher_foreground.png", "res/mipmap-mdpi/ic_launcher_round.png", "res/mipmap-xxhdpi/ic_launcher_round.png", "res/mipmap-xxhdpi/ic_launcher.png"].map(String::from).to_vec();
        assert_eq!(pick_icon("res/zz.xml", &adaptive).as_deref(), Some("res/mipmap-xxhdpi/ic_launcher.png"));
    }

    #[test]
    fn explains_install_failures_in_plain_english() {
        assert!(explain_failure("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]").contains("newer version"));
        assert!(explain_failure("adb: failed to install x.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signatures do not match]").contains("signed differently"));
        assert!(explain_failure("Failure [INSTALL_FAILED_USER_RESTRICTED]").contains("Install via USB"));
        assert_eq!(explain_failure("Failure [SOMETHING_NEW: details]"), "Failure [SOMETHING_NEW: details]");
    }

    #[test]
    fn bundles_only_install_matching_splits() {
        let names: Vec<String> = ["base.apk", "split_config.arm64_v8a.apk", "split_config.armeabi_v7a.apk", "split_config.x86.apk", "split_config.xxhdpi.apk", "split_config.mdpi.apk", "split_config.en.apk", "split_config.fr.apk", "feature_camera.apk", "icon.png"].map(String::from).to_vec();
        let abis = vec!["arm64-v8a".to_string(), "armeabi-v7a".to_string(), "armeabi".to_string()];
        let got = select_splits(&names, &abis, "xxhdpi", &["en"]);
        assert_eq!(got, ["base.apk", "split_config.arm64_v8a.apk", "split_config.armeabi_v7a.apk", "split_config.xxhdpi.apk", "split_config.en.apk", "feature_camera.apk"].map(String::from).to_vec());
        assert_eq!(density_bucket(420), "xxhdpi");
        assert_eq!(density_bucket(320), "xhdpi");
    }

    /// Real phone: `cargo test live_apps -- --ignored --nocapture --test-threads=1`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_apps_pipeline() {
        let serial = crate::adb::list_devices().await.unwrap().into_iter().find(|d| d.state == crate::adb::AdbState::Ready).expect("device").serial;
        let t = std::time::Instant::now();
        let apps = list(&serial).await.unwrap();
        let (user, system): (Vec<_>, Vec<_>) = apps.iter().partition(|a| !a.system);
        let shell_user = crate::adb::shell(&serial, "pm list packages -3").await.unwrap().lines().filter(|l| l.starts_with("package:")).count();
        println!("{} apps ({} user, {} system, {} disabled) listed in {:.1}s; pm says {} user apps", apps.len(), user.len(), system.len(), apps.iter().filter(|a| a.disabled).count(), t.elapsed().as_secs_f64(), shell_user);
        assert_eq!(user.len(), shell_user, "user app count matches `pm list packages -3`");
        assert!(user.iter().all(|a| !a.version_name.is_empty() && a.version_code > 0 && !a.apk_path.is_empty()));
        assert!(user.iter().filter(|a| a.app_size > 0).count() * 2 > user.len(), "sizes present for most apps");
        let total: u64 = user.iter().map(|a| a.app_size).sum();
        println!("user apps total {} MB of code", total / 1_000_000);

        // Names + icons for a few big apps via ranged reads.
        let handle = tokio::runtime::Handle::current();
        for pkg in ["com.whatsapp", "com.yandex.yango", "com.samsung.android.app.notes"] {
            let Some(a) = apps.iter().find(|a| a.package == pkg) else { continue };
            let size = sync::stat(&serial, &a.apk_path).await.unwrap().unwrap().size;
            let (h, s, p) = (handle.clone(), serial.clone(), a.apk_path.clone());
            let t = std::time::Instant::now();
            let m = tokio::task::spawn_blocking(move || resolve_blocking(h, &s, &p, size)).await.unwrap().unwrap();
            println!("{pkg}: label={:?} icon={} bytes read {:.2} MB of {:.0} MB in {:.1}s", m.label, m.icon_png.as_ref().map(|b| format!("{} B png", b.len())).unwrap_or("none".into()), m.fetched as f64 / 1e6, size as f64 / 1e6, t.elapsed().as_secs_f64());
            assert!(!m.label.is_empty());
            assert!(m.fetched < size / 3, "read far less than the whole APK");
            if let Some(png) = &m.icon_png {
                let img = image::load_from_memory(png).unwrap();
                assert!(img.width() <= 96 && img.height() <= 96);
            }
        }

        // Resolve every user app through the real path, then confirm the cache feeds the next list.
        let app = tauri::test::mock_app();
        let reqs: Vec<ResolveReq> = user.iter().map(|a| ResolveReq { package: a.package.clone(), apk_path: a.apk_path.clone(), version_code: a.version_code }).collect();
        let t = std::time::Instant::now();
        let n = resolve_many(app.handle().clone(), serial.clone(), reqs).await;
        println!("resolved {n}/{} user apps in {:.1}s", user.len(), t.elapsed().as_secs_f64());
        assert!(n * 10 >= user.len() * 8, "at least 80% resolved");
        let again = list(&serial).await.unwrap();
        let named = again.iter().filter(|a| !a.system && !a.label.is_empty()).count();
        let iconned = again.iter().filter(|a| a.icon.as_ref().map(|p| std::path::Path::new(p).exists()).unwrap_or(false)).count();
        println!("after cache: {named} named, {iconned} with icons");
        assert!(named >= n);
        for a in again.iter().filter(|a| !a.system).take(8) { println!("  {:<28} {:<14} {:>8} KB  icon={}", a.label, a.version_name, a.app_size / 1024, a.icon.is_some()); }

        // Details + friendly failure for a bad file.
        let d = details(&serial, "com.whatsapp").await.unwrap();
        println!("whatsapp: {} apk file(s), {} granted / {} denied permissions", d.apk_paths.len(), d.granted.len(), d.denied.len());
        assert!(!d.apk_paths.is_empty() && !d.granted.is_empty());
        let bad = std::env::temp_dir().join("db-not-an-app.apk");
        std::fs::write(&bad, "definitely not an apk").unwrap();
        let r = install_one(&serial, &bad.to_string_lossy()).await;
        println!("bad apk install -> ok={} {:?}", r.ok, r.message);
        assert!(!r.ok && !r.message.is_empty());
        let _ = std::fs::remove_file(bad);
    }
}
