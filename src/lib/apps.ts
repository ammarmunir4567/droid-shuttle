import { api } from "./api";
import { baseName, extOf } from "./paths";
import { refreshApps } from "./queryClient";
import { currentSerial } from "./ops";
import { useUi } from "../store/ui";

export const INSTALLABLE = ["apk", "apks", "xapk", "apkm"];
export const isInstallable = (p: string) => INSTALLABLE.includes(extOf(p));

/** Install app files on the phone one by one, reporting each result in plain English. */
export async function installFiles(paths: string[]) {
  const serial = currentSerial();
  const ui = useUi.getState();
  if (!serial) return ui.toast({ kind: "error", text: "No device connected" });
  const busy = ui.toast({ kind: "info", text: paths.length === 1 ? `Installing ${baseName(paths[0])}…` : `Installing ${paths.length} apps…` }, 0);
  try {
    const results = await api.appsInstall(serial, paths);
    for (const r of results) {
      if (r.ok) ui.toast({ kind: "ok", text: `Installed ${r.file}` }, 4000);
      else ui.toast({ kind: "error", text: `${r.file}: ${r.message}` }, 9000);
    }
  } catch (e) {
    ui.toast({ kind: "error", text: `Install failed: ${String(e)}` }, 8000);
  } finally {
    ui.dismiss(busy);
    void refreshApps();
  }
}
