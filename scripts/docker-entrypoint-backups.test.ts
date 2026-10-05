/**
 * scripts/docker-entrypoint.sh, the /app/backups step (full backups, Task 6,
 * Review Focus 1: a NAS mount where chown/chmod is refused).
 *
 * The real script is run under `sh`, on the host, with two things replaced:
 * - its fixed paths (/app/backups, /run/blackvault-secrets, /run/secrets,
 *   /proc/self/mountinfo) point into a scratch folder (a text substitution on
 *   a COPY). The scratch mountinfo does not exist unless a test writes it, so
 *   the mount check finds nothing to read and says nothing;
 * - `id`, `chown`, `chmod` and `su-exec` are stubs first on PATH: `id -u`
 *   says 0, chown/chmod can be told to refuse the backup folder (what a
 *   network share does), and `su-exec <user> cmd` just runs cmd — as the
 *   test's own user, so "not writable by the app user" is a real failed
 *   write into a folder this user cannot write to.
 * What this cannot show is the real image: busybox sh, real root, a real
 * su-exec. scripts/ci/full-backup-entrypoint-linux.sh runs the same two
 * refused cases in a container of the built image.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const skip = process.platform === "win32" || process.getuid?.() === 0;

let tmp: string;
let bin: string;
let backups: string;
let uploads: string;
let data: string;
let script: string;

function stub(name: string, body: string) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-entrypoint-"));
  bin = path.join(tmp, "bin");
  backups = path.join(tmp, "app-backups");
  uploads = path.join(tmp, "app-uploads");
  data = path.join(tmp, "app-data");
  fs.mkdirSync(bin);
  const text = fs
    .readFileSync(path.join(ROOT, "scripts/docker-entrypoint.sh"), "utf8")
    .replaceAll("/app/backups", backups)
    .replaceAll("/app/uploads", uploads)
    .replaceAll("/app/data", data)
    .replaceAll("/run/blackvault-secrets", path.join(tmp, "src-secrets"))
    .replaceAll("/run/secrets", path.join(tmp, "dst-secrets"))
    .replaceAll("/proc/self/mountinfo", path.join(tmp, "mountinfo"));
  expect(text).toContain(`BACKUPS=${backups}`);
  script = path.join(tmp, "entrypoint.sh");
  fs.writeFileSync(script, text);
  stub("id", '[ "$1" = "-u" ] && { echo 0; exit 0; }; exec /usr/bin/id "$@"');
  // Refuse (like a network share) when told to, but only for the backup folder
  // and the folders in BV_REFUSE_AT: the key files keep working.
  for (const tool of ["chown", "chmod"]) {
    stub(
      tool,
      `echo "${tool} $*" >> "${tmp}/calls"
for a in "$@"; do last=$a; done
case ",$BV_REFUSE," in *,${tool},*) [ "$last" = "${backups}" ] && { echo "${tool}: Operation not permitted" >&2; exit 1; } ;; esac
${
  tool === "chown"
    ? `case ",$BV_REFUSE_AT," in *,"$last",*) echo "chown: Operation not permitted" >&2; exit 1 ;; esac
case "$last" in ${uploads}|${data})
  # What the folder would report as its owner afterwards (the host test user cannot really chown).
  find "$last" -print | while IFS= read -r p; do echo nextjs:nodejs > "${tmp}/owner.$(echo "$p" | tr / _)"; done ;;
esac
exit 0`
    : `exec /bin/chmod "$@"`
}`,
    );
  }
  // stat -c %U:%G reads the owner a test recorded with setOwner(); nothing recorded means the app user.
  stub(
    "stat",
    `if [ "$1" = "-c" ] && [ "$2" = "%U:%G" ]; then
  f="${tmp}/owner.$(echo "$3" | tr / _)"; if [ -f "$f" ]; then cat "$f"; else echo nextjs:nodejs; fi; exit 0
fi
exec /usr/bin/stat "$@"`,
  );
  stub("su-exec", `echo "su-exec $1" >> "${tmp}/calls"; shift; exec "$@"`);
});
afterEach(() => {
  if (fs.existsSync(backups) && fs.statSync(backups).isDirectory()) fs.chmodSync(backups, 0o700);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const setOwner = (p: string, owner: string) => fs.writeFileSync(path.join(tmp, `owner.${p.replaceAll("/", "_")}`), `${owner}\n`);
const ownerOf = (p: string) => {
  const f = path.join(tmp, `owner.${p.replaceAll("/", "_")}`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "nextjs:nodejs";
};

function run(env: Record<string, string> = {}) {
  const r = spawnSync("sh", [script, "sh", "-c", "echo APP-STARTED; exit 7"], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env } as unknown as NodeJS.ProcessEnv,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls: fs.existsSync(path.join(tmp, "calls")) ? fs.readFileSync(path.join(tmp, "calls"), "utf8") : "" };
}
const started = (r: ReturnType<typeof run>) => {
  // The command ran, as the app user, and its exit code is the container's.
  expect(r.stdout).toBe("APP-STARTED\n");
  expect(r.code).toBe(7);
  expect(r.calls.trim().split("\n").pop()).toBe("su-exec nextjs:nodejs");
};

describe.skipIf(skip)("docker-entrypoint.sh: the /app/backups step", () => {
  it("normal disk: creates the folder, chowns it to the app user, mode 0700, no warning, then starts the command", () => {
    const r = run();
    started(r);
    expect(r.stderr).toBe("");
    expect(fs.statSync(backups).mode & 0o777).toBe(0o700);
    expect(r.calls).toContain(`chown nextjs:nodejs ${backups}`);
    expect(r.calls).toContain(`chmod 700 ${backups}`);
    expect(fs.readdirSync(backups)).toEqual([]); // the write test left nothing behind
  });

  it("Review Focus 1: chown refused, but the app user can write → one clear WARNING, and it continues", () => {
    fs.mkdirSync(backups, { mode: 0o755 });
    const r = run({ BV_REFUSE: "chown,chmod" });
    started(r);
    const warnings = r.stderr.split("\n").filter(Boolean);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[entrypoint\] WARNING: could not set the owner of the backup folder .*app-backups.*so its mode was left as it is\. The app can write to it, so full backups will work/);
    expect(fs.statSync(backups).mode & 0o777).toBe(0o755); // untouched
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  // Fix round 1 (Important 1). chmod needs only "the caller owns the folder",
  // so it can SUCCEED where chown is refused (root owns the mount but may not
  // chown it). 0700 with an owner that is not the app user would lock the app
  // out of a folder it could write through group/other bits — and the change
  // would stay on the share.
  it("fix round 1: after a refused chown, chmod is NOT run on the backup folder — a 0777 folder stays 0777 and stays writable", () => {
    fs.mkdirSync(backups);
    fs.chmodSync(backups, 0o777);
    const r = run({ BV_REFUSE: "chown" }); // chmod itself would succeed
    started(r);
    expect(r.calls).toContain(`chown nextjs:nodejs ${backups}`);
    expect(r.calls.split("\n").filter((l) => l.startsWith("chmod ") && l.endsWith(` ${backups}`))).toEqual([]);
    expect(fs.statSync(backups).mode & 0o777).toBe(0o777);
    expect(r.stderr).toMatch(/^\[entrypoint\] WARNING: could not set the owner of the backup folder .*so its mode was left as it is\. The app can write to it/);
    expect(r.stderr.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("chown accepted but chmod refused, still writable → the warning names the mode only", () => {
    const r = run({ BV_REFUSE: "chmod" });
    started(r);
    expect(r.stderr).toMatch(/^\[entrypoint\] WARNING: could not set the mode of the backup folder .*The app can write to it/);
    expect(r.stderr).not.toMatch(/owner/);
  });

  it("Review Focus 1: chown and chmod refused and the app user CANNOT write → a WARNING naming the folder and BLACKVAULT_BACKUP_DIR, and the app STILL starts", () => {
    fs.mkdirSync(backups, { mode: 0o500 });
    const r = run({ BV_REFUSE: "chown,chmod" });
    started(r);
    const warnings = r.stderr.split("\n").filter(Boolean);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[entrypoint\] WARNING: the backup folder .*app-backups is not writable by the app \(uid 1001\); its owner could not be changed, so its mode was left as it is\..*BLACKVAULT_BACKUP_DIR.*BlackVault starts anyway\.$/);
  });

  it("writability is TESTED, not inferred: chown and chmod both 'succeed' (a share that ignores them) but a write fails → still the not-writable WARNING", () => {
    fs.mkdirSync(backups, { mode: 0o700 });
    // chmod is refused silently here: the stub reports success without changing anything, like a share with fixed permissions.
    stub("chmod", `echo "chmod $*" >> "${tmp}/calls"; exit 0`);
    fs.chmodSync(backups, 0o500);
    const r = run();
    started(r);
    expect(r.stderr).toMatch(/^\[entrypoint\] WARNING: the backup folder .* is not writable by the app \(uid 1001\)\. Full backups will fail/);
  });

  it("the folder cannot even be created → a WARNING, and the app still starts", () => {
    fs.writeFileSync(backups, "a file where the folder should be");
    const r = run();
    started(r);
    expect(r.stderr).toMatch(/^\[entrypoint\] WARNING: could not create the backup folder /);
  });

  it("the key step is unchanged and comes first: the key is copied, 0400, before the backup folder is touched; a symlinked key still refuses to start", () => {
    const src = path.join(tmp, "src-secrets");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "blackvault_encryption_key"), "ab".repeat(32));
    const r = run({ BV_REFUSE: "chown,chmod" });
    started(r);
    const copy = path.join(tmp, "dst-secrets", "blackvault_encryption_key");
    expect(fs.readFileSync(copy, "utf8")).toBe("ab".repeat(32));
    expect(fs.statSync(copy).mode & 0o777).toBe(0o400);
    const calls = r.calls.trim().split("\n");
    expect(calls.indexOf(`chmod 400 ${copy}`)).toBeLessThan(calls.indexOf(`chown nextjs:nodejs ${backups}`));

    fs.rmSync(path.join(src, "blackvault_encryption_key"));
    fs.symlinkSync("/etc/hosts", path.join(src, "blackvault_encryption_key"));
    const bad = run();
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/Refusing to start: secrets\/blackvault_encryption_key is a symbolic link/);
  });

  describe("is a folder mounted at /app/backups?", () => {
    // One line of /proc/self/mountinfo: field 5 is the mount point.
    const mountLine = (id: number, mountPoint: string, source = "/dev/sda1") =>
      `${id} 1 8:1 / ${mountPoint} rw,relatime - ext4 ${source} rw\n`;
    const ROOT_LINE = mountLine(100, "/", "overlay");
    const mountinfo = (text: string) => fs.writeFileSync(path.join(tmp, "mountinfo"), text);
    const NOT_MOUNTED = /^\[entrypoint\] WARNING: no folder is mounted at .*app-backups, so full backups written there are lost when the container is recreated\..*BLACKVAULT_BACKUP_DIR.*:\/.*app-backups.*BlackVault starts anyway\.$/;

    it("not a mount point → ONE warning that names BLACKVAULT_BACKUP_DIR and the compose line, and the app starts", () => {
      mountinfo(ROOT_LINE + mountLine(101, "/proc") + mountLine(102, `${backups}-other`) + mountLine(103, path.join(backups, "below")));
      const r = run();
      started(r);
      const warnings = r.stderr.split("\n").filter(Boolean);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(NOT_MOUNTED);
      expect(warnings[0]).toContain("${BLACKVAULT_BACKUP_DIR:-${DATA_DIR:-./data}/backups}:");
    });

    it("a mount point (a bind mount or a named volume) → no warning", () => {
      mountinfo(ROOT_LINE + mountLine(101, backups));
      const r = run();
      started(r);
      expect(r.stderr).toBe("");
    });

    it("a folder mounted over a parent of it → no warning: what is written there is kept too", () => {
      mountinfo(ROOT_LINE + mountLine(101, path.dirname(backups)));
      const r = run();
      started(r);
      expect(r.stderr).toBe("");
    });

    it("the mount table cannot be read (no /proc) → no warning, and the app starts", () => {
      const r = run();
      started(r);
      expect(r.stderr).toBe("");
    });

    it("the mount table does not even list the root (not the format this reads) → no warning, and the app starts", () => {
      mountinfo("something else entirely\n");
      const r = run();
      started(r);
      expect(r.stderr).toBe("");
    });

    it.each([
      ["fails", 'echo "awk: boom" >&2; exit 2'],
      ["is missing", "exit 127"],
      ["prints nonsense", "echo maybe"],
    ])("the detection command %s → no crash, no warning, and the app starts", (_what, body) => {
      mountinfo(ROOT_LINE);
      stub("awk", body);
      const r = run();
      started(r);
      expect(r.stderr).toBe("");
    });

    it("the folder could not be created → only that warning, not this one too", () => {
      mountinfo(ROOT_LINE);
      fs.writeFileSync(backups, "a file where the folder should be");
      const r = run();
      started(r);
      const warnings = r.stderr.split("\n").filter(Boolean);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/could not create the backup folder/);
    });
  });

  describe.each([
    ["uploads", () => uploads, "Uploading photos and documents", "<DATA_DIR>/uploads"],
    ["data", () => data, "Saving to the SQLite database", "<DATA_DIR>/db"],
  ])("the /app/%s folder", (_name, folderOf, what, hostFolder) => {
    const folder = () => folderOf();
    const warnings = (r: ReturnType<typeof run>) => r.stderr.split("\n").filter(Boolean);
    const fixes = (r: ReturnType<typeof run>) => r.calls.split("\n").filter((l) => l.startsWith("chown ") && l.endsWith(` ${folder()}`));

    it("owned by another uid: given to the app user together with what is inside it, no warning", () => {
      fs.mkdirSync(path.join(folder(), "images"), { recursive: true });
      fs.writeFileSync(path.join(folder(), "images", "a.jpg"), "x");
      for (const p of [folder(), path.join(folder(), "images"), path.join(folder(), "images", "a.jpg")]) setOwner(p, "host:host");
      const r = run();
      started(r);
      expect(fixes(r)).toEqual([`chown -hR nextjs:nodejs ${folder()}`]);
      expect(ownerOf(folder())).toBe("nextjs:nodejs");
      expect(ownerOf(path.join(folder(), "images", "a.jpg"))).toBe("nextjs:nodejs");
      expect(r.stderr).toBe("");
      expect(r.calls.split("\n").filter((l) => l.startsWith("chmod ") && l.includes(folder()))).toEqual([]);
      expect(fs.readdirSync(folder())).toEqual(["images"]); // the write test left nothing behind
    });

    it("already owned by the app user: nothing is changed and nothing inside is walked", () => {
      fs.mkdirSync(folder());
      fs.writeFileSync(path.join(folder(), "foreign.jpg"), "x");
      setOwner(path.join(folder(), "foreign.jpg"), "host:host");
      const r = run();
      started(r);
      expect(fixes(r)).toEqual([]);
      expect(r.calls).not.toMatch(/chown -\w*R/);
      expect(ownerOf(path.join(folder(), "foreign.jpg"))).toBe("host:host");
      expect(r.stderr).toBe("");
    });

    it("chown refused but the app user can write: no warning, and the app starts", () => {
      fs.mkdirSync(folder());
      setOwner(folder(), "host:host");
      const r = run({ BV_REFUSE_AT: folder() });
      started(r);
      expect(fixes(r)).toHaveLength(1);
      expect(r.stderr).toBe("");
      expect(ownerOf(folder())).toBe("host:host");
    });

    it("chown refused and the app user cannot write: one warning naming the folder and the host command, and the app still starts", () => {
      fs.mkdirSync(folder(), { mode: 0o500 });
      setOwner(folder(), "host:host");
      const r = run({ BV_REFUSE_AT: folder() });
      started(r);
      const w = warnings(r);
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(`[entrypoint] WARNING: the folder ${folder()} is not writable by the app (uid 1001).`);
      expect(w[0]).toContain("Its owner could not be changed");
      expect(w[0]).toContain(what);
      expect(w[0]).toContain(`DATA_DIR`);
      expect(w[0]).toContain(`sudo chown -R 1001:1001 ${hostFolder}`);
      expect(w[0]).toMatch(/BlackVault starts anyway\.$/);
      fs.chmodSync(folder(), 0o700);
    });

    it("not started as root: the folder is not touched and the command just runs", () => {
      stub("id", '[ "$1" = "-u" ] && { echo 1001; exit 0; }; exec /usr/bin/id "$@"');
      fs.mkdirSync(folder());
      setOwner(folder(), "host:host");
      const r = run();
      expect(r.stdout).toBe("APP-STARTED\n");
      expect(r.code).toBe(7);
      expect(r.calls).toBe("");
      expect(ownerOf(folder())).toBe("host:host");
    });
  });

  it("a folder that does not exist is skipped without a word", () => {
    const r = run();
    started(r);
    expect(r.stderr).toBe("");
    expect(fs.existsSync(uploads)).toBe(false);
    expect(fs.existsSync(data)).toBe(false);
  });

  it("started as a non-root user: nothing is touched, the command just runs", () => {
    stub("id", '[ "$1" = "-u" ] && { echo 1001; exit 0; }; exec /usr/bin/id "$@"');
    const r = run();
    expect(r.stdout).toBe("APP-STARTED\n");
    expect(r.code).toBe(7);
    expect(r.calls).toBe("");
    expect(fs.existsSync(backups)).toBe(false);
  });
});
