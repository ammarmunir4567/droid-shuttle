# Changelog

All notable changes to Droid Shuttle are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0]

The first public release.

### Added

- **Files**: a two-pane file manager for the phone and the Mac, with drag and drop, Finder clipboard support, F5 to F8 shortcuts, pause, SHA-256 verification, and transfers that continue after the cable is pulled.
- **Gallery**: browse photos and videos by day or month, open them full size, and import everything new in one click.
- **Apps**: list installed apps with names and icons, install `.apk`, `.apks`, `.xapk` and `.apkm` files, uninstall, disable, force-stop, clear data, and save APKs to the Mac.
- **Storage**: scan the phone, then explore a treemap, a breakdown by file type, the largest files and a duplicate finder.
- **Backup**: incremental backups of chosen folders and app installers, optionally in an AES-256 encrypted disk image, with restore.
- **Mirror**: view and control the phone's screen from the Mac, take screenshots and record the screen.
- **Tools**: device status, an interactive terminal, a log viewer and wireless debugging with QR or code pairing.
- A menu-bar item with Dock progress and notifications, Quick Look for phone files, a command palette (⌘K), and three looks (Studio, Instrument and Soft) in light and dark.
- Bundled `adb` (Google platform-tools) and the scrcpy server, so there is nothing else to install.
- DMG downloads for Apple silicon and Intel.

### Known limitations

- The app is ad-hoc signed and **not notarized**, so macOS blocks the first launch of a downloaded copy. See [First launch](docs/getting-started.md#first-launch).
- Mirror has no audio and no multi-touch.
- Only a small number of phones have been tested, only on current macOS (the DMGs were checked on macOS 27), and the Intel build has only been run under Rosetta on an Apple silicon Mac.

[0.1.0]: https://github.com/ammarmunir4567/droid-shuttle/releases/tag/v0.1.0
