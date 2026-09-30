import "./load-env";
import { prisma } from "../src/lib/prisma";
import { decryptField } from "../src/lib/crypto";
import { withoutRowAudit } from "../src/lib/audit/context";

async function main() {
  const firearms = await prisma.firearm.findMany({
    where: { serialNumber: { startsWith: "enc:" } },
    select: { id: true, name: true, serialNumber: true },
  });

  console.log(`Found ${firearms.length} encrypted serial numbers.`);

  for (const firearm of firearms) {
    const plain = decryptField(firearm.serialNumber);
    if (plain && plain !== firearm.serialNumber && !plain.startsWith("[unreadable")) {
      // A one-off data repair, not a user's edit: kept out of the audit log.
      await withoutRowAudit(() =>
        prisma.firearm.update({
          where: { id: firearm.id },
          data: { serialNumber: plain },
        })
      );
      console.log(`Decrypted serial for firearm: ${firearm.name}`);
    }
  }

  console.log("Done.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
