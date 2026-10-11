// Copy / cut / paste for files — works inside the app and with Finder via the system clipboard.
import { api, type FileEntry, type Side } from "./api";
import { currentSerial, duplicateInPlace, importExternal, runOp } from "./ops";
import { plural } from "./paths";
import { useFiles } from "../store/files";
import { useUi } from "../store/ui";

const toast = (kind: "info" | "ok" | "error", text: string, ms = 2200) => useUi.getState().toast({ kind, text }, ms);

export function selectedEntries(side: Side): FileEntry[] {
  const f = useFiles.getState();
  const sel = new Set(f.panes[side].selection);
  return f.entries[side].filter((e) => sel.has(e.path));
}

// One copy at a time. The same selection can arrive twice (the key press and macOS's Copy menu
// event), so a repeat of what's already running — or just finished — is ignored.
let inFlight: string | null = null;
let lastDone = { key: "", at: 0 };

/**
 * Copy phone files to a staging folder on the Mac and publish them as real files on the macOS
 * clipboard, so ⌘V in Finder (or Mail, Slack, …) is an ordinary copy. One toast tells the whole
 * story: it starts as “Copying…” and turns into “Copied” (or an error) in place.
 */
export async function stageToClipboard(items: { path: string; isDir: boolean }[], opts: { cut?: boolean } = {}): Promise<number | null | "duplicate"> {
  const key = `${opts.cut ? "x" : "c"}|${items.map((i) => i.path).sort().join("\0")}`;
  if (inFlight === key || (lastDone.key === key && Date.now() - lastDone.at < 1500)) return "duplicate";
  if (inFlight) return "duplicate"; // a different copy is still staging; let it finish
  inFlight = key;
  const what = plural(items.length, "item");
  const ui = useUi.getState();
  const id = ui.toast({ kind: "info", text: `${opts.cut ? "Cutting" : "Copying"} ${what}…` }, 0);
  try {
    const n = await api.clipboardStage(currentSerial() ?? "", items);
    ui.update(id, { kind: "ok", text: opts.cut ? `Cut ${what} — ⌘V in the destination to move, or paste in Finder to copy` : `Copied ${what} — press ⌘V in Finder or here` }, 3500);
    return n;
  } catch (e) {
    ui.update(id, { kind: "error", text: `Couldn't copy to the clipboard: ${String(e)}` }, 6000);
    return null;
  } finally {
    inFlight = null;
    lastDone = { key, at: Date.now() };
  }
}

/**
 * ⌘C / ⌘X. Remembers the selection in-app and publishes it to the macOS clipboard.
 * Phone files are first copied to a staging folder on the Mac (see `stageToClipboard`).
 */
export async function copySelection(side: Side, cut: boolean) {
  const items = selectedEntries(side);
  if (!items.length) return;
  const paths = items.map((i) => i.path);
  const specs = items.map((i) => ({ path: i.path, isDir: i.isDir }));
  const f = useFiles.getState();
  f.setClipboard({ side, paths, cut, changeCount: null });
  const stillCurrent = () => useFiles.getState().clipboard?.paths === paths;

  if (side === "device") {
    const changeCount = await stageToClipboard(specs, { cut });
    if (typeof changeCount === "number" && stillCurrent()) useFiles.getState().setClipboard({ side, paths, cut, changeCount });
    return;
  }
  const what = plural(items.length, "item");
  try {
    const changeCount = await api.clipboardWrite(null, specs);
    if (stillCurrent()) useFiles.getState().setClipboard({ side, paths, cut, changeCount });
    toast("info", cut ? `Cut ${what} — ⌘V in the destination to move` : `Copied ${what}`);
  } catch (e) {
    toast("error", `Copied in the app, but couldn't put it on the system clipboard: ${String(e)}`, 6000);
  }
}

/** ⌘V (copy) / ⌥⌘V (move). Pastes our own selection, or files copied in Finder. */
export async function pasteInto(side: Side, forceMove = false) {
  const f = useFiles.getState();
  const dest = f.panes[side].path;
  if (!dest) return;
  let info = { changeCount: -2, files: [] as string[] };
  try { info = await api.clipboardRead(); } catch { /* fall back to the in-app clipboard */ }
  const clip = f.clipboard;
  // Our own copy is still what's on the system clipboard → paste it (works for phone items too).
  if (clip && (clip.changeCount === null || clip.changeCount === info.changeCount)) {
    const move = forceMove || clip.cut;
    await runOp({ from: clip.side, to: side, paths: clip.paths, destDir: dest, op: move ? "move" : "copy" });
    if (clip.cut) f.setClipboard(null);
    return;
  }
  // Something else was copied (e.g. in Finder) → bring those files in.
  if (info.files.length) {
    await importExternal(info.files, { side, path: dest });
    return;
  }
  toast("info", "Nothing to paste");
}

/** ⌘D */
export async function duplicateSelection(side: Side) {
  const items = selectedEntries(side);
  if (!items.length) return;
  await duplicateInPlace(side, items.map((i) => i.path));
}

export function selectAll(side: Side) {
  const rows = useFiles.getState().entries[side];
  useFiles.getState().select(side, rows.map((r) => r.path), rows[0]?.path ?? null);
}
