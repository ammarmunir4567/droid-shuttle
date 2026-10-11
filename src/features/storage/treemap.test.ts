import { describe, expect, it } from "vitest";
import { squarify, type Rect } from "./treemap";

const box: Rect = { x: 0, y: 0, w: 600, h: 400 };
const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.01;

describe("squarify", () => {
  const values = [900, 400, 300, 250, 120, 60, 40, 10, 5];
  const tiles = squarify(values.map((value) => ({ value, item: value })), box);

  it("gives every item a tile whose area is proportional to its value", () => {
    expect(tiles).toHaveLength(values.length);
    const total = values.reduce((a, b) => a + b, 0);
    for (const t of tiles) expect(area(t) / area(box)).toBeCloseTo(t.item / total, 6);
  });

  it("fills the box exactly, stays inside it, and never overlaps", () => {
    expect(tiles.reduce((n, t) => n + area(t), 0)).toBeCloseTo(area(box), 4);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-6);
      expect(t.y).toBeGreaterThanOrEqual(-1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(box.w + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(box.h + 1e-6);
    }
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) expect(overlap(tiles[i], tiles[j])).toBe(false);
  });

  it("keeps tiles reasonably square so labels fit", () => {
    const biggest = tiles.slice(0, 5);
    for (const t of biggest) expect(Math.max(t.w / t.h, t.h / t.w)).toBeLessThan(4);
  });

  it("puts the biggest item first and handles edge cases", () => {
    expect(tiles[0].item).toBe(900);
    const [only, ...rest] = squarify([{ value: 7, item: "only" }], box);
    expect(rest).toEqual([]);
    expect([only.x, only.y, only.w, only.h, only.item]).toEqual([0, 0, expect.closeTo(600, 6), expect.closeTo(400, 6), "only"]);
    expect(squarify([], box)).toEqual([]);
    expect(squarify([{ value: 0, item: "x" }, { value: -3, item: "y" }], box)).toEqual([]);
    expect(squarify([{ value: 1, item: "x" }], { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
    const some = squarify([{ value: 0, item: "gone" }, { value: 5, item: "a" }, { value: 5, item: "b" }], box);
    expect(some.map((t) => t.item).sort()).toEqual(["a", "b"]);
  });

  it("respects a box that does not start at the origin", () => {
    const off = squarify([{ value: 3, item: "a" }, { value: 1, item: "b" }], { x: 100, y: 50, w: 200, h: 100 });
    expect(Math.min(...off.map((t) => t.x))).toBeCloseTo(100);
    expect(Math.min(...off.map((t) => t.y))).toBeCloseTo(50);
    expect(off.reduce((n, t) => n + area(t), 0)).toBeCloseTo(20000);
  });
});
