# Media

Images and video used by the README and the documentation.

## Demo video

| File | Use |
|---|---|
| [`droid-shuttle-demo.mp4`](droid-shuttle-demo.mp4) | The 22-second demo, 1920 × 1080, 30 fps, H.264 with AAC sound |
| [`droid-shuttle-demo.gif`](droid-shuttle-demo.gif) | A silent 720 px animated preview, shown in the README |
| [`droid-shuttle-demo-poster.jpg`](droid-shuttle-demo-poster.jpg) | The poster frame (also the first frame of the MP4, so it is the thumbnail on most platforms) |

What it shows: the shuttle from the app's icon crossing from Android to Mac; the two-pane Files screen moving a file with the transfer tray; the Storage map; and an encrypted Backup.

The video was made with the `/brag` skill and [Hyperframes](https://hyperframes.heygen.com/). The app window in it is a faithful recreation of the interface in HTML, using the app's own design tokens and wording, with the demo data from the built-in mock phone. It is not a screen recording of a real phone, and no real device data appears.

**Credits.** Music: "Happy Beats / Business Moves" (vol. 11) by [ende.app](https://ende.app/en). Sound effects: [Kenney](https://kenney.nl/), CC0.

## Screenshots

`screenshots/` holds 2880 × 1800 captures (a 1440 × 900 window at 2× scale) of the real interface, taken in a browser against the built-in mock phone, so they contain the demo data (a "Pixel 8 Pro" with made-up files) and no personal information. They show the interface as it is on `main`.

| File | Shows |
|---|---|
| `files-single-pane.png` | Files, default single-pane mode |
| `files-two-panes.png` | Files, phone and Mac side by side |
| `command-palette.png` | The ⌘K command palette |
| `apps.png` | The Apps list |
| `storage-start.png`, `storage-map.png`, `storage-large-files.png`, `storage-duplicates.png` | The Storage screen's first-run state, map, large files and duplicate finder |
| `backup.png` | Backup |
| `mirror.png` | The Mirror start screen |
| `tools-device.png`, `tools-log.png`, `tools-wireless.png` | Tools tabs |
| `look-studio-dark.png`, `look-instrument.png`, `look-soft.png`, `appearance-menu.png` | The three looks, dark mode and the Appearance menu |

To retake them: run `npm run dev`, open `http://localhost:1420` in a window of 1440 × 900 pixels, and capture at 2× device scale.
