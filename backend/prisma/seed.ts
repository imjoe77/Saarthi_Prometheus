import { PrismaClient } from '@prisma/client';

import { seedAssets } from '../src/modules/assets/asset-seed';

/**
 * `prisma db seed` entry point.
 *
 * Deliberately thin: the seeding logic lives in
 * `src/modules/assets/asset-seed.ts` so it is covered by the project's lint and
 * typecheck (which only include `src/**` and `test/**`) and can be reused by the
 * integration suite without a Nest container.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    await seedAssets(prisma);
    console.log('Seeded supported assets: INR, USDT, EMBER.');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Asset seed failed:', error);
  process.exitCode = 1;
});
