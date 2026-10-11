import { open as pickDir } from "@tauri-apps/plugin-dialog";
import { api, inTauri, type Conflict, type Direction, type FileEntry, type Side } from "./api";
import { baseName, isInside, joinPath, parentPath } from "./paths";
import { refreshDirs } from "./queryClient";
import { useDevices } from "../store/devices";
import { useFiles } from "../store/files";
import { apkDialog, confirmDialog, conflictDialog, useUi } from "../store/ui";
import { installFiles, isInstallable } from "./apps";

const toast = (kind: "info" | "ok" | "error", text: string) => useUi.getState().toast({ kind, text });
export const currentSerial = () => useDevices.getState().selected;

function directionFor(from: Side, to: Side, op: "copy" | "move"): Direction {
  if (from === "local" && to === "device") return "push";
  if (from === "device" && to === "local") return "pull";
  if (from === "device") return op === "move" ? "deviceMove" : "deviceCopy";
  return op === "move" ? "localMove" : "localCopy";
}

/** The single entry point every copy/move/drop/paste goes through. */
export async function runOp(o: { from: Side; to: Side; paths: string[]; destDir: string; op: "copy" | "move" }) {
  const serial = currentSerial();
  if (!serial && (o.from === "device" || o.to === "device")) return toast("error", "No device connected");
  const direction = directionFor(o.from, o.to, o.op);
  const sameSide = o.from === o.to;

  const into = o.paths.find((p) => isInside(o.destDir, p));
  if (into) return toast("error", `Can't ${o.op} “${baseName(into)}” into itself`);
  if (sameSide && o.op === "move" && o.paths.every((p) => parentPath(p) === o.destDir)) return; // dropped where it already is

  const duplicateInPlace = sameSide && o.op === "copy" && o.paths.every((p) => parentPath(p) === o.destDir);
  let conflict: Conflict = "keepBoth";
  if (!duplicateInPlace) {
    const names = await api.checkConflicts(serial ?? "", direction, o.paths, o.destDir);
    if (names.length) {
      const picked = await conflictDialog({ names, destLabel: baseName(o.destDir) || o.destDir });
      if (!picked) return;
      conflict = picked;
    }
  }
  await api.startTransfer({
    serial: serial ?? "",
    direction,
    sources: o.paths,
    destDir: o.destDir,
    conflict,
    verify: useFiles.getState().verify,
    deleteSource: !sameSide && o.op === "move",
  });
}

/** ⌘D: copy next to the original with a “ (2)” suffix. */
export async function duplicateInPlace(side: Side, paths: string[]) {
  await runOp({ from: side, to: side, paths, destDir: parentPath(paths[0]), op: "copy" });
}

/** Files dragged in from Finder (or picked) → a pane folder, with APK install offer. */
export async function importExternal(paths: string[], target: { side: Side; path: string }) {
  if (!paths.length) return;
  if (target.side === "local") return runOp({ from: "local", to: "local", paths, destDir: target.path, op: "copy" });
  const apks = paths.filter(isInstallable);
  let rest = paths;
  if (apks.length) {
    const choice = await apkDialog(apks);
    if (!choice) return;
    if (choice === "install") {
      rest = paths.filter((p) => !apks.includes(p));
      void installFiles(apks);
    }
  }
  if (rest.length) await runOp({ from: "local", to: "device", paths: rest, destDir: target.path, op: "copy" });
}

export async function createFolder(side: Side, dir: string, existing: FileEntry[]) {
  const names = new Set(existing.map((e) => e.name));
  let name = "untitled folder";
  for (let n = 2; names.has(name); n++) name = `untitled folder ${n}`;
  const path = joinPath(dir, name);
  try {
    if (side === "device") await api.deviceMkdir(currentSerial() ?? "", path);
    else await api.localMkdir(path);
    await refreshDirs();
    useFiles.getState().patch(side, { selection: [path], anchor: path, renaming: path });
  } catch (e) {
    toast("error", `Couldn't create folder: ${String(e)}`);
  }
}

export async function renameEntry(side: Side, entry: FileEntry, newName: string) {
  useFiles.getState().patch(side, { renaming: null });
  const name = newName.trim();
  if (!name || name === entry.name) return;
  if (name.includes("/")) return toast("error", "Names can't contain “/”");
  const to = joinPath(parentPath(entry.path), name);
  try {
    if (side === "device") await api.deviceRename(currentSerial() ?? "", entry.path, to);
    else await api.localRename(entry.path, to);
    useFiles.getState().patch(side, { selection: [to], anchor: to });
    await refreshDirs();
  } catch (e) {
    toast("error", `Couldn't rename: ${String(e)}`);
  }
}

export async function deleteEntries(side: Side, entries: FileEntry[]) {
  if (!entries.length) return;
  const what = entries.length === 1 ? `“${entries[0].name}”` : `${entries.length} items`;
  try {
    if (side === "device") {
      const ok = await confirmDialog({
        title: `Delete ${what} from your phone?`,
        body: "Android has no Trash for files deleted over USB. This can't be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      await api.deviceDelete(currentSerial() ?? "", entries.map((e) => e.path));
    } else {
      await api.localTrash(entries.map((e) => e.path));
    }
    useFiles.getState().select(side, [], null);
    toast("ok", side === "local" ? `Moved ${what} to the Trash` : `Deleted ${what}`);
    await refreshDirs();
  } catch (e) {
    toast("error", `Delete failed: ${String(e)}`);
  }
}

export async function openEntry(side: Side, e: FileEntry) {
  if (e.isDir) return useFiles.getState().navigate(side, e.path);
  try {
    if (side === "device") {
      toast("info", `Opening ${e.name}…`);
      await api.previewDevice(currentSerial() ?? "", e.path, true);
    } else await api.openLocal(e.path);
  } catch (err) {
    toast("error", `Couldn't open: ${String(err)}`);
  }
}

export async function quickLook(side: Side, e: FileEntry) {
  if (e.isDir) return;
  try {
    if (side === "device") await api.previewDevice(currentSerial() ?? "", e.path, false);
    else await api.previewLocal(e.path);
  } catch (err) {
    toast("error", `Preview failed: ${String(err)}`);
  }
}

/** "Save to Mac…" / "Copy to phone…" via a native folder picker. */
export async function transferViaPicker(from: Side, paths: string[]) {
  if (!inTauri) return;
  if (from === "device") {
    const dest = await pickDir({ directory: true, title: "Save to…" });
    if (typeof dest === "string") await runOp({ from, to: "local", paths, destDir: dest, op: "copy" });
  }
}

/** Upload via Finder-style file picker (toolbar "Add files"). */
export async function pickAndPush(destDir: string) {
  if (!inTauri) return;
  const picked = await pickDir({ multiple: true, directory: false, title: "Copy to phone" });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  await importExternal(paths, { side: "device", path: destDir });
}
