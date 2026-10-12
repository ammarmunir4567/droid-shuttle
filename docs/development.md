# Development

How to run, test and package Droid Shuttle, and how to work on it safely. For the design behind the code, read [Architecture](architecture.md).

## Contents

- [Setup](#setup)
- [Running](#running)
- [Scripts](#scripts)
- [Testing](#testing)
- [Packaging](#packaging)
- [Updating bundled components](#updating-bundled-components)
- [Conventions](#conventions)
- [Development troubleshooting](#development-troubleshooting)

## Setup

| Requirement | Version | Why |
|---|---|---|
| macOS | current | The app is macOS only |
| Node.js | **22.12 or newer** | Vite 8 needs `^20.19 \|\| >=22.12`, Vitest 5 needs `^22.12 \|\| ^24 \|\| >=26`. `jsdom` (a dev dependency) asks for 22.22.2, which only matters as an npm warning. The project is developed on Node 22.22 with npm 10.9. |
| Rust | **1.93 or newer** (stable) | The newest crate in `Cargo.lock` (`apk-info`) requires it. The crate itself declares only `edition = "2021"`. |
| Xcode Command Line Tools | any recent | The build compiles C (SQLite, bundled) and uses `lipo`, `codesign` and `shasum`. |
| `rustup target add x86_64-apple-darwin` | | Only for universal builds. |
| `npx playwright install chromium` | | Only for the end-to-end tests. Run it once. |

```bash
git clone https://github.com/ammarmunir4567/droid-shuttle.git
cd droid-shuttle
npm install
./scripts/fetch-adb.sh
```

`fetch-adb.sh` downloads Google's `platform-tools-latest-darwin.zip`, thins `adb` for each architecture with `lipo`, keeps Google's universal binary, ad-hoc signs all three, and writes them to `src-tauri/binaries/adb-{aarch64,x86_64,universal}-apple-darwin` together with `adb-NOTICE.txt`. The folder is git-ignored.

> [!IMPORTANT]
> **Run the script before any cargo or Tauri command.** `tauri.conf.json` declares `binaries/adb` as an `externalBin` and `binaries/adb-NOTICE.txt` as a resource. If they are missing, the Rust build script fails with `resource path binaries/adb-aarch64-apple-darwin doesn't exist`. This affects `tauri dev`, `tauri build`, `cargo build`, `cargo check` and `cargo test`.

If `cargo` is not on your `PATH`, run `source "$HOME/.cargo/env"` (rustup's installer adds it for new shells).

## Running

There are two ways to run the interface.

### In a browser, with a mock phone

```bash
npm run dev
```

Opens Vite on **port 1420** (`strictPort`, localhost only). No Rust, no phone. The bridge detects that it is not inside Tauri and answers every call from a built-in mock: one "Pixel 8 Pro", a file tree, 600 photos, 12 apps, a storage tree with duplicates, a log stream and a shell. Use this for interface work.

> [!NOTE]
> The mock is a stand-in. Some details differ from a real phone, for example the mock photos have no video durations, and mirroring shows a gradient instead of a screen.

### As the real app

```bash
npm run tauri dev
```

Builds the Rust backend, starts Vite as the `beforeDevCommand`, and opens the window on `http://localhost:1420`. Backend log messages print in this terminal. The first build compiles many crates and takes a few minutes; dependencies are compiled with optimizations even in dev (`opt-level = 3` in `Cargo.toml`), because image decoding, hashing and SQLite are unusably slow otherwise.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 1420 (browser, mock backend) |
| `npm run tauri dev` | The real app with hot reload |
| `npm run build` | `tsc && vite build`: type-checks, then builds the interface into `dist/`. Also the Tauri `beforeBuildCommand` |
| `npm run preview` | Serves the built interface |
| `npm run test:unit` | Vitest (`src/**/*.test.ts`, node environment) |
| `npm run test:e2e` | Playwright against the browser mock |
| `npm run tauri build` | Builds `Droid Shuttle.app` and a `.dmg` |
| `cd src-tauri && cargo test` | The Rust tests that do not need a phone |
| `npx tsc` | Type-check only (`noEmit`). The config is strict and rejects unused locals and parameters. It covers `src/` only, not `tests/` |

## Testing

| Layer | Tool | Count at 0.1.0 | Needs |
|---|---|---|---|
| Unit | Vitest | 24 tests in 4 files | nothing |
| End to end | Playwright | 107 tests in 11 files | Chromium installed once; the mock backend |
| Backend | `cargo test` | 70 tests: 57 run by default, 13 `#[ignore]`d | The 13 need a phone or macOS services |

```bash
npm run test:unit
npm run test:e2e
(cd src-tauri && cargo test)
```

**Unit tests** cover pure logic: log parsing and filtering (`src/lib/logcat.test.ts`), mirror key mapping and codec strings (`src/lib/mirror.test.ts`), the treemap (`src/features/storage/treemap.test.ts`) and the keep-one-copy rule (`src/features/storage/dupes.test.ts`).

**End-to-end tests** (`tests/e2e/`) drive the real interface in Chromium at 1280 × 800 against the mock backend and assert both what you see and the calls the interface made (`window.__calls`). The Playwright config starts `npx vite --port 5199` itself and **reuses a server that is already listening on that port**, so a stale server on 5199 is reused. Files: `appearance`, `apps`, `backup`, `brand`, `dual`, `files`, `gallery`, `mirror`, `resume`, `storage` and `tools`.

**Rust tests** include a fake ADB server (`adb/fake.rs`) that lets the transfer engine, the resume logic and the storage scan run in-process, including a simulated pulled cable. The tests that use it serialize on a lock. One test checks that the bundled scrcpy server still matches its published SHA-256.

### Live tests (need a phone)

The 13 ignored tests run against a real, authorized phone (the first ready device) unless noted. Run one with its filter:

```bash
cd src-tauri
cargo test live_engine -- --ignored --nocapture --test-threads=1
```

| Filter | File | Needs | Notes |
|---|---|---|---|
| `live_device` | `device/mod.rs` | phone | Device discovery round trip |
| `live_push` | `transfer/mod.rs` | phone | Push, list, pull round trip |
| `live_engine` | `transfer/mod.rs` | phone | The engine end to end |
| `live_big_file` | `transfer/mod.rs` | phone | **Writes a 4.2 GB file; takes about four minutes** |
| `live_stage` | `transfer/mod.rs` | phone | Staging for the clipboard |
| `live_apps` | `apps.rs` | phone | The app pipeline |
| `live_backup` | `backup.rs` | phone | Incremental backup, restore and cancel |
| `live_encrypted` | `backup.rs` | macOS only (`hdiutil`, Keychain) | No phone needed |
| `live_gallery` | `media.rs` | phone | The gallery pipeline |
| `live_mirror` | `mirror.rs` | phone | Optional environment: `SCRCPY_EXTRA`, `SCRCPY_FPS`, `SCRCPY_SIZE`, `SCRCPY_MBPS` |
| `live_screenshot` | `mirror.rs` | phone | Screenshot and recording. (A comment in `mirror.rs` says `live_capture`, which matches nothing.) |
| `live_tools` | `tools.rs` | phone | Shell, logcat, device status |
| `live_clipboard` | `native_drag.rs` | macOS | **Changes your real clipboard** |

`cargo test live_ -- --ignored` runs **all** of them, including the 4 GB test.

## Packaging

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/macos/Droid Shuttle.app` and `…/bundle/dmg/Droid Shuttle_0.1.0_<arch>.dmg`. `bundle.targets` is `"all"`.

A universal build:

```bash
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

Output: `src-tauri/target/universal-apple-darwin/release/bundle/{macos,dmg}`. The bundled sidecar is Google's universal `adb`. The Intel half of a universal build has only been run under Rosetta, not on Intel hardware.

Signing is ad-hoc (`bundle.macOS.signingIdentity` is `"-"`). There is no notarization and no minimum system version is set. To distribute outside your own Mac you would add a Developer ID certificate and notarization to `tauri.conf.json`.

The version lives in three places that must change together: `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.

## Updating bundled components

**adb.** Run `./scripts/fetch-adb.sh`. It always downloads the *latest* platform-tools, so the version is not pinned. The notice at `src-tauri/resources/NOTICE.md` names the version that was current when it was written (37.0.1).

**The scrcpy server.** Client and server versions must match exactly, so replace them together:

1. Download `scrcpy-server-v<version>` from the [scrcpy release](https://github.com/Genymobile/scrcpy/releases) and put it in `src-tauri/resources/`.
2. In `src-tauri/src/mirror.rs`, update `SERVER_VERSION`, `SERVER_SHA256` and the `include_bytes!` path.
3. Check the protocol notes at the top of `mirror.rs` still match the new version.
4. Update `src-tauri/resources/NOTICE.md`.
5. Run `cargo test`: `bundled_server_matches_its_published_checksum` verifies the file.

## Conventions

- **Style the interface with tokens only** (`var(--fg)`, `var(--color-accent)`, …). Never hard-code colours in a component; a new look must not need component changes.
- **Every new bridge method needs a mock** in `src/lib/api.ts`, recorded with `rec()` if a test should assert on it. The browser build must stay fully usable without Rust.
- **Add tests with the change:** a unit test for pure logic, an e2e spec for visible behaviour, a Rust test (using the fake ADB server where possible) for backend behaviour.
- **TypeScript is strict.** `noUnusedLocals` and `noUnusedParameters` are on.
- **Keep scope.** The app talks to the phone over ADB and installs nothing on it. Features that would need an on-phone app (contacts, messages, call logs) are out of scope.
- **Destructive actions confirm.** Anything that deletes from the phone goes through a dialog that says it cannot be undone.
- **Remembered options use the `db.` prefix** in local storage, and passwords are never stored there.
- **Names.** The product is **Droid Shuttle**, the bundle identifier is `ai.arqanum.droidshuttle`, and the Rust library is `droid_shuttle_lib`. The app was called *Droidbridge* before; only the data and Keychain migration code (and the test that guards the UI against the old name) should mention it.
- **Work on a branch** and open a pull request against `main`.

## Development troubleshooting

| Symptom | Cause and fix |
|---|---|
| `resource path binaries/adb-… doesn't exist` | Run `./scripts/fetch-adb.sh`. |
| `Error: Port 1420 is already in use` | `npm run dev` uses `strictPort`. Stop the other Vite or Tauri dev session. |
| Playwright tests hit an old build | A server from an earlier run is still listening on port 5199 and is reused. Stop it. |
| `browserType.launch: Executable doesn't exist` | Run `npx playwright install chromium`. |
| `cargo: command not found` | Install Rust with rustup and run `source "$HOME/.cargo/env"`. |
| `npm` engine warnings about `jsdom` | `jsdom` asks for Node 22.22.2 or newer. It is a dev dependency that is not currently used by the tests. |
