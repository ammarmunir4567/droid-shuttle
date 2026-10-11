// Squarified treemap layout (Bruls, Huizing & van Wijk): tiles stay close to square so labels fit and sizes are easy to compare.

export interface Rect { x: number; y: number; w: number; h: number }
export type Tile<T> = Rect & { item: T };

/** Lay `items` out inside `box` so each tile's area is proportional to its value. Zero/negative values are dropped. */
export function squarify<T>(items: { value: number; item: T }[], box: Rect): Tile<T>[] {
  const data = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = data.reduce((n, d) => n + d.value, 0);
  if (!data.length || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const areas = data.map((d) => d.value * scale);

  const worst = (row: number[], side: number) => {
    const sum = row.reduce((n, a) => n + a, 0);
    const max = Math.max(...row), min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const out: Tile<T>[] = [];
  let { x, y, w, h } = box;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    let row = [areas[i]];
    let best = worst(row, side);
    let j = i + 1;
    while (j < areas.length) {
      const next = [...row, areas[j]];
      const score = worst(next, side);
      if (score > best) break; // adding another tile makes the row worse
      row = next;
      best = score;
      j++;
    }
    const thick = row.reduce((n, a) => n + a, 0) / side;
    if (w >= h) {
      let cy = y; // a column down the left edge
      row.forEach((a, k) => { const hh = a / thick; out.push({ x, y: cy, w: thick, h: hh, item: data[i + k].item }); cy += hh; });
      x += thick; w -= thick;
    } else {
      let cx = x; // a row along the top edge
      row.forEach((a, k) => { const ww = a / thick; out.push({ x: cx, y, w: ww, h: thick, item: data[i + k].item }); cx += ww; });
      y += thick; h -= thick;
    }
    i = j;
  }
  return out;
}
