import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Download, FolderOpen, HardDrive, Home, Image, Monitor, Music, Smartphone, Video, FileText, Mic, Folder, MemoryStick, type LucideIcon } from "lucide-react";
import { api } from "../../lib/api";
import { targetKey, useDrag } from "../../lib/drag";
import { joinPath } from "../../lib/paths";
import { useDevices } from "../../store/devices";
import { useFiles } from "../../store/files";

const ICONS: Record<string, LucideIcon> = { DCIM: Image, Pictures: Image, Download: Download, Movies: Video, Music, Documents: FileText, Recordings: Mic };

function Place({ side, path, label, icon: Icon }: { side: "device" | "local"; path: string; label: string; icon: LucideIcon }) {
  const cur = useFiles((s) => s.panes[side].path);
  const navigate = useFiles((s) => s.navigate);
  const hot = useDrag((s) => (s.target ? targetKey(s.target.side, s.target.path) : s.externalTarget ? targetKey(s.externalTarget.side, s.externalTarget.path) : "")) === targetKey(side, path);
  return (
    <button
      data-drop-side={side} data-drop-path={path} data-drop-kind="place" data-drop-label={label}
      onClick={() => navigate(side, path)}
      className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--hover)]", cur === path && "bg-[var(--selected)] font-medium", hot && "ring-2 ring-[var(--color-accent)]")}
    >
      <Icon size={15} strokeWidth={1.7} className="shrink-0 text-[var(--color-accent)]" /> <span className="truncate">{label}</span>
    </button>
  );
}

const H = ({ children }: { children: string }) => <div className="px-2 pb-1 pt-3 text-[12px] font-medium " style={{ color: "var(--fg-muted)" }}>{children}</div>;

export function Places({ home }: { home: string }) {
  const serial = useDevices((s) => s.selected);
  const dual = useFiles((s) => s.dual);
  const { data: places } = useQuery({ queryKey: ["places", serial], queryFn: () => api.devicePlaces(serial!), enabled: !!serial });
  const { data: volumes } = useQuery({ queryKey: ["volumes", serial], queryFn: () => api.deviceVolumes(serial!), enabled: !!serial });
  return (
    <aside aria-label="Places" className="w-48 shrink-0 overflow-auto border-r px-2 pb-3" style={{ borderColor: "var(--border)" }}>
      <H>Phone</H>
      <Place side="device" path="/sdcard" label="Internal storage" icon={Smartphone} />
      {volumes?.map((v) => <Place key={v.path} side="device" path={v.path} label={`SD card ${v.name}`} icon={MemoryStick} />)}
      {places?.map((p) => <Place key={p.path} side="device" path={p.path} label={p.name} icon={ICONS[p.name] ?? Folder} />)}
      {dual && home && (
        <>
          <H>Mac</H>
          <Place side="local" path={home} label="Home" icon={Home} />
          <Place side="local" path={joinPath(home, "Desktop")} label="Desktop" icon={Monitor} />
          <Place side="local" path={joinPath(home, "Downloads")} label="Downloads" icon={Download} />
          <Place side="local" path={joinPath(home, "Documents")} label="Documents" icon={FolderOpen} />
          <Place side="local" path={joinPath(home, "Pictures")} label="Pictures" icon={Image} />
          <Place side="local" path="/Volumes" label="Volumes" icon={HardDrive} />
        </>
      )}
    </aside>
  );
}
