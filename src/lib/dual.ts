// Two-pane actions: everything here works on the active pane and sends to the other one.
import type { Side } from "./api";
import { selectedEntries } from "./clipboard";
import { createFolder, deleteEntries, runOp } from "./ops";
import { useFiles } from "../store/files";
import { useUi } from "../store/ui";

export const otherSide = (s: Side): Side => (s === "device" ? "local" : "device");

/** F5 / F6: copy or move the active pane's selection into the folder the other pane is showing. */
export async function transferToOtherPane(op: "copy" | "move") {
  const f = useFiles.getState();
  if (!f.dual) return;
  const from = f.active;
  const to = otherSide(from);
  const items = selectedEntries(from);
  if (!items.length) return void useUi.getState().toast({ kind: "info", text: "Select something in the active pane first" }, 2500);
  const destDir = f.panes[to].path;
  if (!destDir) return;
  await runOp({ from, to, paths: items.map((i) => i.path), destDir, op });
}

/** F7 */
export async function newFolderInActivePane() {
  const f = useFiles.getState();
  await createFolder(f.active, f.panes[f.active].path, f.entries[f.active]);
}

/** F8 */
export async function deleteInActivePane() {
  const f = useFiles.getState();
  await deleteEntries(f.active, selectedEntries(f.active));
}

/** Tab: make the other pane active and give it keyboard focus. */
export function focusOtherPane() {
  const f = useFiles.getState();
  const next = otherSide(f.active);
  f.setActive(next);
  document.querySelector<HTMLElement>(`section[data-pane="${next}"]`)?.focus();
}
