# Troubleshooting

Find your symptom, then follow the steps. Quoted text is exactly what the app shows.

## Contents

- [Installing and opening the app](#installing-and-opening-the-app)
- [Connection](#connection)
- [Transfers](#transfers)
- [Files and folders](#files-and-folders)
- [Gallery](#gallery)
- [Apps](#apps)
- [Storage](#storage)
- [Backup](#backup)
- [Mirror](#mirror)
- [Wireless](#wireless)
- [Leftover files on your Mac and phone](#leftover-files-on-your-mac-and-phone)
- [Starting over](#starting-over)
- [Still stuck](#still-stuck)

## Installing and opening the app

### macOS says Droid Shuttle was "Not Opened", or will not open

The app is not notarized by Apple, so macOS blocks the first launch of a downloaded copy. Follow [First launch](getting-started.md#first-launch): on macOS 15 and later, open **System Settings → Privacy & Security** and click **Open Anyway**; on any version, `xattr -dr com.apple.quarantine "/Applications/Droid Shuttle.app"` in Terminal removes the block.

### "You can't use this version of the application with this Mac"

You opened the Apple silicon DMG (`aarch64`) on an Intel Mac. Delete the app and install the `x64` DMG from the [releases page](https://github.com/ammarmunir4567/droid-shuttle/releases/latest). **Apple menu → About This Mac** shows which you have: a **Chip** line that starts with *Apple* is Apple silicon, and a **Processor** line is Intel.

### The DMG will not open

The download was probably cut short. Download it again and check it with the [checksum command](getting-started.md#check-the-download-optional).

## Connection

### The phone does not appear ("Connect your Android phone")

1. Use a USB cable that carries **data**. Some cables only charge.
2. Unlock the phone's screen.
3. Pull down the notification shade, tap the **USB** notification, and choose **File transfer**.
4. Turn on **USB debugging** in **Developer options**. If you do not see Developer options, open **Settings → About phone** and tap **Build number** seven times.
5. Unplug and replug the cable, and watch the phone for the **Allow USB debugging?** prompt.

### "Allow this Mac on your phone"

The phone sees the Mac but has not approved it. Look at the phone's screen and tap **Allow** on the **Allow USB debugging?** prompt, and tick **Always allow from this computer**.

If the prompt never appears, unlock the phone and replug the cable. On most phones you can also reset the approvals with **Revoke USB debugging authorizations** in Developer options, then plug in again.

### "Device is offline" (or "recovery", "sideload", "other")

The phone is connected in a state the app cannot use. Unplug and reconnect the cable, then unlock the phone. If it stays offline, restart the phone.

### "Can't reach the ADB service"

Droid Shuttle talks to an ADB server on `127.0.0.1:5037`. When none is running, it starts one with the `adb` bundled inside the app, falling back to `/opt/homebrew/bin/adb` or `/usr/local/bin/adb`. The message appears when that fails. The error text under the heading says why:

- **"adb binary not found; install platform-tools"**: the bundled `adb` is missing (a build that skipped `./scripts/fetch-adb.sh`), and there is none in Homebrew's folders. Install Android platform-tools with:

  ```bash
  brew install --cask android-platform-tools
  ```

  or run `./scripts/fetch-adb.sh` and rebuild.
- **"adb server unreachable: …"**: something else is using port 5037, or an existing server is stuck. If another copy of `adb` is already running its server, Droid Shuttle uses that server as it is, without checking its version. Stop it and reopen the app:

  ```bash
  adb kill-server
  ```

### I plugged in a second phone

The device card gets a **Switch phone** menu. The whole app works on the selected phone only. The menu-bar item and its **Take Phone Screenshot** use the first ready phone instead.

## Transfers

### "Waiting for your phone…"

The cable was pulled, or the phone went offline. Transfers pause by themselves and carry on when the same phone returns ("Phone is back. Transfers are continuing."). See [how resume works](user-guide/files.md#if-you-unplug-the-cable). There is no time limit; **Cancel** a row to give up.

If you quit the app while a transfer was waiting, nothing resumes on the next launch. Start the transfer again.

### A transfer failed with "checksum mismatch — copy discarded"

You had **Verify transfers with SHA-256** on, and the copy's checksum did not match the phone's. The copy was removed. Try again, and check the cable.

### Files of 16 MiB or more show as "…droidshuttle-part" on the phone

That is the temporary name used while a Mac → phone copy is in progress. It is renamed when the file is complete. If a transfer was cancelled while waiting for the phone, the temporary file can stay behind on the phone. See [Leftover files](#leftover-files-on-your-mac-and-phone).

### F5 to F8 do nothing

On a Mac keyboard these usually need **Fn**. Use the context menu or the buttons in the function bar, or turn on **Use F1, F2, etc. keys as standard function keys** in System Settings.

## Files and folders

### "Android restricts this folder"

Android 11 and newer blocks app folders such as `Android/data` and `Android/obb` from file managers. This is an Android rule, not a bug in the app.

### I pressed Enter and the file did not open

**Enter renames.** Open with a double-click, ⌘↓ on a folder, or **Open** in the context menu.

### Dropping files from Finder put them in the wrong folder

On every screen except Apps, a drop that is not on a specific folder lands in the phone Files pane's **current folder** (`/sdcard` by default). Drop onto a folder row, a breadcrumb or a Place to choose the target.

### "Couldn't drag to Finder"

The drag could not start. Use **Save to Mac…** in the phone pane's context menu instead.

## Gallery

### Photos or videos are missing

The Gallery lists what Android's MediaStore knows about. Files in folders with a `.nomedia` file, and files MediaStore has not scanned yet, do not appear. Click **Refresh from phone**. Files you just deleted in Storage stay in the list until the next refresh.

### Thumbnails are slow, especially for videos

Photo thumbnails need the photo to travel over USB. Video thumbnails come from the phone's own frame extractor, about 1.4 seconds each, two at a time. They are cached afterwards.

### A video will not play in the viewer

The viewer plays the original with the macOS web view. It does not transcode, so a format the web view cannot play will not play. **Show in Files** and open it in another app.

### HEIC or RAW photos show no thumbnail

They are decoded by macOS's built-in `sips`. If `sips` cannot handle that file, the app falls back to the phone's own thumbnail, and if that is missing too the tile shows an "image off" icon. The import still copies the original file.

## Apps

### An install fails

The message tells you why. Common ones: "A newer version of this app is already installed. Uninstall it first to install an older one.", "This app is signed differently from the installed copy. Uninstall the installed app first (its data will be lost).", "The phone blocked the install. Enable “Install via USB” in Developer options, then try again." and "The install was declined on the phone. Approve the prompt on the screen and try again."

### An `.apks` or `.apkm` bundle installs without my language

Only **English** language splits are kept from a bundle. Other languages are dropped.

### Names and icons are missing

They are read from each app's package in the background and fill in as they arrive. Until then the row shows a name guessed from the package, and a coloured letter.

## Storage

### The numbers do not match "Phone: X of Y used"

The scan covers shared storage (`/sdcard`) only, not app data or system files. The "used" figure is the phone's own report.

### Everything is gone after relaunching

The scan lives in memory only. Click **Scan phone storage** again.

### Duplicate finding is slow

The phone hashes the files, so large videos take time. **Cancel** is checked between batches.

## Backup

### "A backup is already running."

Only one backup runs at a time. Wait for it, or press **Cancel**.

### "The backup password isn't in your Keychain. Enter it to continue."

The encrypted image already exists, but its password is not in your Keychain, and the Backup screen has no place to type it. Common causes: the `.sparsebundle` was moved or renamed (the saved password is tied to its path), or the Keychain item was deleted. Ways forward:

- Move the image back to where it was, so the Keychain lookup matches again.
- Use **Restore from an encrypted backup…**; it does ask for the password, and you can copy files out of the unlocked image.
- Back up to a new destination with **Encrypt this backup**, which creates a fresh image and a new password.

### "folder no longer exists on the phone"

You are backing up a folder you selected earlier on another phone. The run carries on without it. Untick the folder, or click **Recommended**.

## Mirror

### The picture is black

The phone's screen is off or locked, or the app on screen blocks screen capture (banking apps do). Wake and unlock the phone, or click **Wake phone**.

### "Your phone blocked screen control. On some phones (Xiaomi/Redmi, OPPO, Vivo) enable “USB debugging (Security settings)” in Developer options."

Turn on the additional toggle your phone's Developer options offers for injecting input.

### "This version of macOS can't decode the phone's video in the app window."

The web view lacks WebCodecs. Update macOS.

### "Mirroring server version mismatch."

The bundled server and the app disagree. Reinstall Droid Shuttle.

More messages are listed in [Mirror](user-guide/mirror.md#if-it-does-not-work).

## Wireless

### Nothing is found under "Found on your network"

Both devices must be on the same Wi-Fi network, and **Wireless debugging** must be turned on in the phone's Developer options. The list refreshes every 3 seconds.

### The QR code does not pair

Keep the phone's **Pair device with QR code** scanner open until it succeeds. The code works once and expires in two minutes. Click **Show QR code** again for a fresh one. Pairing by QR code or by pairing code needs Android 11 or newer.

### "The phone isn't connected to Wi-Fi. Connect it to the same network as this Mac first."

**Go wireless** reads the phone's Wi-Fi address and could not find one. Connect the phone to Wi-Fi first.

### "The phone didn't accept a connection at …"

The phone and the Mac must be on the same Wi-Fi network. Some routers block devices from talking to each other (client or AP isolation).

## Leftover files on your Mac and phone

Droid Shuttle cleans up after itself in most cases, but a few things can remain:

| Where | What | Why |
|---|---|---|
| Any destination folder | `*.droidshuttle-part` | A transfer was interrupted and the app quit before it could resume. Delete it, or start the transfer again. |
| The phone: the folder of an unfinished upload | `*.droidshuttle-part` | You cancelled a Mac → phone copy while it was waiting for the phone. Delete it from the Files screen. |
| `$TMPDIR/droidshuttle-preview/` on the Mac | Copies of phone files you opened or Quick Looked | The app does not delete them. |
| `~/Library/Caches/ai.arqanum.droidshuttle/` | Thumbnails, app icons, opened originals | Originals are trimmed to 2 GiB at each launch. Thumbnails and icons are not pruned. |
| `/data/local/tmp/scrcpy-server.jar` on the phone | The mirroring server | Copied on every mirror start and never removed. |
| `/sdcard/Download/.droidshuttle-recording-….mp4` on the phone | An unfinished screen recording | You left Mirror without stopping the recording. |

## Starting over

To reset the app, quit it and delete these folders:

```bash
rm -rf ~/Library/Application\ Support/ai.arqanum.droidshuttle   # photo index, imported list, backup history, app names
rm -rf ~/Library/Caches/ai.arqanum.droidshuttle                  # thumbnails, icons, opened originals
rm -rf ~/Library/WebKit/ai.arqanum.droidshuttle                  # remembered settings: look, panes, options
```

Your phone, your backups and your imported photos are not touched. Saved backup passwords stay in the Keychain (search for "Droid Shuttle Backup" in **Keychain Access**). [Privacy and data](privacy-and-data.md) lists exactly what each folder holds.

## Still stuck

Run the app from a terminal with `npm run tauri dev`. The backend prints its log lines there. Then open an issue with what you did, what you expected, what happened, and the phone model and Android version.
