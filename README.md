<p align="center">
  <img src="brand/icon.png" width="128" height="128" alt="Droid Shuttle app icon: a coral shuttle sliding along a thread between a phone and a Mac">
</p>

<h1 align="center">Droid Shuttle</h1>

<p align="center">
  <strong>Free, open-source Android ⇄ Mac manager.</strong><br>
  Move files, import photos, see what is using space, back up with encryption, mirror the screen and open a shell, all over a USB cable.<br>
  Nothing to install on the phone, and the app makes no network requests of its own.
</p>

<p align="center">
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-111827?logo=apple&logoColor=white">
  <img alt="Built with Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.93%2B-B7410E?logo=rust&logoColor=white">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2F6BEA"></a>
</p>

<p align="center">
  <a href="docs/media/droid-shuttle-demo.mp4">
    <img src="docs/media/droid-shuttle-demo.gif" width="720" alt="22-second demo: a coral shuttle crosses from Android to Mac, then the app shows the two-pane file manager moving Holiday.mp4 to the Mac, the storage map, and an encrypted backup.">
  </a>
  <br>
  <sub>▶ <a href="docs/media/droid-shuttle-demo.mp4">Watch the 22-second demo with sound (MP4)</a>. It shows the app's built-in demo data, not a real phone.</sub>
</p>

---

## Contents

