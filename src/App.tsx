import { useEffect } from "react";
import { api } from "./lib/api";
import { useDevices } from "./store/devices";
import { useNav } from "./store/nav";
import { SECTIONS, type SectionId } from "./nav";
import { ConnectionGuide } from "./components/ConnectionGuide";
import { Shell } from "./shell/Shell";
import { CommandPalette } from "./components/CommandPalette";
import { FilesView } from "./features/files/FilesView";
import { GalleryView } from "./features/gallery/GalleryView";
import { AppsView } from "./features/apps/AppsView";
import { BackupView } from "./features/backup/BackupView";
import { StorageView } from "./features/storage/StorageView";
import { MirrorView } from "./features/mirror/MirrorView";
import { ToolsView } from "./features/tools/ToolsView";
import { DragLayer } from "./features/files/DragLayer";
import { Dialogs } from "./components/Dialogs";
import { Toaster } from "./components/Toaster";
import { useExternalDrops } from "./lib/drag";
import { refreshDirs } from "./lib/queryClient";
import { formatBytes } from "./lib/api";
import { useUi } from "./store/ui";

export default function App() {
  const { section, setSection } = useNav();
  const { devices, selected, setDevices, setAdbError } = useDevices();

  useEffect(() => {
    api.listDevices().then(setDevices).catch((e) => setAdbError(String(e)));
    const un = [api.onDevicesChanged(setDevices), api.onAdbError(setAdbError)];
    return () => { un.forEach((p) => p.then((f) => f())); };
  }, [setDevices, setAdbError]);

  // “Files / Gallery / Storage / Mirror” in the menu-bar item.
  useEffect(() => {
    const un = api.onTrayNavigate((id) => { if (SECTIONS.some((s) => s.id === id)) setSection(id as SectionId); });
    return () => { void un.then((f) => f()); };
  }, [setSection]);

  useExternalDrops();
  useEffect(() => {
    // Jobs currently waiting for the phone; one toast when the first drops, one when the last is back.
    const waiting = new Set<number>();
    const un = api.onTransferUpdate((snap) => {
      const prev = useUi.getState().transfers[snap.id];
      useUi.getState().setTransfer(snap);
      if (!snap.silent) {
        const was = waiting.size;
        if (snap.status === "waiting" && snap.finishedMs === null) waiting.add(snap.id);
        else waiting.delete(snap.id);
        const { toast } = useUi.getState();
        if (was === 0 && waiting.size > 0) toast({ kind: "info", text: "Your phone disconnected. Transfers are paused and will continue when you plug it back in." }, 7000);
        else if (was > 0 && waiting.size === 0 && snap.status !== "canceled" && snap.finishedMs === null) toast({ kind: "ok", text: "Phone is back. Transfers are continuing." });
      }
      if (snap.silent && snap.finishedMs !== null && prev?.finishedMs !== snap.finishedMs) {
        // Internal job (clipboard staging): the caller reports the outcome; just tidy the bar.
        setTimeout(() => useUi.getState().removeTransfer(snap.id), snap.errors.length ? 6000 : 1500);
        return;
      }
      if (snap.silent) return;
      if (snap.finishedMs !== null && prev?.finishedMs !== snap.finishedMs) {
        void refreshDirs();
        const { toast } = useUi.getState();
        if (snap.status === "canceled") toast({ kind: "info", text: `Canceled “${snap.label}”` });
        else if (snap.errors.length) toast({ kind: "error", text: `“${snap.label}”: ${snap.errors[0]}` }, 8000);
        else toast({ kind: "ok", text: `Finished “${snap.label}” · ${snap.filesDone} file${snap.filesDone === 1 ? "" : "s"}${snap.bytesTotal ? ` (${formatBytes(snap.bytesTotal)})` : ""}` });
      }
    });
    return () => { void un.then((f) => f()); };
  }, []);

  const dev = devices.find((d) => d.serial === selected);
  const ready = dev?.state === "ready";

  // Soft tints the whole screen with the current section's colour.
  useEffect(() => { document.documentElement.dataset.section = section; }, [section]);

  return (
    <>
      <Shell section={section} setSection={setSection} ready={ready}>
        {!ready ? (
          <ConnectionGuide />
        ) : section === "files" ? (
          <FilesView />
        ) : section === "gallery" ? (
          <GalleryView />
        ) : section === "apps" ? (
          <AppsView />
        ) : section === "storage" ? (
          <StorageView />
        ) : section === "backup" ? (
          <BackupView />
        ) : section === "mirror" ? (
          <MirrorView />
        ) : (
          <ToolsView />
        )}
      </Shell>
      <CommandPalette onNavigate={setSection} />
      <DragLayer />
      <Dialogs />
      <Toaster />
    </>
  );
}
