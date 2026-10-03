import { describe, expect, it } from "vitest";
import { EntryNameSet, entryNameRefusal, printableName } from "./entry-names";

/** Ruling R26: the one name rule shared by the backup walk, verifyFullBackup and the restore. */
describe("entry names a full backup may hold", () => {
  it("accepts the names the app itself writes, and ordinary hand-placed ones", () => {
    const names = new EntryNameSet();
    for (const p of ["files/images/firearms/cmh2abc_1727000000000.jpg", "files/documents/3f9a0c1e-0000-4000-8000-000000000000.pdf", "files/images/Été 2024/photo (1).JPG", "files/images/a/b/c/d.png"]) {
      expect(names.add(p), p).toBeNull();
    }
  });

  it.each([
    ["files/other/x.jpg", /does not belong/],
    ["db2.json", /does not belong/],
    ["files/images/a\u0007b.jpg", /control character/],
    ["files/images/a\u009bb.jpg", /control character/],
    ["files/images/line\nbreak.jpg", /control character/],
    ["files/images/.hidden.jpg", /hidden/],
    ["files/images/.pre-restore-20260101-000000/x.jpg", /hidden/],
    ["files/documents/x.pdf.rot", /work file/],
    ["files/documents/x.pdf.1a2b3c4d.tmp", /work file/],
  ])("refuses %j on its own", (p, why) => {
    expect(entryNameRefusal(p)).toMatch(why);
    expect(new EntryNameSet().add(p)).toMatch(why);
  });

  it("collisions: the name added FIRST is kept, the later one refused — case, Unicode normalisation, file-vs-folder in both orders", () => {
    const pairs: Array<[string, string]> = [
      ["files/images/A.jpg", "files/images/a.jpg"],
      ["files/images/café.jpg", "files/images/café.jpg"],
      ["files/images/a", "files/images/a/b.jpg"], // a file, then a folder of the same name
      ["files/images/A/b.jpg", "files/images/a"], // a folder, then a file of the same name
      ["files/images/Dir/x.jpg", "files/images/dir/X.JPG"],
    ];
    for (const [first, second] of pairs) {
      const names = new EntryNameSet();
      expect(names.add(first), first).toBeNull();
      expect(names.add(second), second).toMatch(/same file or folder as/);
      // The refused name was not added: a third, unrelated name under the first one's folder is still fine.
      expect(names.add("files/images/unrelated.jpg")).toBeNull();
    }
    // Two folders that differ only by case are ONE folder there; files in them collide only when their names do.
    const names = new EntryNameSet();
    expect(names.add("files/images/Dir/x.jpg")).toBeNull();
    expect(names.add("files/images/dir/y.jpg")).toBeNull();
  });

  it("a refused name leaves no trace: the name it collided with can still get siblings, and the same name is refused again", () => {
    const names = new EntryNameSet();
    expect(names.add("files/images/a")).toBeNull();
    expect(names.add("files/images/a/b/c.jpg")).not.toBeNull();
    expect(names.add("files/images/a/b/c.jpg")).not.toBeNull();
    expect(names.add("files/images/b/c.jpg")).toBeNull();
  });

  it("printableName shows control characters as ?", () => {
    expect(printableName("a\u0007b\u001b[31mc\n")).toBe("a?b?[31mc?");
  });
});
