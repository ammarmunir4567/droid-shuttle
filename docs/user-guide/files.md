# Files

**Browse, drag and drop, and transfer files.** The Files screen is a file manager for the phone's shared storage and for your Mac, with a transfer engine underneath that can pause, verify and survive an unplugged cable.

<p align="center">
  <img src="../media/screenshots/files-two-panes.png" width="860" alt="The Files screen in two-pane mode: phone on the left, Mac on the right, the Places sidebar, and the function bar with Copy to Mac, Move to Mac, New folder, Delete and Swap panes.">
</p>

## Contents

- [Single pane and two panes](#single-pane-and-two-panes)
- [Places and navigation](#places-and-navigation)
- [Views, sorting and filtering](#views-sorting-and-filtering)
- [Selecting](#selecting)
- [Working with files](#working-with-files)
- [Copying and moving between phone and Mac](#copying-and-moving-between-phone-and-mac)
- [Drag and drop](#drag-and-drop)
- [Copy and paste with Finder](#copy-and-paste-with-finder)
- [Transfers](#transfers)
- [Installing apps by dropping them](#installing-apps-by-dropping-them)
- [Limits](#limits)

## Single pane and two panes

Files opens in **single-pane** mode and shows only the phone. Click the columns icon in the toolbar (**Show Mac side by side**) to switch to **two-pane** mode. Click it again (**Back to one pane**) to return.

| | Single pane | Two panes |
|---|---|---|
| Shows | The phone | The phone and the Mac side by side |
| Places sidebar | **Phone** group | **Phone** and **Mac** groups |
| Bottom bar | none | A function bar: **Copy to Mac** (F5), **Move to Mac** (F6), **New folder** (F7), **Delete** (F8), **Swap panes** (⌘U) |
| Toolbar text | | "Two panes · F5 copies, F6 moves to the other side" |

In two-pane mode:

- The phone is on the left by default. **⌘U** (or **Swap panes**) swaps the sides.
- Drag the divider to resize the panes. It stays between 25 % and 75 %. Double-click it to reset to 50 %, or focus it and press ← or → to nudge it by 2 %.
- Each pane has its own header with a title chip (the phone's model, or **Mac**) and its own path bar. The active pane has an accent line on top. **Tab** switches panes.
- The Mac pane starts in your home folder. There is no separate folder picker or typed path field: navigate with folders, breadcrumbs and Places.

Your choice of mode, side, split position, hidden-file setting and the verify setting are remembered between launches. Folders you were in, the sort order, the view mode and the filter text are not.

## Places and navigation

The **Places** sidebar lists shortcuts, and every entry is also a drop target.

**Phone**

- **Internal storage** (`/sdcard`).
- **SD card** entries for removable storage under `/storage`, when present.
- The standard folders that exist on the phone: **DCIM**, **Download**, **Pictures**, **Movies**, **Music**, **Documents**, **Recordings**.

**Mac** (two-pane mode only): **Home**, **Desktop**, **Downloads**, **Documents**, **Pictures** and **Volumes**.

**Path bar.** Each pane shows breadcrumbs. On the phone the first crumb is **Internal storage** (or **Device** for paths outside `/sdcard`). On the Mac it is your home folder's name, or **Macintosh HD** elsewhere. Click any crumb to go there.

| Action | Control | Shortcut |
|---|---|---|
| Back | Back button | ⌘[ |
| Forward | Forward button | ⌘] |
| Enclosing folder | Up button | ⌘↑ |
| Open the selected folder | double-click | ⌘↓ |

Switching to a different phone resets the phone pane to **Internal storage**. Returning to Files, or arriving from **Show in Files** elsewhere in the app, keeps the folder you were in.

## Views, sorting and filtering

- **View modes:** **List view** (columns Name, Size, Modified, Kind; Kind hides when the pane is narrower than 600 px) and **Icon view** (112 px tiles with a file-type icon). There are no image thumbnails here; use [Gallery](gallery.md) for photos.
- **Sorting:** click a column header in list view. Click again to reverse. Folders always come first. Names sort naturally and ignore case, so `file2` comes before `file10`.
- **Filter:** type in **Filter** to show only names containing that text. It matches the current folder only (it is not a recursive search), is per pane, and clears when you navigate.
- **Hidden files:** turn on **Show hidden files** in the toolbar's **⋯** menu. It applies to both panes. Hidden means a name that starts with a dot.
- Sizes are decimal (KB = 1000 bytes). Dates show the day only.

Empty and restricted folders explain themselves: an empty folder says **This folder is empty** and **Drag files here from Finder**; phone folders under `Android/data` or `Android/obb` that list as empty say **Android restricts this folder** (Android 11 and newer blocks app folders from file managers); a failure shows **Can't open this folder** with **Try again**.

## Selecting

| Do this | To get |
|---|---|
| Click | Select one item |
| ⇧-click | Select a range |
| ⌘-click or Ctrl-click | Add or remove one item |
| ⌘A | Select everything visible, folders included |
| ↑ ↓ (and ← → in icon view) | Move the selection. Hold ⇧ to extend it |
| Esc, or click empty space | Clear the selection |
| Right-click | Select the item under the pointer, then open the context menu |

There is no rubber-band selection. The footer shows the item count and, with a selection, `N selected · size` (files only; folders count as zero).

## Working with files

Most actions are in the right-click menu. In two-pane mode the function bar adds F5 to F8.

| Action | Where | Notes |
|---|---|---|
| **Open** | double-click, context menu | A folder opens in the pane. A Mac file opens with `open`. A phone file is first copied to a temporary folder on the Mac (toast **Opening …**) and then opened with the default app. |
| **Quick Look** | **Space**, context menu | Single non-folder item. Phone files are copied to the same temporary folder first. |
| **Rename** | **Enter**, context menu | Inline, with the base name pre-selected. Enter or clicking away commits, Esc cancels. Names cannot contain `/`. |
| **New folder** | **⇧⌘N**, **F7**, toolbar, context menu | Creates `untitled folder` (then `untitled folder 2`, …) and starts renaming. |
| **Duplicate** | **⌘D**, context menu | Creates `name (2).ext` beside the original, entirely on the phone (`cp -r`) or on the Mac (an APFS clone). Nothing crosses the cable. |
| **Copy path** | context menu | The selected paths, one per line. |
| **Reveal in Finder** | context menu, Mac pane only | |
| **Refresh** | context menu | |
| **Delete** | **F8**, **Delete** or **⌫**, context menu | See below. |

> [!NOTE]
> **Enter renames; it does not open.** To open an item, double-click it, press ⌘↓ on a folder, or use **Open** in the context menu.

### Deleting

| Where | What happens |
|---|---|
| **Phone** | **Permanent.** A dialog asks `Delete “name” from your phone?` (or `Delete N items from your phone?`) and says "Android has no Trash for files deleted over USB. This can't be undone." Buttons: **Cancel** (default) and **Delete**. |
| **Mac** | Items are moved to the **Trash** with **no confirmation**, and a toast says so (`Moved “name” to the Trash`). |

On the phone pane the **Delete** or **⌫** key works on its own. On the Mac pane it needs **⌘** (⌘⌫). F8 deletes in the active pane in two-pane mode.

## Copying and moving between phone and Mac

| Goal | How |
|---|---|
| Copy to the other pane | Select, then **F5** (two-pane mode), or **Copy to Mac pane** / **Copy to phone pane** in the context menu. |
| Move to the other pane | **F6**, or **Move to … pane** in the context menu. |
| Save phone items to a Mac folder | **Save to Mac…** in the phone pane's context menu. Works in single-pane mode too. |
| Send Mac files to the phone | **Copy files to phone…** (the + button in the toolbar). It opens a file picker; files only, not folders. Or drag them in. |
| Copy Mac items to the phone | **Copy to phone** in the Mac pane's context menu (goes to the phone pane's current folder). |

F5 and F6 with nothing selected show **Select something in the active pane first**.

> [!WARNING]
> A **move** between the phone and the Mac copies first and then **deletes the original** for every file that copied successfully, with **no confirmation**. Moving from the phone removes the phone's copy permanently; moving from the Mac removes the Mac original directly (it does not go to the Trash). Nothing is deleted if you cancel, and files that failed or were skipped are kept. If you only want a copy, use F5.

## Drag and drop

Droid Shuttle uses its own pointer-based drag and drop, so it does not clash with the macOS drag-and-drop that Finder uses.

### Inside the app

Press on an item and drag; the drag starts after 5 px. If the item you grab is not selected, it becomes the selection, and the whole selection is dragged. Drop targets are folder rows, the pane background (the current folder), breadcrumbs and Places.

| Where you drop | Default | With a modifier |
|---|---|---|
| On the same side (phone to phone, or Mac to Mac) | **Move** | Hold **⌥** to copy |
| On the other side (phone ↔ Mac) | **Copy** | Hold **⌘** to move |

A chip next to the pointer says **Copy to …** or **Move to …** and shows the target. Hovering over a folder for 800 ms opens it. The list scrolls near its top and bottom edges. **Esc** cancels. Dropping an item onto itself, or a move into the folder it is already in, does nothing.

Dragging phone files to the Mac inside the app needs two-pane mode, because that is where the Mac exists. In single-pane mode use **Save to Mac…** or drag out to Finder.

### Out to Finder, Mail, Slack and others

Drag items out of the window and macOS takes over as a real drag.

- **Phone files are "promised".** Nothing is copied while you drag. When you drop, macOS asks Droid Shuttle for the file, and a normal transfer starts and shows in the tray.
- **Mac files** are offered as ordinary file URLs.
- A drag out is always a copy, never a move.
- If it cannot start, you see **Couldn't drag to Finder: … Use “Save to Mac…” instead.**

### In from Finder

Drop files from Finder onto the window.

- Onto a folder row, breadcrumb or Place, they go there.
- Otherwise they go to the current folder of the pane you dropped on. In two-pane mode, dropping on the Mac pane copies them into that Mac folder.
- On **any screen except Apps**, a drop lands in the phone Files pane's current folder (`/sdcard` by default).
- If a name already exists you get the [conflict dialog](#conflicts).

## Copy and paste with Finder

⌘C, ⌘X and ⌘V work between the panes and with Finder.

- **⌘C on Mac files** puts them on the system clipboard, so you can paste in Finder. A toast says `Copied N items`.
- **⌘C on phone files downloads them straight away** to a cache folder on the Mac (a transfer called **Preparing N items for paste** shows while it works), then puts real files on the clipboard. The toast changes from **Copying N items…** to **Copied N items — press ⌘V in Finder or here**. This can be a lot of data if you copy many or large files.
- **⌘X** cuts. Cut items are dimmed. Pasting a cut inside Droid Shuttle moves them; pasting it in Finder copies.
- **⌘V** pastes into the active pane's current folder. If the clipboard still holds a copy made in Droid Shuttle, it pastes from the original location (phone files go straight from the phone). If Finder put files on the clipboard, they are imported as copies. **⌥⌘V** pastes as a move. If there is nothing to paste: **Nothing to paste**.
- **⌘D** duplicates in place (see above).

## Transfers

Every copy, move, drop or paste becomes a **job**. Jobs show in the **transfer tray** at the bottom of the window. The tray appears on every screen, not only Files, and opens by itself when a job starts.

### The tray

- **Header:** `N transfer(s) in progress`, an overall bar with the coral shuttle riding its head, and the combined speed. A chevron collapses it.
- **Each row:** the name (or `N items`), a status line such as **Saving to Mac · 2/5** or **Copying to phone · 1/3**, a progress bar, `done of total`, speed, time left (`42s left`, `3m 10s left`) and the current file.
- **Buttons:** **Pause** / **Resume** and **Cancel**.
- **When done:** **Done · N files** (plus `, N skipped`), **Canceled**, or **Finished with N errors** (hover for the list). A toast `Finished “name” · N files (size)` appears too.
- **Clear finished** removes finished rows from the tray. It never touches files. Rows otherwise stay until you clear them or quit.

### How a transfer runs

- **Three files at a time.** Each job streams up to three files in parallel. Every action starts its own job immediately; there is no global queue, so several jobs run side by side. A single large file uses one stream.
- **Folders** are walked recursively, empty folders are created, and the totals come from a quick pre-scan (**Preparing…**).
- **Pause and cancel** take effect between 64 KiB chunks. A cancel keeps files that already finished, removes the unfinished file, and deletes no sources of a move.
- **Atomic writes.** Data is written to `name.droidshuttle-part` and renamed to the final name only when the file is complete. Phone → Mac always works this way. Mac → phone does it for files of 16 MiB or more; smaller files are written directly.
- **Timestamps.** Files copied to the Mac get the phone's modified time. Files pushed to the phone keep the Mac's.
- **Large files.** Sizes are 64-bit throughout, and the app uses ADB's 64-bit sync calls (`LIS2` and `STA2`) whenever the phone offers them. A phone that does not falls back to the older 32-bit calls, which the project has not tested with files over 4 GB.
- **On-device and on-Mac copies and moves** (for example duplicating, or moving within one side) run through `cp` and `mv`. They have no byte progress and no Pause button, and Cancel takes effect between items.

### Conflicts

If a name already exists in the destination, one dialog covers the whole operation:

> **“name” already exists** (or **N items already exist**)
> in “destination”. What would you like to do?

| Choice | Result |
|---|---|
| **Keep both** (default) | The new file is named `name (2).ext`, `name (3).ext`, … A folder becomes `name (2)`. |
| **Replace** | Overwrites files. "Same-named folders are merged." |
| **Skip** | Leaves the existing item alone. |
| **Cancel** (or Esc) | Aborts the whole operation. |

It checks the top-level names of what you are transferring. Duplicating in place never asks.

**Replace** merges same-named folders for phone ↔ Mac transfers. For copies and moves that stay on one side, folders are **not** merged: a copy deletes the existing destination first (on the Mac, or with `rm -rf` on the phone), and an on-phone move onto an existing folder moves the folder inside it.

### Verification

Turn on **Verify transfers with SHA-256** in the toolbar's **⋯** menu (off by default, remembered). After each file, the app compares the checksum of what it streamed with a `sha256sum` run on the phone. A mismatch fails the file with `checksum mismatch — copy discarded` and removes the copy. Finished rows then show a green **verified** badge.

It applies to phone ↔ Mac transfers only. If the phone has no usable `sha256sum`, the check is skipped silently and the file is not counted as verified.

### If you unplug the cable

Unplugging does not fail a transfer. The job switches to **Waiting for your phone…** (amber bar, with the note "Plug it back in and this continues where it stopped") and the tray header reads `Waiting for your phone · N transfers paused`. A toast explains: "Your phone disconnected. Transfers are paused and will continue when you plug it back in."

When the same phone returns (the app watches for the same device serial), a toast says **Phone is back. Transfers are continuing.** and the files carry on. Finished files are not repeated. An interrupted file continues from where it stopped when:

| Direction | Condition |
|---|---|
| Phone → Mac | The partial file is at least 1 MiB, shorter than the original, and the original's size and modified time have not changed. |
| Mac → phone | The file is at least 16 MiB (it uses a partial file), the partial file on the phone is at least 1 MiB and shorter than the source, and the Mac file's size has not changed. |

Otherwise that file starts again from the beginning. There is no time limit: the job waits until the phone returns or you press **Cancel**. Resuming only works in the same running app session. If you quit the app, nothing resumes, and a later transfer replaces any leftover `.droidshuttle-part` file.

## Installing apps by dropping them

If you drop (or paste) an `.apk`, `.apks`, `.xapk` or `.apkm` file onto the phone side, a dialog asks:

> **Install “name”?**
> You dropped an Android app package. Install it on your phone, or just copy the file.

Choose **Install**, **Copy file only** or **Cancel**. Other files in the same drop are still copied. The install itself is described in [Apps](apps.md#installing-apps).

## Limits

- Phone deletes are permanent, and moves delete the source without a second prompt (see the warnings above).
- **Phone rename has no existence check.** It runs `mv`, so renaming onto an existing name can overwrite that file, or move into an existing folder of that name. (Renaming on the Mac refuses with **An item with that name already exists**.)
- **Copy files to phone…** cannot pick folders. Drag folders in, or paste them.
- Phone files you open or Quick Look are copied whole to `$TMPDIR/droidshuttle-preview`, and the app does not clean that folder up.
- Leftover `.droidshuttle-part` files from a quit or crashed app are not cleaned up at launch.
- The Mac pane's starting folder is always your home folder.
- Verification is skipped for on-device copies, clipboard staging and drag-out.
- On a Mac, F5 to F8 usually need **Fn** unless **Use F1, F2, etc. keys as standard function keys** is on in System Settings. Menu entries and the function bar buttons work without them.
