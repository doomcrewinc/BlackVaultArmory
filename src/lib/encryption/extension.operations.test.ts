import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { EncryptedFieldQueryError, withEncryption } from "./extension";

/**
 * Final review FIX 9: the extension fails CLOSED on a Prisma operation it
 * does not know. Prisma 5.22 has no `updateManyAndReturn`, but Prisma 6 adds
 * it; passed through untouched it would write plaintext and return
 * ciphertext. The hook is driven directly, through a fake base client whose
 * `$extends` hands back the extension definition.
 */
type Hook = (p: { model: string; operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) => Promise<unknown>;

function hook(): Hook {
  const fake = { $extends: (def: unknown) => def } as unknown as PrismaClient;
  const def = withEncryption(fake) as unknown as { query: { $allModels: { $allOperations: Hook } } };
  return def.query.$allModels.$allOperations;
}

describe("unknown Prisma operations (fail closed)", () => {
  it.each(["Firearm", "Accessory", "Gear"])("updateManyAndReturn on %s throws EncryptedFieldQueryError and never reaches the database", async (model) => {
    const query = vi.fn(async () => []);
    const err = await hook()({
      model,
      operation: "updateManyAndReturn",
      args: { where: { id: "x" }, data: { serialNumber: "PLAINTEXT-SERIAL" } },
      query,
    }).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(EncryptedFieldQueryError);
    expect(String(err?.message)).toContain(`operation updateManyAndReturn is not supported on ${model}`);
    expect(query).not.toHaveBeenCalled();
  });

  it("an unknown operation on a model with no encrypted field passes through", async () => {
    const query = vi.fn(async () => [{ id: "b1" }]);
    await expect(hook()({ model: "Build", operation: "updateManyAndReturn", args: { data: { name: "x" } }, query })).resolves.toEqual([
      { id: "b1" },
    ]);
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "create", "createMany",
    "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany", "count", "aggregate", "groupBy",
  ])("the known operation %s on Firearm is not refused", async (operation) => {
    const query = vi.fn(async () => null);
    await expect(hook()({ model: "Firearm", operation, args: {}, query })).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });
});
