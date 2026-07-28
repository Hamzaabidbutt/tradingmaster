/**
 * Seeds strategy configurations. Idempotent — safe to run repeatedly.
 *   npm run db:seed
 */
import { PrismaClient } from "@prisma/client";
import { STRATEGIES } from "../src/engines/strategies";

const prisma = new PrismaClient();

async function main() {
  for (const s of STRATEGIES) {
    await prisma.strategyConfig.upsert({
      where: { key: s.key },
      update: { name: s.name, description: s.description },
      create: {
        key: s.key,
        name: s.name,
        description: s.description,
        weight: s.defaultWeight,
        enabled: true,
      },
    });
  }
  console.log(`Seeded ${STRATEGIES.length} strategies.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