- [Highlights](#highlights)
- [Getting started](#getting-started)
- [Documentation](#documentation)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Project status](#project-status)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)
- [Credits and third-party software](#credits-and-third-party-software)

## Highlights

| Screen | What you can do |
|---|---|
| **Files** | A two-pane file manager for phone and Mac. Drag between panes, drag out to Finder, copy and paste with Finder, F5 to copy and F6 to move. Transfers can pause, verify with SHA-256, and **continue where they stopped if you pull the cable**. |
| **Gallery** | Browse the phone's photos and videos by day or month, open them full size with zoom and camera details, and **import everything new** in one click. The app remembers what you already imported. |
| **Apps** | See installed apps with their real names and icons. Install `.apk`, `.apks`, `.xapk` and `.apkm` files by dropping them, uninstall or disable apps, force-stop, clear data and save APKs to the Mac. |
| **Storage** | Scan once, then explore a treemap, a breakdown by file type, the largest files and a **duplicate finder** that hashes on the phone. |
| **Backup** | Incremental backups of the folders you choose plus your apps' installers, optionally in an **AES-256 encrypted disk image**. Restore to the phone later. |
| **Mirror** | See the phone's screen on the Mac and control it with mouse and keyboard. Take screenshots and record the screen. |
| **Tools** | Battery, memory and device details, an interactive terminal, a filterable log viewer, and **wireless debugging** with QR or code pairing. |

On top of that: a menu-bar item with Dock progress and notifications, Quick Look for phone files, a command palette (⌘K), and three complete looks (Studio, Instrument and Soft) in light and dark.

<p align="center">
  <img src="docs/media/screenshots/files-two-panes.png" width="860" alt="The Files screen in two-pane mode: the phone on the left, the Mac on the right, with F5 Copy to Mac and F6 Move to Mac in the function bar.">
</p>
<p align="center">
  <img src="docs/media/screenshots/storage-map.png" width="425" alt="The Storage screen: a breakdown by file type above a treemap of folders sized by space.">
  <img src="docs/media/screenshots/backup.png" width="425" alt="The Backup screen: choose a destination, optionally encrypt, pick folders, back up now.">
</p>

## Getting started

> [!NOTE]
> There are no prebuilt downloads yet. You build the app once from source; it takes a few minutes.

### Requirements

| You need | Version | Notes |
|---|---|---|
| A Mac | Apple Silicon or Intel | macOS only. No minimum macOS version is declared; the project is developed on current macOS releases. |
| Node.js | 22.12 or newer | With npm. |
| Rust | 1.93 or newer (stable) | Install with [rustup](https://rustup.rs). |
| Xcode Command Line Tools | any recent | `xcode-select --install` |
| An Android phone | with **USB debugging** on | Android 11 or newer is only needed for wireless pairing. |

### Build and run

```bash
git clone https://github.com/ammarmunir4567/droid-shuttle.git
cd droid-shuttle

npm install
./scripts/fetch-adb.sh     # once: downloads Google's platform-tools and bundles adb
npm run tauri dev          # starts the app with hot reload
```

> [!IMPORTANT]
> Run `./scripts/fetch-adb.sh` before your first build or `cargo` command. The app ships `adb` as a sidecar, and the Rust build stops with `resource path binaries/adb-… doesn't exist` if it is missing.

To produce a `.app` and a `.dmg`:

```bash
npm run tauri build                                              # for this Mac's architecture
# or a universal (Apple Silicon + Intel) build:
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

The results are under `src-tauri/target/release/bundle/` (or `src-tauri/target/universal-apple-darwin/release/bundle/` for the universal build). The app is ad-hoc signed and not notarized, so macOS may ask you to confirm the first launch if you share the build with someone else: right-click the app, choose **Open**, then confirm.

More detail, including tests and the browser-only mock mode, is in [Development](docs/development.md).

### Connect your phone

1. On the phone, open **Settings → About phone** and tap **Build number** seven times to unlock Developer options.
2. Open **Developer options** and turn on **USB debugging**.
3. Plug the phone into the Mac and unlock it. Pull down the notification shade, tap **USB**, and choose **File transfer**.
4. When the phone asks **Allow USB debugging?**, tick **Always allow from this computer** and tap **Allow**.

Droid Shuttle detects the phone the moment it is plugged in. See [Getting started](docs/getting-started.md) for a first tour and [Troubleshooting](docs/troubleshooting.md) if the phone does not appear.

## Documentation

| Guide | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | Requirements, building, connecting a phone, a first tour |
| [Files](docs/user-guide/files.md) | Two panes, transfers, drag and drop, clipboard, resume after unplugging |
| [Gallery](docs/user-guide/gallery.md) | Browsing, the viewer, importing, the imported ledger |
| [Apps](docs/user-guide/apps.md) | Installing, uninstalling, saving APKs, bundles |
| [Storage](docs/user-guide/storage.md) | Scanning, the map, large files, duplicates |
| [Backup](docs/user-guide/backup.md) | What is backed up, encryption, incremental logic, restore |
| [Mirror](docs/user-guide/mirror.md) | Mirroring, input, screenshots and recording |
| [Tools](docs/user-guide/tools.md) | Device status, terminal, logcat, wireless debugging |
| [Menu bar and notifications](docs/user-guide/menu-bar.md) | Menu-bar mode, Dock progress, closing the window |
| [Appearance and command palette](docs/user-guide/appearance.md) | The three looks, brightness, ⌘K |
| [Keyboard shortcuts](docs/user-guide/keyboard-shortcuts.md) | Every shortcut in one place |
| [Troubleshooting](docs/troubleshooting.md) | Connection problems, errors and what they mean |
| [Privacy and data](docs/privacy-and-data.md) | What is stored where, what is sent (nothing), permissions |
| [Architecture](docs/architecture.md) | How the app is built |
| [Development](docs/development.md) | Building, testing, releasing, conventions |

## How it works

- **No companion app.** Droid Shuttle talks to the phone through Android's own tooling, using **ADB** (the Android Debug Bridge).
- **Its own ADB client.** The Rust backend speaks the ADB server protocol directly to `127.0.0.1:5037`, which gives instant hot-plug detection and fast transfers without starting a process for every call. A copy of Google's `adb` is bundled so nothing else needs installing.
- **Mirroring** uses the server from [scrcpy](https://github.com/Genymobile/scrcpy), bundled unmodified, and decodes the video in the app window.
- **Everything else** is stock Android shell commands (`pm`, `dumpsys`, `find`, `stat`, `sha256sum`, `logcat`, …) run over ADB.

The full picture, with diagrams, is in [Architecture](docs/architecture.md).

## Privacy

Droid Shuttle makes **no network requests of its own** and has **no telemetry, analytics or update checks**. Your files go straight between the phone and the Mac. The only web address it can open is the Apple Maps link behind **Show location in Maps** in the Gallery viewer, and only when you click it. Details are in [Privacy and data](docs/privacy-and-data.md).

## Project status

Droid Shuttle is at **version 0.1.0**. It is a young project built for macOS, and it has been developed against a small number of phones, so expect rough edges.

Things worth knowing before you rely on it:

- **Deleting from the phone is permanent.** Android has no Trash over USB. Delete dialogs say so. Moves between the phone and the Mac (F6, ⌘-drag, cut and paste) delete the originals once the copy succeeds, without a second prompt.
- **Mirror is video only.** There is no audio and no multi-touch. Secure apps, such as banking apps, appear black because Android blocks capturing them.
- **Storage scans are not saved.** The scan lives in memory until you quit the app.
- **macOS only.** The app uses native macOS features (the Keychain, `hdiutil`, Quick Look, native drag and drop). Windows and Linux are not supported.

Each guide lists the limits that apply to its screen.

## Development

```bash
npm run dev          # the interface in a browser with a built-in mock phone (port 1420)
npm run tauri dev    # the real app
npm run build        # type-check and build the frontend
npm run test:unit    # Vitest
npm run test:e2e     # Playwright against the mock phone
cd src-tauri && cargo test
```

Tech stack: **Tauri 2** (Rust) · **React 19** · **TypeScript** · **Vite** · **Tailwind CSS 4** · **Zustand** · **TanStack Query** · **Radix UI** · **xterm.js**.

```text
src/            React interface: screens in features/, shell and looks, typed bridge in lib/api.ts
src-tauri/      Rust backend: ADB client, transfer engine, backup, storage, mirror, tools
tests/e2e/      Playwright tests that run against the browser mock
scripts/        fetch-adb.sh
brand/          app icon and menu-bar icon sources
docs/           documentation and media
```

See [Development](docs/development.md) for the complete workflow.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Droid Shuttle is released under the [MIT License](LICENSE).

## Credits and third-party software

- **[scrcpy](https://github.com/Genymobile/scrcpy)** by Genymobile and Romain Vimont: the unmodified server v4.1 that powers Mirror (Apache License 2.0).
- **Android platform-tools** by Google: the bundled `adb` (Apache License 2.0, with additional notices shipped in the app).
- Full notices live in [`src-tauri/resources/NOTICE.md`](src-tauri/resources/NOTICE.md) and are bundled inside the app.
- Interface built with [Tauri](https://tauri.app), [React](https://react.dev), [Radix UI](https://www.radix-ui.com), [Lucide](https://lucide.dev) icons, [xterm.js](https://xtermjs.org), IBM Plex Sans and Nunito.
- The demo video was made with the `/brag` skill and [Hyperframes](https://hyperframes.heygen.com/). Music: "Happy Beats / Business Moves" by [ende.app](https://ende.app/en). Sound effects by [Kenney](https://kenney.nl/) (CC0). See [`docs/media`](docs/media/README.md).
