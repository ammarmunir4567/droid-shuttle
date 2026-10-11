import { api, formatBytes } from "../../lib/api";
import { baseName, parentPath } from "../../lib/paths";
import { refreshDirs } from "../../lib/queryClient";
import { useFiles } from "../../store/files";
import { useNav } from "../../store/nav";
import { useStorage } from "../../store/storage";
import { confirmDialog, useUi } from "../../store/ui";

/**
 * Delete from the phone after an explicit confirmation that states the size.
 * Android has no Trash over USB, so this is the one place that has to be unmistakable.
 */
export async function deleteFromPhone(serial: string, items: { path: string; size: number }[]): Promise<boolean> {
  if (!items.length) return false;
  const total = items.reduce((n, i) => n + i.size, 0);
  const what = items.length === 1 ? `“${baseName(items[0].path)}”` : `${items.length} items`;
  const ok = await confirmDialog({
    title: `Delete ${what} (${formatBytes(total)}) from your phone?`,
    body: "Android has no Trash for files deleted over USB. This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return false;
  const paths = items.map((i) => i.path);
  try {
    await api.deviceDelete(serial, paths);
  } catch (e) {
    useUi.getState().toast({ kind: "error", text: `Couldn't delete: ${String(e)}` }, 7000);
    return false;
  }
  await useStorage.getState().forget(serial, paths);
  useStorage.getState().dropGroupFiles(paths);
  void refreshDirs();
  useUi.getState().toast({ kind: "ok", text: `Deleted ${what} · freed ${formatBytes(total)}` });
  return true;
}

/** Jump to the Files screen at this folder (or the file's folder, with the file selected). */
export function showInFiles(path: string, isDir: boolean) {
  const dir = isDir ? path : parentPath(path);
  useNav.getState().setSection("files");
  const f = useFiles.getState();
  f.navigate("device", dir);
  f.select("device", isDir ? [] : [path], isDir ? null : path);
}
