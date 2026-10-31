import { PrismaClient } from '@prisma/client';

/** Read-only inspection: wallet balances and LP state for every user. */
async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const users = await prisma.user.findMany({
      select: {
        email: true,
        roles: { select: { role: true } },
        wallet: {
          select: {
            balances: { select: { available: true, locked: true, asset: { select: { symbol: true } } } },
          },
        },
        liquidityProvider: {
          select: {
            lpId: true,
            status: true,
            commitment: {
              select: {
                usdtCommitted: true,
                usdtAvailable: true,
                emberLocked: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: { email: 'asc' },
    });

    for (const user of users) {
      const balances = (user.wallet?.balances ?? [])
        .map((b) => `${b.asset.symbol} a=${b.available} l=${b.locked}`)
        .join(' | ');
      console.log(
        `${user.email}\n  roles: ${user.roles.map((r) => r.role).join(',') || '(none)'}\n` +
          `  balances: ${balances || '(no wallet)'}\n` +
          `  lp: ${user.liquidityProvider?.status ?? '(none)'} commitment: ${
            user.liquidityProvider?.commitment
              ? `${user.liquidityProvider.commitment.usdtCommitted} committed / ${user.liquidityProvider.commitment.usdtAvailable} available / ${user.liquidityProvider.commitment.emberLocked} ember / ${user.liquidityProvider.commitment.status}`
              : '(none)'
          }`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
