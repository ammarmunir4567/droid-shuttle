import { describe, expect, it } from "vitest";
import { compileText, makeMatcher, parseLogcatLine, splitChunk } from "./logcat";

const line = (s: string) => parseLogcatLine(s, 1)!;

describe("parseLogcatLine", () => {
  it("parses threadtime lines", () => {
    const l = line("10-04 17:16:57.672  1234  5678 I ActivityManager: Start proc 4242:com.example/u0a1");
    expect(l).toMatchObject({ time: "10-04 17:16:57.672", pid: 1234, tid: 5678, level: "I", tag: "ActivityManager", msg: "Start proc 4242:com.example/u0a1" });
  });
  it("handles padded tags, colons in the message and empty messages", () => {
    expect(line("10-04 17:16:57.672   999   999 V SurfaceFlinger: vsync: a:b")).toMatchObject({ tag: "SurfaceFlinger", msg: "vsync: a:b" });
    expect(line("10-04 17:16:57.672   999   999 E libc    : Fatal")).toMatchObject({ tag: "libc", level: "E" });
    expect(line("10-04 17:16:57.672   999   999 D Tag: ")).toMatchObject({ tag: "Tag", msg: "" });
  });
  it("ignores buffer headers and garbage", () => {
    expect(parseLogcatLine("--------- beginning of main", 1)).toBeNull();
    expect(parseLogcatLine("", 1)).toBeNull();
  });
});

describe("filters", () => {
  const lines = [
    line("10-04 17:16:57.672  1  1 V Surface: vsync"),
    line("10-04 17:16:57.672  2  2 D App: hello world"),
    line("10-04 17:16:57.672  2  2 W App: slow frame"),
    line("10-04 17:16:57.672  3  3 E Other: boom"),
  ];
  const run = (f: Partial<Parameters<typeof makeMatcher>[0]>) => lines.filter(makeMatcher({ level: "V", tag: "", text: "", pids: null, ...f })).map((l) => l.msg);
  it("filters by minimum level", () => { expect(run({ level: "W" })).toEqual(["slow frame", "boom"]); });
  it("filters by tag, text (case-insensitive) and pid", () => {
    expect(run({ tag: "app" })).toEqual(["hello world", "slow frame"]);
    expect(run({ text: "HELLO" })).toEqual(["hello world"]);
    expect(run({ pids: new Set([3]) })).toEqual(["boom"]);
  });
  it("supports /regex/ and falls back to plain text when the regex is invalid", () => {
    expect(run({ text: "/slow|boom/" })).toEqual(["slow frame", "boom"]);
    expect(compileText("/[/")?.("a [ b /[/")).toBe(true); // invalid regex → literal text "/[/"
    expect(compileText("  ")).toBeNull();
  });
});

describe("splitChunk", () => {
  it("keeps a partial last line for the next chunk", () => {
    const a = splitChunk("", "one\ntwo\nthr");
    expect(a).toEqual({ lines: ["one", "two"], carry: "thr" });
    expect(splitChunk(a.carry, "ee\n")).toEqual({ lines: ["three"], carry: "" });
  });
});
