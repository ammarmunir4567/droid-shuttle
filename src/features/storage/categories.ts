import { AppWindow, Archive, Film, FileText, Image, Music, File, type LucideIcon } from "lucide-react";
import type { StorageCategory } from "../../lib/api";

export const CATEGORY: Record<StorageCategory, { label: string; color: string; icon: LucideIcon }> = {
  images: { label: "Photos", color: "var(--cat-images)", icon: Image },
  videos: { label: "Videos", color: "var(--cat-videos)", icon: Film },
  audio: { label: "Music & audio", color: "var(--cat-audio)", icon: Music },
  documents: { label: "Documents", color: "var(--cat-documents)", icon: FileText },
  archives: { label: "Archives", color: "var(--cat-archives)", icon: Archive },
  apps: { label: "App packages", color: "var(--cat-apps)", icon: AppWindow },
  other: { label: "Other files", color: "var(--cat-other)", icon: File },
};
