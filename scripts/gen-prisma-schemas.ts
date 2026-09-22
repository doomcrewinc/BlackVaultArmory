import fs from "fs";
import path from "path";
import { PROVIDERS, renderSchema, type ProviderDir } from "../src/lib/db/schema-codegen";

const root = path.join(__dirname, "..");
const base = fs.readFileSync(path.join(root, "prisma", "schema.base.prisma"), "utf8");

for (const dir of Object.keys(PROVIDERS) as ProviderDir[]) {
  const out = path.join(root, "prisma", dir, "schema.prisma");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderSchema(base, dir), "utf8");
  console.log(`wrote prisma/${dir}/schema.prisma`);
}
