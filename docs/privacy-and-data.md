# Privacy and data

Droid Shuttle is a local tool. Your files travel between your phone and your Mac over a cable (or your own Wi-Fi), and nothing is sent anywhere else. This page lists what the app stores, what it writes to the phone, what it can reach on a network, and which permissions it has. It was checked against the source code of version 0.1.0.

## Contents

- [The short version](#the-short-version)
- [Network access](#network-access)
- [What is stored on your Mac](#what-is-stored-on-your-mac)
- [What is written to your phone](#what-is-written-to-your-phone)
- [The Keychain](#the-keychain)
- [Permissions](#permissions)
- [Programs the app runs](#programs-the-app-runs)
- [Upgrading from the earlier "Droidbridge" name](#upgrading-from-the-earlier-droidbridge-name)
- [Removing everything](#removing-everything)

## The short version

- **No network requests of its own.** The app does not call any server, has no telemetry, no analytics, no crash reporting and no update check.
- **No account, no cloud.** Nothing to sign in to.
- **Nothing to install on the phone.** The app uses Android's own tools over ADB. For mirroring it copies one file to the phone's temporary folder.
- **Your data stays in your folders.** Imports, backups and saved files go where you choose, in ordinary files you can open without Droid Shuttle.

## Network access

The app's code (the Rust backend, the interface and `index.html`) was searched for network use and for the names of common analytics and crash-reporting services. There are none.

- The only TCP connection the app opens is to the **ADB server on your own Mac**, at `127.0.0.1:5037`.
- **Wireless debugging traffic** (pairing, `adb connect` and mDNS discovery) is carried out by the ADB server or the `adb` program on your local network. The app only asks the local ADB server to do it.
- The one web address the app can open is the Apple Maps link behind **Show location in Maps** in the Gallery viewer. It appears only when a photo has GPS data, opens only when you click it, in your default handler (`https://maps.apple.com/?ll=<latitude>,<longitude>&q=Photo`).
- Fonts are bundled with the app. The page loads no remote scripts, styles or fonts.
- The build script `scripts/fetch-adb.sh` downloads Google's platform-tools from `dl.google.com`. That runs when you build, not when you use the app.
- The app's content security policy is not set (`csp: null`), which is normal for a local desktop app that loads only its own bundled page.

## What is stored on your Mac

All app data uses the bundle identifier `ai.arqanum.droidshuttle`.

| Location | What | Cleanup |
|---|---|---|
| `~/Library/Application Support/ai.arqanum.droidshuttle/droidshuttle.db` (plus `-wal` and `-shm`) | A SQLite database. **`media`**: the Gallery's index of the phone (per phone serial: path, kind, type, size, date, dimensions, duration, album). **`app_meta`**: app names (package, version code, label, whether it has an icon). **`backups`**: backup history. **`imports`**: the list of photos already imported (phone serial, path, size, destination, time). | Never pruned by the app. |
| `~/Library/Caches/ai.arqanum.droidshuttle/thumbs/<phone>/` | Gallery thumbnails (JPEG). | Not pruned. |
| `~/Library/Caches/ai.arqanum.droidshuttle/originals/<phone>/` | Full photos and videos opened in the viewer, and converted copies of HEIC and similar. | Trimmed to 2 GiB, oldest first, at every launch. |
| `~/Library/Caches/ai.arqanum.droidshuttle/icons/<phone>/` | App icons (PNG). | Not pruned. |
| `~/Library/Caches/ai.arqanum.droidshuttle/clipboard/` | Phone files staged by ⌘C so they can be pasted in Finder. | Emptied at every launch and before each new copy. |
| `$TMPDIR/droidshuttle-preview/` | Copies of phone files you opened or Quick Looked. | Not cleaned up by the app. |
| `$TMPDIR` (other names) | Short-lived work files: `scrcpy-server-<id>.jar`, `droidshuttle-meta-*.apk`, `droidshuttle-bundle-*` while installing a bundle, `droidshuttle-vol-<id>` as the private mount point of an encrypted backup. | Removed when done. |
| `~/Library/WebKit/ai.arqanum.droidshuttle/WebsiteData/` | macOS's web view storage. This is where the app's remembered settings live (see below). | Not managed by the app. |
| `~/Pictures/Droid Shuttle Screenshots/` | Screenshots from Mirror and the menu-bar item. | Yours. |
| `~/Movies/Droid Shuttle/` | Screen recordings from Mirror. | Yours. |
| `~/Pictures/Droid Shuttle/` (default) | Gallery imports. | Yours. |
| `~/Droid Shuttle Backups/` (default) | Backups. | Yours. |

The folders under **Yours** are created in the places you choose or accept as a default, and are never touched by the app's own cleanup.

**Remembered settings** (the web view's local storage; all keys start with `db.`): the look and brightness (`db.appearance`); Files panes, layout, split, hidden-file and verify settings (`db.dual`, `db.layout`, `db.split`, `db.hidden`, `db.verify`); Gallery grouping, thumbnail size, "New only", organize mode and destination (`db.g.grouping`, `db.g.tile`, `db.g.onlyNew`, `db.g.organize`, `db.g.dest`); Backup destination, folders, apps, verify and encrypt (`db.b.dest`, `db.b.folders`, `db.b.apps`, `db.b.verify`, `db.b.encrypt`); and Mirror options (`db.m.opts`). Backup passwords are **not** stored there, and the Gallery's "delete after import" choice is deliberately never remembered.

The app writes no separate settings file, and its log messages go to the terminal it was started from.

## What is written to your phone

| Where on the phone | What | When |
|---|---|---|
| `/data/local/tmp/scrcpy-server.jar` | The mirroring server (scrcpy v4.1). | Copied each time you start mirroring. **Not removed afterwards.** The server process stops when mirroring stops. |
| `/sdcard/Download/.droidshuttle-recording-<id>.mp4` | A screen recording in progress. | Removed after it is copied to the Mac. |
| `<destination>.droidshuttle-part` | Partial files of an upload in progress (files of 16 MiB or more). | Renamed on success. Can remain after a cancel while the phone was away. |
| Where you put them | Files you copy, move, restore or install. | |
| The phone's ADB daemon | **Go wireless** switches it to TCP port 5555 (`setprop service.adb.tcp.port` / `adb tcpip 5555`). The app does not switch it back. | When you click **Go wireless**. |

Apart from those, the app **reads** from the phone with standard Android commands: `getprop`, `dumpsys` (battery, packages, disk statistics), `pm`, `cat /proc/meminfo`, `df`, `ip`, `wm`, `pidof`, `find`, `stat`, `sha256sum`, `logcat`, `screencap` and `screenrecord`. Commands that change things (`rm`, `mv`, `cp`, `mkdir`, `pm uninstall`, `pm clear`, `pm disable-user`, `logcat -c`, `am force-stop`) run only when you ask for the matching action.

## The Keychain

If you encrypt a backup, its password is saved in your macOS **Keychain**:

- **Service:** `Droid Shuttle Backup` (older builds used `Droidbridge Backup`, which is still read).
- **Account:** the full path of the `.sparsebundle` image.

The password is written with the `security` tool, which takes it as a command-line argument, so it is briefly visible in the process list to other programs on your Mac while it is being saved. The disk-image tool `hdiutil` receives it on standard input. The app does not keep the password anywhere other than the Keychain, and it is not part of the remembered settings.

## Permissions

The app's single window has these Tauri capabilities (`src-tauri/capabilities/default.json`):

- `core:default`, `opener:default`, `dialog:default` and `notification:default`;
- the ability to keep the window on top, and to enter or leave full screen (for Mirror).

File and process access is not exposed through a generic plugin. It goes through the app's own named commands (listing, copying, backing up and so on).

The **asset protocol** (used to show thumbnails and icons) is limited to `~/Library/Caches/ai.arqanum.droidshuttle/` and `~/Pictures/`.

The first time a notification is needed, macOS asks for **notification** permission. If you decline, no notification is shown.

## Programs the app runs

Besides `adb` (bundled), the app starts these macOS tools: `open`, `qlmanage` (Quick Look), `pbcopy` (the phone-to-Mac clipboard), `security` (Keychain), `hdiutil` (encrypted images), `sips` (HEIC and RAW previews), `date`, `cp` and `mv`.

## Upgrading from the earlier "Droidbridge" name

The app used to be called Droidbridge. On launch, before anything else, it renames the old data folders (`ai.arqanum.droidbridge` in Application Support and Caches) and the old database files to the new names, but only when the old ones exist and the new ones do not. It never overwrites or merges. The Keychain item `Droidbridge Backup` is still read, but is not copied to the new name. Remembered settings from the old name are not carried over.

## Removing everything

Quit the app and delete:

```bash
rm -rf ~/Library/Application\ Support/ai.arqanum.droidshuttle
rm -rf ~/Library/Caches/ai.arqanum.droidshuttle
rm -rf ~/Library/WebKit/ai.arqanum.droidshuttle
```

Then delete `Droid Shuttle.app`, any backup passwords you no longer need from **Keychain Access** (search for "Droid Shuttle Backup"), and, if you want, `/data/local/tmp/scrcpy-server.jar` on the phone (for example with the terminal in **Tools**). Your imported photos, backups, screenshots and recordings are yours and stay where you put them.
