# Getting started

This page takes you from a fresh clone to a connected phone.

## 1. What you need

| You need | Details |
|---|---|
| A Mac | Apple Silicon or Intel. The app is macOS only. No minimum macOS version is declared; the project is developed on current macOS releases, and the Mirror screen needs a WebKit that supports WebCodecs. |
| Node.js 22.12 or newer | The toolchain (Vite 8, Vitest 5) requires it. |
| Rust 1.93 or newer | The newest dependency in the lockfile requires it. Install with [rustup](https://rustup.rs). |
| Xcode Command Line Tools | `xcode-select --install`. The build compiles C code (SQLite) and uses `lipo` and `codesign`. |
| An Android phone and a USB cable | **USB debugging** must be on. Android 11 or newer is only required for wireless pairing. |

You do **not** need Android Studio or a separate copy of `adb`. Droid Shuttle bundles Google's platform-tools.

## 2. Build and run

```bash
git clone https://github.com/ammarmunir4567/droid-shuttle.git
cd droid-shuttle

npm install
./scripts/fetch-adb.sh
npm run tauri dev
```

What each step does:

- `npm install` installs the JavaScript dependencies. Rust crates download on the first build.
- `./scripts/fetch-adb.sh` downloads `platform-tools-latest-darwin.zip` from `dl.google.com`, extracts `adb`, and writes three ad-hoc signed sidecars to `src-tauri/binaries/`: one each for Apple Silicon and Intel, plus Google's universal binary. It also copies Google's notice file. You only need to run it once, and again whenever you want a newer `adb`.
- `npm run tauri dev` builds the Rust backend and starts the interface with hot reload.

> [!IMPORTANT]
> Run `fetch-adb.sh` before the first build. Without the sidecar, the Rust build fails with `resource path binaries/adb-aarch64-apple-darwin doesn't exist`. This applies to `tauri dev`, `tauri build`, `cargo build`, `cargo check` and `cargo test` alike.

### Building an app bundle

```bash
npm run tauri build
```

This produces `Droid Shuttle.app` and a `.dmg` for your Mac's architecture under `src-tauri/target/release/bundle/`.

For a universal build that runs natively on Apple Silicon and Intel:

```bash
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

The output is under `src-tauri/target/universal-apple-darwin/release/bundle/`.

The app is **ad-hoc signed** (`signingIdentity` is `-`) and **not notarized**. An app you built yourself opens normally. If you give the `.app` or `.dmg` to someone else, macOS Gatekeeper treats it as coming from an unidentified developer: right-click the app, choose **Open**, then confirm.

## 3. Prepare the phone

You only do this once per phone.

1. Open **Settings → About phone**, then tap **Build number** seven times. Android tells you that Developer options are on.
2. Open **Developer options** (its location in Settings varies by phone; searching Settings for "Developer options" finds it) and turn on **USB debugging**.
3. Connect the phone to the Mac with a USB cable and unlock the screen.
4. Pull down the notification shade, tap the **USB** notification, and choose **File transfer**.
5. The phone asks **Allow USB debugging?**. Tick **Always allow from this computer** so it does not ask again, then tap **Allow**.

Droid Shuttle's own **Connect your Android phone** screen shows the same short steps while it waits.

## 4. What the connection screen tells you

Until a phone is ready, the app shows a guide in place of the screens:

| You see | It means | Do this |
|---|---|---|
| **Connect your Android phone** and "Waiting for a device…" | No phone detected. | Plug it in with a USB cable and unlock the screen. Follow the numbered steps on screen. |
| **Allow this Mac on your phone** | The phone sees the Mac but has not approved it. | Tap **Allow** on the phone's **Allow USB debugging?** prompt, and tick **Always allow from this computer**. |
| **Device is offline** (or *recovery*, *sideload*, *other*) | The phone is connected in a state the app cannot use. | Unplug and reconnect the cable, then unlock the phone. |
| **Can't reach the ADB service** | The app could not talk to an ADB server. | See [Troubleshooting](troubleshooting.md#cant-reach-the-adb-service). |

The device card at the top of the sidebar shows the phone's name, **Connected by cable** (or **Connected over Wi-Fi**), the free storage as a bar, and the battery level. While the phone waits for approval it reads **Waiting for approval**; with no phone it reads **No phone** and **Plug one in with a cable**.

Plugging in a second phone adds it to a **Switch phone** menu on the device card. The whole app works on the phone you select.

## 5. A first tour

<p align="center">
  <img src="media/screenshots/files-single-pane.png" width="860" alt="The Files screen in its default single-pane mode, listing the phone's internal storage.">
</p>

1. **Look around.** The sidebar has seven screens in two groups: **Files** and **Gallery** under *Browse*, and **Apps**, **Storage**, **Backup**, **Mirror** and **Tools** under *Manage*. The app opens on **Files**.
2. **Show the Mac next to the phone.** In the Files toolbar, click **Show Mac side by side**. The Mac appears as a second pane, starting in your home folder.
3. **Copy a file.** Click a file in the phone pane and press **F5** (or click **Copy to Mac** in the bar at the bottom). On a Mac keyboard you may need to hold **Fn** for F5.
4. **Watch the transfer.** A transfer tray appears at the bottom of the window. Pause, cancel or collapse it from there.
5. **Find what uses space.** Open **Storage** and click **Scan phone storage**. Scanning only reads the phone.
6. **Press ⌘K.** The command palette jumps to any screen and switches the look.

From here, the user guide pages describe each screen in depth: [Files](user-guide/files.md), [Gallery](user-guide/gallery.md), [Apps](user-guide/apps.md), [Storage](user-guide/storage.md), [Backup](user-guide/backup.md), [Mirror](user-guide/mirror.md) and [Tools](user-guide/tools.md).

## 6. Updating

- **The app:** pull the latest code, run `npm install`, and rebuild.
- **`adb`:** run `./scripts/fetch-adb.sh` again. It always downloads the latest platform-tools, so the version is not pinned.

## 7. Removing the app's data

The app stores its data in `~/Library/Application Support/ai.arqanum.droidshuttle`, `~/Library/Caches/ai.arqanum.droidshuttle` and (for remembered settings) `~/Library/WebKit/ai.arqanum.droidshuttle`. To start from scratch, quit the app and delete those folders. [Privacy and data](privacy-and-data.md) lists everything that is stored and where.
