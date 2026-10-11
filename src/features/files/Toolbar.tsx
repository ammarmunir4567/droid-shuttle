import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowLeftRight, Columns2, Check, FolderPlus, LayoutGrid, List, MoreHorizontal, Plus, Search } from "lucide-react";
import { createFolder, pickAndPush } from "../../lib/ops";
import { useFiles } from "../../store/files";
import { Btn, PathBar } from "./PathBar";

export function Toolbar({ home }: { home: string }) {
  const { panes, active, dual, showHidden, verify, toggle, patch, swapPanes } = useFiles();
  const side = dual ? active : "device";
  const pane = panes[side];

  return (
    <div data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-1 border-b px-3" style={{ borderColor: "var(--border)" }}>
      {dual ? (
        <span className="flex items-center gap-2 text-[12px]" style={{ color: "var(--fg-muted)" }}>
          <Btn label="Swap panes (⌘U)" onClick={swapPanes}><ArrowLeftRight size={15} /></Btn>
          Two panes · F5 copies, F6 moves to the other side
        </span>
      ) : <PathBar side="device" home={home} />}
      <div className="ml-auto flex items-center gap-1">
        <label className="flex h-7 items-center gap-1.5 rounded-md border px-2" style={{ borderColor: "var(--border)" }}>
          <Search size={13} style={{ color: "var(--fg-muted)" }} />
          <input aria-label="Filter files" placeholder="Filter" value={pane.query} onChange={(e) => patch(side, { query: e.target.value })} className="w-28 bg-transparent outline-none" />
        </label>
        <Btn label="List view" on={pane.view === "list"} onClick={() => patch(side, { view: "list" })}><List size={15} /></Btn>
        <Btn label="Icon view" on={pane.view === "grid"} onClick={() => patch(side, { view: "grid" })}><LayoutGrid size={15} /></Btn>
        <Btn label={dual ? "Back to one pane" : "Show Mac side by side"} on={dual} onClick={() => toggle("dual")}><Columns2 size={15} /></Btn>
        <Btn label="New folder (⇧⌘N)" onClick={() => void createFolder(side, pane.path, useFiles.getState().entries[side])}><FolderPlus size={15} /></Btn>
        <Btn label="Copy files to phone…" onClick={() => void pickAndPush(panes.device.path)}><Plus size={16} /></Btn>
        <Dropdown.Root>
          <Dropdown.Trigger asChild><button aria-label="More" className="grid size-7 place-items-center rounded-md hover:bg-[var(--hover)]"><MoreHorizontal size={16} /></button></Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content align="end" className="z-50 min-w-60 rounded-lg border p-1 shadow-xl" style={{ background: "var(--bg-solid)", borderColor: "var(--border)" }}>
              {([["showHidden", "Show hidden files", showHidden], ["verify", "Verify transfers with SHA-256", verify]] as const).map(([k, label, on]) => (
                <Dropdown.CheckboxItem key={k} checked={on} onCheckedChange={() => toggle(k)} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-[var(--color-accent)] data-[highlighted]:text-[var(--accent-ink)]">
                  <span className="grid size-4 place-items-center">{on && <Check size={13} />}</span>{label}
                </Dropdown.CheckboxItem>
              ))}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    </div>
  );
}
