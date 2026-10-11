//! Local SQLite: the media index, and the ledger of what has already been imported.

use rusqlite::{params, Connection};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

pub fn app_dir() -> PathBuf {
    PathBuf::from(crate::fs::local_home()).join("Library/Application Support/ai.arqanum.droidshuttle")
}

pub fn cache_dir() -> PathBuf {
    PathBuf::from(crate::fs::local_home()).join("Library/Caches/ai.arqanum.droidshuttle")
}

/// The app was called "Droidbridge" before it became Droid Shuttle. Move its data folders (media
/// index, import ledger, thumbnails, backup history) to the new names once, so nothing is lost.
pub fn migrate_legacy() {
    migrate_legacy_in(&PathBuf::from(crate::fs::local_home()));
}

fn migrate_legacy_in(home: &std::path::Path) {
    for base in ["Library/Application Support", "Library/Caches"] {
        let (old, new) = (home.join(base).join("ai.arqanum.droidbridge"), home.join(base).join("ai.arqanum.droidshuttle"));
        if old.exists() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
    }
    let dir = home.join("Library/Application Support/ai.arqanum.droidshuttle");
    for ext in ["", "-wal", "-shm"] {
        let (old, new) = (dir.join(format!("droidbridge.db{ext}")), dir.join(format!("droidshuttle.db{ext}")));
        if old.exists() && !new.exists() {
            let _ = std::fs::rename(old, new);
        }
    }
}

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

pub fn db() -> &'static Mutex<Connection> {
    DB.get_or_init(|| {
        let dir = app_dir();
        let _ = std::fs::create_dir_all(&dir);
        let conn = Connection::open(dir.join("droidshuttle.db")).expect("open database");
        init(&conn).expect("migrate database");
        Mutex::new(conn)
    })
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    migrate(conn)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS media (
            serial TEXT NOT NULL, path TEXT NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
            size INTEGER NOT NULL, date_ms INTEGER NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER NOT NULL DEFAULT 0, bucket TEXT NOT NULL DEFAULT '', scan INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (serial, path));
         CREATE INDEX IF NOT EXISTS media_by_date ON media (serial, date_ms DESC);
         CREATE TABLE IF NOT EXISTS app_meta (
            serial TEXT NOT NULL, package TEXT NOT NULL, version_code INTEGER NOT NULL, label TEXT NOT NULL, has_icon INTEGER NOT NULL,
            PRIMARY KEY (serial, package));
         CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL, device TEXT NOT NULL, dest TEXT NOT NULL, started_ms INTEGER NOT NULL,
            finished_ms INTEGER NOT NULL, files_copied INTEGER NOT NULL, files_skipped INTEGER NOT NULL, bytes INTEGER NOT NULL,
            apps INTEGER NOT NULL, errors INTEGER NOT NULL, what TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS imports (
            serial TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, dest TEXT NOT NULL, at_ms INTEGER NOT NULL,
            PRIMARY KEY (serial, path));",
    )
}

/// Remember that `path` (with this size) was copied to `dest`.
pub fn record_import(serial: &str, path: &str, size: u64, dest: &str) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    if let Ok(db) = db().lock() {
        let _ = db.execute(
            "INSERT INTO imports (serial, path, size, dest, at_ms) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (serial, path) DO UPDATE SET size = ?3, dest = ?4, at_ms = ?5",
            params![serial, path, size as i64, dest, now],
        );
    }
}

/// Schema/algorithm version bumps that need old cached results thrown away.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 2 {
        // v2: smarter icon picker → retry apps that previously had no icon.
        let has_table: bool = conn.query_row("SELECT count(*) > 0 FROM sqlite_master WHERE type='table' AND name='app_meta'", [], |r| r.get(0))?;
        if has_table {
            conn.execute("DELETE FROM app_meta WHERE has_icon = 0", [])?;
        }
        conn.execute_batch("PRAGMA user_version = 2")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ds-migrate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moves_the_old_folders_and_database_once_and_keeps_their_contents() {
        let home = tmp("move");
        let old_app = home.join("Library/Application Support/ai.arqanum.droidbridge");
        let old_cache = home.join("Library/Caches/ai.arqanum.droidbridge/thumbs");
        std::fs::create_dir_all(&old_app).unwrap();
        std::fs::create_dir_all(&old_cache).unwrap();
        std::fs::write(old_app.join("droidbridge.db"), "index").unwrap();
        std::fs::write(old_app.join("droidbridge.db-wal"), "wal").unwrap();
        std::fs::write(old_cache.join("a.jpg"), "thumb").unwrap();

        migrate_legacy_in(&home);
        let new_app = home.join("Library/Application Support/ai.arqanum.droidshuttle");
        assert_eq!(std::fs::read_to_string(new_app.join("droidshuttle.db")).unwrap(), "index");
        assert_eq!(std::fs::read_to_string(new_app.join("droidshuttle.db-wal")).unwrap(), "wal");
        assert_eq!(std::fs::read_to_string(home.join("Library/Caches/ai.arqanum.droidshuttle/thumbs/a.jpg")).unwrap(), "thumb");
        assert!(!old_app.exists() && !home.join("Library/Caches/ai.arqanum.droidbridge").exists());

        migrate_legacy_in(&home); // running again changes nothing
        assert_eq!(std::fs::read_to_string(new_app.join("droidshuttle.db")).unwrap(), "index");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn never_overwrites_data_that_already_exists_under_the_new_name() {
        let home = tmp("keep");
        let (old, new) = (home.join("Library/Application Support/ai.arqanum.droidbridge"), home.join("Library/Application Support/ai.arqanum.droidshuttle"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("droidbridge.db"), "old").unwrap();
        std::fs::write(new.join("droidshuttle.db"), "current").unwrap();
        migrate_legacy_in(&home);
        assert_eq!(std::fs::read_to_string(new.join("droidshuttle.db")).unwrap(), "current");
        assert!(old.exists(), "old data is left alone rather than merged or deleted");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_fresh_install_has_nothing_to_migrate() {
        let home = tmp("fresh");
        migrate_legacy_in(&home);
        assert!(!home.join("Library/Application Support/ai.arqanum.droidshuttle").exists());
        std::fs::remove_dir_all(home).unwrap();
    }
}
