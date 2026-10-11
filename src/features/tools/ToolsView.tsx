import { useState } from "react";
import clsx from "clsx";
import { Activity, ScrollText, SquareTerminal, Wifi } from "lucide-react";
import { useDevices } from "../../store/devices";
import { DevicePanel } from "./DevicePanel";
import { Logcat } from "./Logcat";
import { Terminal } from "./Terminal";
import { Wireless } from "./Wireless";

const TABS = [
  { id: "device", label: "Device", icon: Activity },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "logcat", label: "Log", icon: ScrollText },
  { id: "wireless", label: "Wireless", icon: Wifi },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function ToolsView() {
  const serial = useDevices((s) => s.selected)!;
  const [tab, setTab] = useState<Tab>("device");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Tools" data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-1 border-b px-3" style={{ borderColor: "var(--border)" }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={clsx("flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-[var(--hover)]", tab === id && "bg-[var(--selected)] font-medium")}>
            <Icon size={14} className={tab === id ? "text-[var(--color-accent)]" : ""} />{label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === "device" && <DevicePanel serial={serial} />}
        {tab === "terminal" && <Terminal serial={serial} />}
        {tab === "logcat" && <Logcat serial={serial} />}
        {tab === "wireless" && <Wireless serial={serial} />}
      </div>
    </div>
  );
}
