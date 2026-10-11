# Third-party components

## scrcpy-server v4.1
`scrcpy-server-v4.1` is the unmodified server component of **scrcpy** by Genymobile / Romain Vimont,
licensed under the Apache License 2.0 (https://github.com/Genymobile/scrcpy/blob/master/LICENSE).
Downloaded from https://github.com/Genymobile/scrcpy/releases/tag/v4.1 and verified against the
published SHA-256 `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae`.
Droid Shuttle pushes it to the phone only while mirroring. The client and server versions must match
exactly, so upgrading means replacing this file and `SERVER_VERSION` in `src/mirror.rs` together.

## Android Debug Bridge (adb) 37.0.1
`adb` is the unmodified arm64 build from Google's official Android SDK Platform-Tools
(https://developer.android.com/tools/releases/platform-tools), licensed under the Apache License 2.0
with additional third-party notices in `adb-NOTICE.txt`. It is installed by `scripts/fetch-adb.sh` and
shipped next to the app executable so no separate Android tooling is needed.
