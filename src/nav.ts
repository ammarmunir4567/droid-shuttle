import { FolderOpen, Image, Package, ArchiveRestore, MonitorSmartphone, PieChart, Terminal, type LucideIcon } from "lucide-react";

export type SectionId = "files" | "gallery" | "apps" | "storage" | "backup" | "mirror" | "tools";

export interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  group: "Browse" | "Manage";
  blurb: string;
}

export const SECTIONS: Section[] = [
  { id: "files", label: "Files", icon: FolderOpen, group: "Browse", blurb: "Browse, drag and drop, and transfer files." },
  { id: "gallery", label: "Gallery", icon: Image, group: "Browse", blurb: "Photos and videos, grouped by date." },
  { id: "apps", label: "Apps", icon: Package, group: "Manage", blurb: "Install, uninstall and extract APKs." },
  { id: "storage", label: "Storage", icon: PieChart, group: "Manage", blurb: "See what uses space, find duplicates, free it up." },
  { id: "backup", label: "Backup", icon: ArchiveRestore, group: "Manage", blurb: "Encrypted, incremental backups." },
  { id: "mirror", label: "Mirror", icon: MonitorSmartphone, group: "Manage", blurb: "Mirror and control your screen." },
  { id: "tools", label: "Tools", icon: Terminal, group: "Manage", blurb: "Terminal, logcat and wireless pairing." },
];
