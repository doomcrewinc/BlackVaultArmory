import { describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  MIGRATION_MODELS,
  SOURCE_UNTOUCHED,
  migrateSqliteToPostgres,
} from "./sqlite-to-postgres";
import { BACKUP_MODELS } from "../backup/models";
import { FakeClient, seeded } from "./fake-db";

async function run(
  source: FakeClient,
  target: FakeClient,
  extra: { dryRun?: boolean; force?: boolean } = {},
) {
  const lines: string[] = [];
  const connectTarget = vi.fn(() => target.asDb());
  const code = await migrateSqliteToPostgres({
    source: source.asDb(),
    connectTarget,
    dryRun: extra.dryRun ?? false,
    force: extra.force ?? false,
    log: (l) => lines.push(l),
  });
  return { code, lines, out: lines.join("\n"), connectTarget };
}

describe("MIGRATION_MODELS", () => {
  it("is AppSettings followed by every backup model, in registry order (17 total)", () => {
    expect(MIGRATION_MODELS.map((m) => m.model)).toEqual([
      "AppSettings",
      ...BACKUP_MODELS.map((m) => m.model),
    ]);
    expect(MIGRATION_MODELS).toHaveLength(17);
  });
});

describe("migrateSqliteToPostgres", () => {
  it("copies every model parent-first and verifies", async () => {
    const source = seeded();
    const target = new FakeClient();
    const { code, out } = await run(source, target);

    expect(code).toBe(0);
    expect(out).toContain("VERIFIED: all 17 models match");
    for (const m of MIGRATION_MODELS) {
      expect(target.delegates[m.delegate].rows).toEqual(
        source.delegates[m.delegate].rows,
      );
    }
    expect([...new Set(target.order)]).toEqual(
      MIGRATION_MODELS.map((m) => m.model),
    );
    expect(source.order).toEqual([]); // source never written
    expect(source.disconnected && target.disconnected).toBe(true);
  });

  it("dry run reports counts and never connects to the target", async () => {
    const source = seeded();
    const { code, out, connectTarget } = await run(source, new FakeClient(), {
      dryRun: true,
    });
    expect(code).toBe(0);
    expect(connectTarget).not.toHaveBeenCalled();
    expect(out).toContain("34 rows across 17 models would be copied");
  });

  it("refuses a non-empty target without --force and writes nothing", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.dateNormalizationAudit.rows = [{ id: "existing" }];
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("REFUSING");
    expect(out).toContain("DateNormalizationAudit: 1 rows");
    expect(out).toContain(SOURCE_UNTOUCHED);
    expect(target.order).toEqual([]);
  });

  it("copies in batches of 500", async () => {
    const source = new FakeClient();
    source.delegates.firearm.rows = Array.from({ length: 1201 }, (_, i) => ({
      id: `f${String(i).padStart(5, "0")}`,
    }));
    const target = new FakeClient();
    const { code } = await run(source, target);

    expect(code).toBe(0);
    expect(BATCH_SIZE).toBe(500);
    expect(target.delegates.firearm.createManyCalls).toEqual([500, 500, 201]);
    expect(target.delegates.firearm.rows).toHaveLength(1201);
  });

  it("exits 1 with a mismatch message when a target count comes back short", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.batteryChangeLog.countShortBy = 1;
    const { code, out, lines } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("MISMATCH");
    expect(
      lines.some(
        (l) =>
          l.includes("BatteryChangeLog") &&
          l.includes("expected 2") &&
          l.includes("found 1"),
      ),
    ).toBe(true);
    expect(out).toContain(SOURCE_UNTOUCHED);
    // The target must end as it started: a failed verification rolls the copy back.
    for (const m of MIGRATION_MODELS)
      expect(target.delegates[m.delegate].rows).toEqual([]);
    expect(out).toContain("rolled back");
    expect(target.disconnected).toBe(true);
  });

  it("exits 1 when a copied DateTime differs by even one millisecond", async () => {
    const source = seeded();
    const target = new FakeClient();
    const orig = target.delegates.firearm.createMany.bind(
      target.delegates.firearm,
    );
    target.delegates.firearm.createMany = async ({ data }) =>
      orig({
        data: data.map((r) => ({
          ...r,
          createdAt: new Date((r.createdAt as Date).getTime() + 1),
        })),
      });
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("Firearm: 2 row(s) missing or different on target");
    // The target must end as it started: a failed verification rolls the copy back.
    for (const m of MIGRATION_MODELS)
      expect(target.delegates[m.delegate].rows).toEqual([]);
    expect(out).toContain("rolled back");
  });

  it("rolls the target back and exits 1 when a batch is written short", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.build.writeShortBy = 1;
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    // The target must end as it started: a failed verification rolls the copy back.
    for (const m of MIGRATION_MODELS)
      expect(target.delegates[m.delegate].rows).toEqual([]);
    expect(out).toContain("rolled back");
    expect(source.disconnected && target.disconnected).toBe(true);
  });

  it("exits 1 when the committed target no longer matches what was verified", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.sessionDrill.countShortOutsideTx = 1;
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("POST-COMMIT CHECK FAILED");
    expect(out).toContain("SessionDrill: verified 2, now 1");
  });

  it("disconnects both clients when the source fails", async () => {
    const source = seeded();
    source.delegates.appSettings.count = async () => {
      throw new Error("boom");
    };
    const target = new FakeClient();
    const { code, out } = await run(source, target);
    expect(code).toBe(1);
    expect(out).toContain("FAILED: boom");
    expect(source.disconnected).toBe(true);
  });
});

describe("onVerified", () => {
  async function withHook(
    source: FakeClient,
    target: FakeClient,
    dryRun = false,
  ) {
    const onVerified = vi.fn();
    const code = await migrateSqliteToPostgres({
      source: source.asDb(),
      connectTarget: () => target.asDb(),
      dryRun,
      force: false,
      log: () => {},
      onVerified,
    });
    return { code, onVerified };
  }

  it("is called once with the verified counts after a verified copy", async () => {
    const { code, onVerified } = await withHook(seeded(), new FakeClient());
    expect(code).toBe(0);
    expect(onVerified).toHaveBeenCalledTimes(1);
    const [counts, total] = onVerified.mock.calls[0];
    expect(total).toBe(34);
    expect(counts.get("Firearm")).toBe(2);
  });

  it("is not called on a dry run, a refusal, a rollback or a post-commit failure", async () => {
    expect(
      (await withHook(seeded(), new FakeClient(), true)).onVerified,
    ).not.toHaveBeenCalled();

    const occupied = new FakeClient();
    occupied.delegates.firearm.rows = [{ id: "existing" }];
    expect(
      (await withHook(seeded(), occupied)).onVerified,
    ).not.toHaveBeenCalled();

    const short = new FakeClient();
    short.delegates.build.writeShortBy = 1;
    expect((await withHook(seeded(), short)).onVerified).not.toHaveBeenCalled();

    const drifting = new FakeClient();
    drifting.delegates.sessionDrill.countShortOutsideTx = 1;
    expect(
      (await withHook(seeded(), drifting)).onVerified,
    ).not.toHaveBeenCalled();
  });
});
