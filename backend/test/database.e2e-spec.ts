import { Test } from '@nestjs/testing';

import { APP_CONFIG, AppConfig, AppConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Proves real database connectivity.
 *
 * Unlike the rest of the Module 00 suite this test requires a live PostgreSQL
 * instance and asserts against it, so it is kept in its own file and excluded
 * from `npm test`. Run it with `npm run test:db`.
 *
 * Start a database first:
 *   docker compose up -d
 *
 * The check is intentionally narrow - Module 00 owns connectivity, not schema.
 * Table creation, foreign keys and migrations belong to Module 01.
 */
describe('Database connectivity', () => {
  let prisma: PrismaService;
  let config: AppConfig;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // AppConfigModule is imported explicitly: @Global() makes it visible to
      // the rest of the application, but an isolated testing module has no
      // other members to inherit that registration from.
      imports: [AppConfigModule, DatabaseModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    config = moduleRef.get<AppConfig>(APP_CONFIG);

    await prisma.onModuleInit();
  });

  afterAll(async () => {
    if (prisma) await prisma.onModuleDestroy();
  });

  it('is configured from the environment', () => {
    expect(config.databaseUrl).toMatch(/^postgres(ql)?:\/\//);
  });

  it('opens a connection pool on initialisation', async () => {
    await expect(prisma.$connect()).resolves.toBeUndefined();
    expect(prisma.isConnected).toBe(true);
  });

  it('answers a connectivity query', async () => {
    const rows = await prisma.$queryRaw<Array<{ answer: number }>>`SELECT 1 AS answer`;

    expect(rows).toEqual([{ answer: 1 }]);
  });

  it('confirms this is PostgreSQL, as the Prisma datasource declares', async () => {
    const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;

    expect(rows[0]?.version).toContain('PostgreSQL');
  });

  it('reports a sub-timeout latency through ping()', async () => {
    const latencyMs = await prisma.ping(config.databaseConnectTimeoutMs);

    expect(typeof latencyMs).toBe('number');
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(latencyMs).toBeLessThan(config.databaseConnectTimeoutMs);
  });

  it('rejects when the database is unreachable rather than hanging', async () => {
    // Port 1 is reserved and refuses connections immediately, so this asserts
    // real failure handling without waiting on a network timeout.
    const unreachable = new PrismaService(
      new AppConfig({
        nodeEnv: 'test',
        databaseUrl: 'postgresql://nobody:nothing@127.0.0.1:1/nothing?connect_timeout=1',
        databaseConnectTimeoutMs: 3000,
      }),
    );

    await expect(unreachable.ping(3000)).rejects.toBeDefined();
    await unreachable.$disconnect();
  }, 15000);
});