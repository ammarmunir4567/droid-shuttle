# Backup

**Encrypted, incremental backups.** Backup copies the folders you choose, and your apps' installers, to a folder on the Mac. After the first run, only new and changed files are copied. Optionally the backup lives inside an AES-256 encrypted disk image.

<p align="center">
  <img src="../media/screenshots/backup.png" width="860" alt="The Backup screen: a Back up now button, the destination folder, an Encrypt this backup option, the list of folders to back up with sizes, and the history of earlier backups.">
</p>

## Contents

- [What is backed up](#what-is-backed-up)
- [Running a backup](#running-a-backup)
- [What a backup looks like on disk](#what-a-backup-looks-like-on-disk)
- [How incremental backups work](#how-incremental-backups-work)
- [Encryption](#encryption)
- [History](#history)
- [Restoring](#restoring)
- [Limits](#limits)

## What is backed up

Under **What to back up** the app lists the phone's top-level folders under `/sdcard`. Next to the label you will see **Recommended**, **All** and **None** buttons, and each folder shows its size (measured in the background, so you first see "measuring…").

**Folders**

- Excluded from the list: `Android`, anything that starts with a dot, folders starting with "Alarms", and "Notifications" and "Ringtones". Loose files in the root of `/sdcard` are not offered, so they are not backed up.
- **Recommended** (ticked by default): `DCIM`, `Pictures`, `Movies`, `Music`, `Documents`, `Download`, `Recordings` and `Audiobooks`. Other folders are listed but not ticked. Recommended ones come first, then the rest alphabetically.
- **App media folders.** Each folder under `/sdcard/Android/media` is offered. `com.whatsapp` and `com.whatsapp.w4b` appear as **WhatsApp media** and are recommended. Other apps appear as `App media: <package>` and are not recommended. `Android/data` and `Android/obb` are never offered.

**Installed apps** (on by default). The row reads `N apps · installers only, not their data`. It saves the APK files, including split APKs, of your **user** apps (not system apps). App data and settings are **never** backed up. Apps whose details cannot be read are skipped without an error.

Until you change something the selection is "Recommended". After that, your choice is remembered, **globally, not per phone**. If a remembered folder does not exist on another phone, that run reports `folder no longer exists on the phone` and carries on.

## Running a backup

1. **Back up to.** The default is `~/Droid Shuttle Backups`. Click **Choose…** to pick another folder (the picker is titled **Back up to…**). Inside it the app creates a folder per phone, named `<Manufacturer Model> (<last 4 characters of the serial>)`, for example `Samsung SM-A075F (43NB)`.
2. **Encrypt this backup** (optional): see [Encryption](#encryption).
3. **What to back up:** tick folders and **Installed apps**.
4. **Verify every file after copying** (off by default): "Compares SHA-256 checksums. Slower, but proves the copy is exact." It covers the folder files, not the app installers.
5. Click **Back up now**. It is disabled when nothing is selected, when a required password is missing or invalid, or when there is no destination.

The screen notes: "Files you delete from your phone later stay in the backup — it never removes anything."

**Progress.** The transfers tray shows per-file progress (three files at a time). The Backup screen shows a spinner and a stage line: **Starting…**, **Unlocking the encrypted backup…**, **Copying new and changed files…**, **Saving your apps' installers…**, **Writing the backup manifest…**, **Locking the encrypted backup…**.

**Cancel.** While running, **Back up now** turns into a red **Cancel**. A canceled run still counts as a run and is recorded in the history. The toast says "Backup canceled. What was copied is kept." and no half-written files are left behind.

**When it finishes**, a toast says `Backup complete — N files (size) copied` or "Backup complete — everything was already up to date", with **Show in Finder** (for an encrypted backup it reveals the `.sparsebundle`). If something went wrong: `Backup finished with N problems: <first error>`.

The header line tells you the last result: `Last backup <time ago> · size copied · N files · took …`, or "Never backed up. The first backup copies everything you select; after that only what changed." (`N files` counts copied plus skipped files.)

Only **one backup can run at a time** in the whole app. A second start says "A backup is already running."

## What a backup looks like on disk

```text
<destination>/<Device (xxxx)>/
  files/<path relative to /sdcard>/…     e.g. files/DCIM/Camera/…
  apps/<package>-<versionName>/*.apk     every split of the app
  apps.json                              the apps in this run: package, label, version, files
  backup.json                            informational: device, serial, time, folders
```

The files are ordinary files. You can open them in Finder, copy them, or restore them without Droid Shuttle. `backup.json` is written but never read by the app. `apps.json` is rewritten every run and lists only the apps backed up in that run. Older `apps/<package>-<oldVersion>/` folders stay on disk but are not offered by Restore.

If a run is canceled during the files step, the apps step and `backup.json` are skipped.

## How incremental backups work

Files are copied with the **Update** rule: a file is skipped as unchanged when the backup copy has the **same size** and a **modified time within 2 seconds** of the phone's file. Copied files get the phone's modified time, which is what makes the comparison work. New files are copied, and a changed file **overwrites** its copy in the backup (there is no version history).

No content hash is used, except that **Verify** checks each copy it makes. **Nothing is ever deleted from the backup.** A file you delete or move on the phone stays in the backup.

## Encryption

Tick **Encrypt this backup** to keep the backup in a macOS **sparse bundle disk image** (APFS, **AES-256**), created with `hdiutil`. The image is `<destination>/<Device (xxxx)>.sparsebundle`; "2 TB" is only its maximum size, and it grows as needed. Inside, the files are laid out as above. The app says: "Stored in an AES-256 encrypted disk image."

- **Password.** At least 6 characters, entered twice the first time ("Use at least 6 characters", "Passwords don't match"). It is saved in your macOS **Keychain** as a generic password, service `Droid Shuttle Backup`, account = the full path of the `.sparsebundle`.
- **Lost password.** "Choose a password below — it's saved in your Keychain and can't be recovered if you lose it." There is no recovery.
- **Moving the image.** The Keychain entry is tied to the image's path. If you move or rename the `.sparsebundle`, the saved password no longer matches.
- **During a backup** the image is mounted privately (not shown in Finder), then locked again: "Unlocking…" and "Locking the encrypted backup…".
- Under **Encrypt this backup** the app tells you where it stands: "Its password is saved in your Keychain.", "Its password isn't in your Keychain — you'll be asked for it.", or "Choose a password below…".
- Encrypted and plain backups are separate. Turning encryption on creates a new `.sparsebundle` beside any plain backup folder; nothing is migrated.

## History

The **History** list shows the last 50 backups for the phone, newest first. Each row has the date and time, `size copied · N files new/changed · N apps · folder name` (plus `· N problems` and a warning icon when there were errors), and the buttons **Show in Finder** and **Restore…**. With none: **No backups yet.**

## Restoring

There are three ways in:

1. **Restore…** on a history row.
2. **Restore from a folder…**: choose a backup folder (the one that contains `files/` and `apps.json`). The picker is titled **Open backup folder**.
3. **Restore from an encrypted backup…**: choose a `.sparsebundle` (picker titled **Open encrypted backup**).

For an encrypted image the app first tries the Keychain. If there is no saved password, a **Password** field appears with **Unlock**. A wrong one says "Couldn't unlock the encrypted backup: …".

The **Restore from backup** dialog opens with the contents:

- **Files.** The top-level folders of the backup's `files/`, each with `N files · size`; everything under `Android/media/<package>` is one entry. All are ticked. **All** and **None** buttons are provided.
- **Apps.** Shown only when `apps.json` lists apps: name or package, `versionName · size`. None are ticked. A note says "Apps come back without their data and settings."
- "Files go back to their original places on your phone. Nothing on the phone is deleted."
- **If a file already exists:** **Skip identical files** (default; "Recommended — copies only what's missing or different", using the same size-and-time check) or **Keep both** ("Never overwrite a file on the phone"). There is no Replace option.

Click **Restore**. Files are copied with the transfer engine (watch the tray) and go to `/sdcard`, in their original relative locations. The destination is fixed and cannot be changed. Apps are reinstalled from their saved APKs, one after another (a single APK with `adb install -r`, several with `install-multiple -r`), with one toast per app. App data is not restored. Restoring does not verify checksums.

## Limits

- **An existing encrypted image whose password is not in the Keychain cannot be used from the Backup screen.** The screen does not ask for the password; the run fails with "The backup password isn't in your Keychain. Enter it to continue." The password fields appear only when the image does not exist yet. Restoring does ask for the password.
- The password is passed to the macOS `security` tool as a command-line argument when it is saved, so it is briefly visible to other processes on your Mac. `hdiutil` receives it on standard input.
- **Verify** does not cover app installers.
- A changed file overwrites the backup's copy: there are no versions.
- Loose files in the root of `/sdcard`, system data and other apps' data are not backed up.
- The folder selection is shared by all phones.
- The restore destination is always `/sdcard`. Restoring into `Android/media/<package>` depends on what Android allows over ADB, and is not guaranteed on every Android version.
- The app does not check free space on the Mac before backing up.
