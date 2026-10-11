import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Folder, Package, type LucideIcon } from "lucide-react";
import { extOf } from "./paths";

const MAP: Record<string, [string, LucideIcon]> = {};
const add = (kind: string, icon: LucideIcon, exts: string[]) => exts.forEach((e) => (MAP[e] = [kind, icon]));
add("Image", FileImage, ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "dng", "raw", "svg"]);
add("Video", FileVideo, ["mp4", "mov", "mkv", "avi", "webm", "3gp", "m4v"]);
add("Audio", FileAudio, ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac", "amr"]);
add("Document", FileText, ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "pages", "numbers", "key"]);
add("Archive", FileArchive, ["zip", "rar", "7z", "tar", "gz"]);
add("App", Package, ["apk", "xapk", "aab"]);

export function kindOf(name: string, isDir: boolean): { kind: string; icon: LucideIcon } {
  if (isDir) return { kind: "Folder", icon: Folder };
  const hit = MAP[extOf(name)];
  return hit ? { kind: hit[0], icon: hit[1] } : { kind: extOf(name) ? `${extOf(name).toUpperCase()} file` : "File", icon: File };
}
