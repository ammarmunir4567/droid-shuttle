//! Device discovery, live hot-plug tracking and device info.

use crate::adb::{self, AdbDevice};
use serde::Serialize;
use std::{collections::HashMap, time::Duration};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub serial: String,
    pub manufacturer: String,
    pub model: String,
    pub android_version: String,
    pub sdk: u32,
    pub battery_level: Option<u8>,
    pub battery_charging: bool,
    /// Bytes on the user-data partition.
    pub storage_total: u64,
    pub storage_used: u64,
}

/// Parse `getprop` output (`[ro.foo]: [bar]`) into a map.
pub fn parse_getprop(out: &str) -> HashMap<String, String> {
    out.lines()
        .filter_map(|l| {
            let (k, v) = l.split_once("]: [")?;
            Some((k.trim_start_matches('[').to_string(), v.trim_end_matches(']').to_string()))
        })
        .collect()
}

/// Parse `dumpsys battery` into (level, charging).
pub fn parse_battery(out: &str) -> (Option<u8>, bool) {
    let mut level = None;
    let mut charging = false;
    for l in out.lines().map(str::trim) {
        if let Some(v) = l.strip_prefix("level:") {
            level = v.trim().parse().ok();
        } else if l.starts_with("AC powered: true") || l.starts_with("USB powered: true") || l.starts_with("Wireless powered: true") {
            charging = true;
        }
    }
    (level, charging)
}

/// Parse the data row of `df -k /data` into (total, used) bytes.
pub fn parse_df(out: &str) -> (u64, u64) {
    out.lines()
        .nth(1)
        .map(|l| {
            let c: Vec<&str> = l.split_whitespace().collect();
            let kb = |i: usize| c.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * 1024;
            (kb(1), kb(2))
        })
        .unwrap_or((0, 0))
}

pub async fn fetch_info(serial: &str) -> adb::Result<DeviceInfo> {
    let (props, battery, df) = tokio::try_join!(
        adb::shell(serial, "getprop"),
        adb::shell(serial, "dumpsys battery"),
        adb::shell(serial, "df -k /data"),
    )?;
    let p = parse_getprop(&props);
    let get = |k: &str| p.get(k).cloned().unwrap_or_default();
    let (battery_level, battery_charging) = parse_battery(&battery);
    let (storage_total, storage_used) = parse_df(&df);
    Ok(DeviceInfo {
        serial: serial.to_string(),
        manufacturer: get("ro.product.manufacturer"),
        model: get("ro.product.model"),
        android_version: get("ro.build.version.release"),
        sdk: get("ro.build.version.sdk").parse().unwrap_or(0),
        battery_level,
        battery_charging,
        storage_total,
        storage_used,
    })
}

/// Background task: push the full device list to the UI on every change and
/// reconnect with backoff if the ADB server goes away.
pub fn spawn_tracker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let handle = app.clone();
            let res = adb::track_devices(move |list: Vec<AdbDevice>| {
                let _ = handle.emit("devices-changed", &list);
                crate::menubar::on_devices(&handle, &list);
            })
            .await;
            if let Err(e) = res {
                tracing::warn!("device tracker: {e}");
                let _ = app.emit("adb-error", e.to_string());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_props_battery_df() {
        let p = parse_getprop("[ro.product.model]: [Pixel 8]\n[ro.build.version.sdk]: [35]\n");
        assert_eq!(p["ro.product.model"], "Pixel 8");
        assert_eq!(p["ro.build.version.sdk"], "35");

        let (lvl, chg) = parse_battery("Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  level: 87\n");
        assert_eq!(lvl, Some(87));
        assert!(chg);

        let (t, u) = parse_df("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-9 1000 400 600 40% /data\n");
        assert_eq!((t, u), (1000 * 1024, 400 * 1024));
    }

    /// Needs a real authorized phone: `cargo test -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_device_roundtrip() {
        let devices = crate::adb::list_devices().await.expect("adb server");
        let dev = devices.iter().find(|d| d.state == crate::adb::AdbState::Ready).expect("a ready device");
        println!("device: {dev:?}");
        let info = fetch_info(&dev.serial).await.expect("device info");
        println!("info: {info:?}");
        assert!(!info.model.is_empty() && info.sdk > 0 && info.storage_total > 0);
    }
}
