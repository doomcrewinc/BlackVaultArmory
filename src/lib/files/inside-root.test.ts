import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInside } from "./inside-root";

describe("resolveInside", () => {
  const root = path.resolve("/srv/uploads/docs");

  it("joins segments under the root", () => {
    expect(resolveInside(root, "a.jpg")).toBe(path.join(root, "a.jpg"));
    expect(resolveInside(root, "thumbs", "a.webp")).toBe(path.join(root, "thumbs", "a.webp"));
  });

  it.each([
    ["..", "x"],
    ["../x.jpg"],
    ["a/../../x.jpg"],
    ["/etc/passwd"],
    [".."],
    [""],
    ["thumbs", "../../x"],
  ])("refuses %j", (...segments) => {
    expect(() => resolveInside(root, ...segments)).toThrow("outside its folder");
  });

  it("refuses a sibling folder that shares the root's name as a prefix", () => {
    expect(() => resolveInside(root, "../docs-evil/x.jpg")).toThrow();
  });
});
