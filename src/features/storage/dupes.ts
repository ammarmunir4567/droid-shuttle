import type { DupGroup, StorageFile } from "../../lib/api";

/** Which copy of each set to keep. */
export type KeepRule = "oldest" | "newest" | "shortest";
export interface Choice { keep: string; skip: boolean }
export type Choices = Record<string, Choice>;

export function pickKeeper(g: DupGroup, rule: KeepRule): string {
  const by = (cmp: (a: StorageFile, b: StorageFile) => number) => [...g.files].sort((a, b) => cmp(a, b) || a.path.localeCompare(b.path))[0].path;
  if (rule === "newest") return by((a, b) => b.mtime - a.mtime);
  if (rule === "shortest") return by((a, b) => a.path.length - b.path.length);
  return by((a, b) => a.mtime - b.mtime);
}

export function defaultChoices(groups: DupGroup[], rule: KeepRule, prev: Choices = {}): Choices {
  return Object.fromEntries(groups.map((g) => [g.hash, { keep: pickKeeper(g, rule), skip: prev[g.hash]?.skip ?? false }]));
}

/** Everything that would be deleted. One copy per set always survives, and skipped sets are untouched. */
export function deletions(groups: DupGroup[], choices: Choices): StorageFile[] {
  return groups.flatMap((g) => {
    const c = choices[g.hash];
    if (!c || c.skip) return [];
    const keep = g.files.some((f) => f.path === c.keep) ? c.keep : pickKeeper(g, "oldest");
    return g.files.filter((f) => f.path !== keep);
  });
}

export const reclaimable = (files: StorageFile[]) => files.reduce((n, f) => n + f.size, 0);
