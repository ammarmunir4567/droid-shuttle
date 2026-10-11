export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
export const parentPath = (p: string) => {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
};
export const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
export const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent.replace(/\/+$/, "") + "/");
export const extOf = (n: string) => {
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1).toLowerCase() : "";
};
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
