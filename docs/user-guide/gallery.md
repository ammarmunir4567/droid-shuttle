# Gallery

**Photos and videos, grouped by date.** The Gallery shows the phone's photo and video library, lets you open items full size, and imports new ones to the Mac in one step. It remembers what you have already imported.

## Contents

- [What it shows](#what-it-shows)
- [Browsing](#browsing)
- [Thumbnails](#thumbnails)
- [The viewer](#the-viewer)
- [Selecting](#selecting)
- [Importing](#importing)
- [Other ways to get items onto the Mac](#other-ways-to-get-items-onto-the-mac)
- [Limits](#limits)

## What it shows

The Gallery reads Android's **MediaStore** over ADB (`content query` on the image and video tables). That means:

- Only **photos and videos** appear: no audio, no documents.
- **Every album** MediaStore knows about is included (Camera, Screenshots, WhatsApp, Download, and so on). Nothing is filtered by folder.
- Files that MediaStore does not list, for example folders hidden with a `.nomedia` file, do not appear.
- The date of an item is its **date taken** if MediaStore has one, otherwise the modified date, otherwise the date added. It is not read from the photo's EXIF data.

The list is cached in a local database so it opens instantly, then refreshed in the background every time you open the Gallery or switch phones. While it refreshes the header shows **Syncing with phone…**, and the refresh button is labelled **Refresh from phone**.

## Browsing

- **Library** (left): **All**, **Photos** (images that are not screenshots), **Videos** and **Screenshots**, each with a count. A screenshot is an item whose album name contains "screenshot", or whose path contains `/Screenshot/` or `/Screenshots/`.
- **Albums** (left): **All albums** plus one entry per album, with counts, largest first. An album with no name shows as **Other**. Library and album filters combine.
- **Group by:** **Day** (default) or **Month**. Headings use your Mac's language and time zone, for example "Monday, 12 October 2026" or "October 2026". Items without a date go under **Unknown date**.
- **Thumbnail size:** a slider from 90 to 260 px (default 150). Tiles stretch so each row is filled.
- **New only:** the pill in the header hides items you have already imported. When there is nothing left, the screen says **Everything here is already imported**.

Your grouping, thumbnail size, **New only** setting and import options are remembered. The library and album you picked reset on the next launch.

## Thumbnails

Thumbnails are generated on the Mac and cached in `~/Library/Caches/ai.arqanum.droidshuttle/thumbs/`. A tile waits 120 ms before requesting its thumbnail, so scrolling quickly does not hit the phone.

**Photos** use up to two steps:

1. **A fast preview.** For JPEG-like photos over 1.2 MB, the app reads the first 256 KiB of the file, extracts the embedded EXIF preview and rotates it correctly. It is shown slightly blurred until the sharp thumbnail arrives.
2. **The full thumbnail.** The whole photo is pulled over USB (up to six at a time) and scaled down on the Mac to 360 px. JPG, PNG, WebP and GIF are decoded by the app. HEIC, HEIF, DNG, TIFF, BMP, AVIF and common RAW formats (ARW, CR2, NEF and others) are decoded by macOS's built-in `sips`. If a photo is over 60 MB or cannot be decoded, the app asks the phone for its own thumbnail instead. If that fails too, the tile shows an "image off" icon.

**Videos** are slower. The app never decodes video itself; it asks the phone to extract a frame, which takes roughly 1.4 seconds each, and it runs two at a time. A tile whose frame cannot be extracted shows a play icon. Videos show their duration, for example `1:23`.

## The viewer

Double-click a tile, or select one and press **Space** or **Enter**, to open it full screen.

| Do this | To get |
|---|---|
| ← / → , or the arrow buttons | Previous or next item in the current view. A counter shows `N of M`. |
| Scroll wheel (images) | Zoom from 1× to 8× |
| Drag (when zoomed) | Pan |
| Double-click (images) | Toggle between 1× and 2.5× |
| `0` | Reset zoom |
| `i` | Show or hide the **Details** panel |
| ⌘C | Copy the file, then paste it in Finder |
| Esc | Close |

The top bar has **Import this item**, **Copy to clipboard**, **Show in Files** (jumps to the Files screen at that folder with the file selected) and **Info**.

The **Details** panel lists Name, Date, Size, Dimensions (with megapixels above 1 MP), Album, Type and Path. For photos it adds Camera, Lens, Exposure (shutter · aperture · ISO · focal length) and Software when the file has them, and a **Show location in Maps** button when it has GPS data. Photos from messaging apps usually have no camera data: **No camera metadata (messaging apps strip it).**

**Videos** are copied to the Mac cache first (the overlay reads **Copying video from phone… NN%**) and then play in the viewer with the standard controls. The app does not transcode, so a video that macOS's web view cannot play will not play.

**HEIC, HEIF, DNG, TIFF, AVIF and similar** are converted to a full-resolution JPEG for display only. The original on the phone is never changed. Opened originals are cached in `~/Library/Caches/ai.arqanum.droidshuttle/originals/` and trimmed to 2 GiB, oldest first, at each launch. The viewer prefetches the next and previous photo when each is under 25 MB.

## Selecting

| Do this | To get |
|---|---|
| Click | Select one tile |
| ⌘-click or Ctrl-click | Add or remove a tile |
| ⇧-click | Select a range in on-screen order |
| The round checkbox on a tile or a group heading | Select one tile, or a whole day or month |
| Arrow keys (⇧ to extend) | Move the selection |
| ⌘A | Select everything in the current view |
| ⌘C | Copy |
| Esc | Clear the selection |

While something is selected, the header shows `N selected`, the total size, a **Copy** button and a clear button. Selection is a list of paths across the whole library, and it clears when you change the Library filter or album.

## Importing

The **Import** button in the header copies photos and videos to the Mac. Its label depends on what is selected:

| Label | Meaning |
|---|---|
| **Import N** | N items are selected. The selection may include items you already imported. |
| **Import N new** | Nothing is selected. N is the number of not-yet-imported items in the current view (it respects the Library filter, the album and **New only**). |
| **Import** | Nothing to count. The button is disabled when there is nothing to import. |

The **Import N items** dialog shows the total size and, if some items were imported before, how many ("they'll be copied again").

- **Save to** defaults to `~/Pictures/Droid Shuttle`. **Choose…** opens a folder picker, and your choice is remembered.
- **Organize** decides the folder layout:
  - **By month** (default): `2026/10/IMG_0001.jpg`
  - **By album:** `Camera/IMG_0001.jpg`. Album names are cleaned (`/`, `:` and control characters become `_`, leading dots are removed, and an empty name becomes `Other`).
  - **One folder:** `IMG_0001.jpg`
- **Delete from phone after importing** (off, and never remembered). When ticked, each file is checked against its copy with SHA-256 first, and only verified files are removed. A red warning says "Android has no Trash over USB — removed photos can't be recovered from the phone." The **Import** button becomes the red **Import and delete**, and there is no further confirmation.

Click **Import**. The dialog closes and a toast says `Importing N items to <folder>…`. The transfers tray shows progress. When the job ends, a toast **Import finished** offers **Show in Finder**.

Originals are copied byte for byte: HEIC stays HEIC and RAW stays RAW. Copies get the phone's modified time. Importing something again uses the **Keep both** rule, so it becomes `name (2).jpg` and nothing is overwritten.

### How "already imported" works

When an import copies a file successfully, the app records the phone, the file's path and its size in a local ledger (`droidshuttle.db`). An item counts as imported when the ledger has the same phone, the same path and the same size.

- It is **not** content-based, and it does **not** check that the copy still exists on the Mac. If you delete the copy, the item still shows as imported.
- A file whose size changes counts as new again, and a renamed or moved file counts as new.
- Only Gallery imports are recorded. Copies made in Files, drag and drop, and the clipboard are not.
- The ledger is kept per phone, as identified by its ADB serial. A phone connected over Wi-Fi has a different serial from the same phone on USB, so the two may not share a ledger.

Imported items show a small green check in the corner of their tile.

## Other ways to get items onto the Mac

- **Copy (⌘C), then paste in Finder.** The files are staged in a cache first.
- **Drag out of the window.** Phone items are promised to macOS and copied when you drop.
- **Files screen.** Browse to `DCIM` and copy as usual.

## Limits

- **"By month" uses UTC.** Folders are named from the item's date in UTC, while the grid headings use your local time zone, so a photo taken near midnight at a month boundary can land in the neighbouring month's folder.
- **The index changes only when it refreshes.** Files you delete from the Storage screen stay in the Gallery list until the next refresh.
- **Photo thumbnails need the whole photo** over USB (up to 60 MB each), except when the fast preview path applies.
- **Delete-after-import relies on `sha256sum` on the phone.** If a phone cannot produce a checksum, the copy is treated as unverified-but-successful and the original may still be removed. Do not use the option on phones where you are unsure.
- **Same-named files in one import.** When a batch contains two photos with the same file name that end up in the same Mac folder (for example from different albums with **One folder**, or the same month with **By month**), the importer does not give the second a new name, so one can overwrite the other. Camera file names are normally unique. If you import from several albums at once, prefer **By album**.
- **No video transcoding,** and no message for a video the viewer cannot play.
