import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { HEALTH_SERVICE_NAME, HEALTH_SERVICE_VERSION, HealthService } from './health.service';

function makeAppConfig(): AppConfig {
  return new AppConfig({ nodeEnv: 'test', databaseConnectTimeoutMs: 50 });
}

describe('HealthService', () => {
  let service: HealthService;
  let ping: jest.Mock<Promise<number>, [number]>;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    // Failure-path tests deliberately trigger database errors. The suite
    // asserts on the returned state, not on the log output, so the noise is
    // suppressed here rather than by weakening the assertions.
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    errorSpy.mockRestore();
  });

  beforeEach(async () => {
    ping = jest.fn<Promise<number>, [number]>().mockResolvedValue(1.2345);

    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { ping } satisfies Partial<PrismaService> },
        { provide: APP_CONFIG, useValue: makeAppConfig() },
      ],
    }).compile();

    service = moduleRef.get(HealthService);
  });

  it('reports ok when the database answers', async () => {
    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe(HEALTH_SERVICE_NAME);
    expect(result.version).toBe(HEALTH_SERVICE_VERSION);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: 'database', status: 'up' });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('rounds latency to two decimal places', async () => {
    const result = await service.check(true);

    expect(result.checks[0]?.latencyMs).toBe(1.23);
  });

  it('reports error status but still resolves when the database is down', async () => {
    ping.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:5432'));

    const result = await service.check();

    expect(result.status).toBe('error');
    expect(result.checks[0]).toMatchObject({ name: 'database', status: 'down' });
  });

  it('never leaks the driver error message to an unprivileged caller', async () => {
    ping.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)'));

    const result = await service.check();

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('10.0.0.5');
    expect(serialised).not.toContain('ECONNREFUSED');
  });

  it('keeps a safe reason even in verbose mode without echoing driver detail', async () => {
    ping.mockRejectedValueOnce(new Error('password authentication failed for user "prometheus"'));

    const result = await service.check(true);

    expect(result.environment).toBe('test');
    expect(result.checks[0]?.error).toBe('Database connectivity check failed.');
    expect(JSON.stringify(result)).not.toContain('prometheus"');
  });

  it('handles a non-Error rejection without throwing', async () => {
    ping.mockRejectedValueOnce('a bare string');

    await expect(service.check()).resolves.toMatchObject({ status: 'error' });
  });

  it('returns a parseable timestamp and a non-negative uptime', async () => {
    const result = await service.check();

    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('always answers rather than rejecting - a probe must never surface as a 500', async () => {
    ping.mockRejectedValue(new Error('database gone'));

    await expect(service.check(true)).resolves.toBeDefined();
  });

  it('passes the configured timeout through to the probe', async () => {
    await service.check();

    expect(ping).toHaveBeenCalledWith(50);
  });
});