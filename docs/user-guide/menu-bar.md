# Menu bar and notifications

Droid Shuttle keeps running when you close its window. A **menu-bar item** shows the phone and the progress of transfers, the **Dock icon** shows progress too, and macOS **notifications** tell you when a transfer that finished in the background is done.

## Contents

- [The menu-bar item](#the-menu-bar-item)
- [Dock progress](#dock-progress)
- [Notifications](#notifications)
- [Closing, reopening and quitting](#closing-reopening-and-quitting)
- [Limits](#limits)

## The menu-bar item

A status item appears in the macOS menu bar when the app starts. Click it to open its menu.

- **Icon.** A template image that adapts to light and dark menu bars. It is filled when a ready phone is connected and outlined otherwise.
- **Tooltip.** `Droid Shuttle · <phone name>`, or `Droid Shuttle · no phone connected`.
- **Text next to the icon.** Nothing when idle. `NN%` while transferring (the combined progress of all visible, unfinished transfers), `…` while the total size is not known yet, and `Waiting` when every active transfer is waiting for the phone.

**With a phone connected**, the menu reads:

```text
<phone model>
<battery>% charging · <free> free
<transfer line, only while transferring>
―――
Open Droid Shuttle
―――
Files
Gallery
Storage
Mirror
―――
Take Phone Screenshot
―――
Quit Droid Shuttle
```

The two lines under the model are information only. The battery line leaves out any part that is unknown (for example just `87%`). The transfer line is one of "Waiting for your phone to reconnect…", `1 transfer · 42%` or `3 transfers · 42%`, or the same followed by "· preparing" when the total is unknown.

**Without a phone**, the first lines read "No phone connected" and "Plug it in with a USB cable", and **Files**, **Gallery**, **Storage**, **Mirror** and **Take Phone Screenshot** are disabled. **Open Droid Shuttle** and **Quit Droid Shuttle** always work.

- **Open Droid Shuttle** brings the window back (un-minimizing it if needed).
- **Files**, **Gallery**, **Storage** and **Mirror** show the window and jump to that screen. (Apps, Backup and Tools are not in the menu.)
- **Take Phone Screenshot** saves `~/Pictures/Droid Shuttle Screenshots/Screenshot YYYY-MM-DD HH.MM.SS.png` and sends a notification, **Screenshot saved**, with the body `Pictures ▸ Droid Shuttle Screenshots ▸ <file>`. If notifications are not allowed, it reveals the file in Finder instead. A failure notifies **Couldn't take a screenshot**.

Battery and free space refresh every 60 seconds and whenever a phone is plugged in or unplugged. The phone shown, and the one used for the screenshot, is the **first ready phone** in the list, which is not necessarily the one selected in the app.

## Dock progress

The Dock icon shows a progress bar while transfers run. It uses the same combined percentage as the menu bar, switches to a paused style while every active transfer is waiting for the phone, shows no percentage while the total is unknown, and clears when nothing is active.

## Notifications

A notification is sent when a **visible, non-canceled transfer finishes while the main window is not both visible and focused**: the window is closed, minimized, or another app is in front. At the same time the Dock icon bounces once. Each transfer is announced at most once. Silent jobs such as the clipboard staging behind ⌘C never notify.

| Result | Title | Body |
|---|---|---|
| Phone → Mac succeeded | `Saved to your Mac: <label>` | `N files · size` |
| Mac → phone succeeded | `Copied to your phone: <label>` | `N files · size` |
| Other succeeded | `Finished: <label>` | `N files · size` |
| With errors | **Transfer finished with problems** | `“<label>”: N errors. Open Droid Shuttle for details.` |

The first notification triggers the standard macOS permission prompt. If you decline, notifications are simply not shown (except for the screenshot case above).

## Closing, reopening and quitting

- **Closing the window hides it.** Transfers keep running and the menu-bar item stays.
- **Reopen** by clicking the Dock icon, or choosing **Open Droid Shuttle** from the menu-bar item. The Dock icon is always shown; the app does not hide it.
- **Quit** with **Quit Droid Shuttle** in the menu-bar item (or ⌘Q). Quitting ends any transfer that is still running, with no confirmation.

## Limits

- The menu is rebuilt on every transfer update, about ten times a second while transferring.
- If you refuse notifications, finished background transfers give no alert beyond the Dock bounce.
