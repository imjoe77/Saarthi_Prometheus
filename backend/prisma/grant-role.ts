import { PrismaClient, Role } from '@prisma/client';

/**
 * Operator-only CLI: `npm run grant:role -- <email> <ROLE>`.
 *
 * This is the ONLY path that can grant PLATFORM_ADMIN. The HTTP admin API
 * deliberately refuses that role, so the bootstrap admin and any later
 * privileged grant go through a server-side process an operator runs, not an
 * authenticated request.
 *
 * Usage:
 *   npm run grant:role -- admin@example.com PLATFORM_ADMIN
 *   npm run grant:role -- trader@example.com EXPERT_TRADER
 *   npm run grant:role -- lp@example.com LIQUIDITY_PROVIDER
 *
 * Idempotent: re-running for a role the user already holds is a no-op.
 * Exit code 0 on success, 1 on any error - callers can branch on it.
 */
async function main(): Promise<void> {
  const [emailArg, roleArg] = process.argv.slice(2);

  if (!emailArg || !roleArg) {
    console.error('Usage: npm run grant:role -- <email> <ROLE>');
    console.error(`Roles: ${Object.values(Role).join(', ')}`);
    process.exit(1);
  }

  const role = Object.values(Role).find((value) => value === roleArg);
  if (!role) {
    console.error(`Unknown role "${roleArg}". Valid roles: ${Object.values(Role).join(', ')}`);
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const user = await prisma.user.findUnique({ where: { email: emailArg.toLowerCase() } });
    if (!user) {
      console.error(`No user with email ${emailArg.toLowerCase()}.`);
      process.exit(1);
    }

    const existing = await prisma.userRole.findUnique({
      where: { userId_role: { userId: user.id, role } },
    });

    if (existing) {
      console.log(`${user.email} already holds ${role}. Nothing to do.`);
      return;
    }

    await prisma.userRole.create({
      data: { userId: user.id, role, grantedBy: user.id },
    });

    console.log(`Granted ${role} to ${user.email} (userId=${user.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
