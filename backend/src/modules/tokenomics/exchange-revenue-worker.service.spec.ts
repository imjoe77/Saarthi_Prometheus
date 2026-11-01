import { HttpStatus } from '@nestjs/common';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { AppConfig } from '../../config/config.module';
import { ExchangeRevenueWorkerService } from './exchange-revenue-worker.service';
import type { ExchangeRevenueService } from './exchange-revenue.service';

/**
 * The clock, and nothing more.
 *
 * Durability is `ExchangeRevenueService`'s job and is covered there; what belongs
 * to this class is the handful of ways a `setInterval` can go wrong: it ticks
 * while the previous pass is still waiting for a chain receipt, it keeps the
 * process alive on shutdown, or it is switched on in a test run and starts
 * burning treasury between assertions.
 */
describe('ExchangeRevenueWorkerService (unit)', () => {
  const runPassMock = jest.fn();
  const serviceMock = { runPass: runPassMock };

  const worker = (enabled: boolean, intervalMs = 15_000): ExchangeRevenueWorkerService =>
    new ExchangeRevenueWorkerService(
      {
        tokenomics: { exchangeRevenueWorkerEnabled: enabled, exchangeRevenueWorkerIntervalMs: intervalMs },
      } as unknown as AppConfig,
      serviceMock as unknown as ExchangeRevenueService,
    );

  const tick = async (): Promise<void> => {
    // The async variant, because a pass is a promise. Advancing the clock
    // synchronously fires the timer but never lets the previous pass resolve, so
    // every later tick would be blamed on the re-entrancy flag rather than on the
    // schedule being tested.
    await jest.advanceTimersByTimeAsync(15_000);
  };

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not tick at all when switched off', async () => {
    // The default under NODE_ENV=test. A background pass during a test run would
    // consume the events the assertions are about, which reads as a flaky suite
    // rather than as the design working.
    const w = worker(false);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    w.onApplicationBootstrap();
    await tick();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(runPassMock).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('runs one pass per interval when switched on', async () => {
    const w = worker(true);
    runPassMock.mockResolvedValue(0);

    w.onApplicationBootstrap();
    await tick();
    await tick();

    expect(runPassMock).toHaveBeenCalledTimes(2);
    w.onModuleDestroy();
  });

  it('never holds the process open for a pass that has nothing to do', () => {
    // `unref` is the difference between a Nest shutdown that finishes and one
    // that waits out the interval. Easy to drop by accident, so it is asserted.
    const unref = jest.fn();
    const spy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    worker(true).onApplicationBootstrap();

    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('stops ticking once the module is torn down', async () => {
    const w = worker(true);
    runPassMock.mockResolvedValue(0);
    w.onApplicationBootstrap();
    w.onModuleDestroy();
    await tick();

    expect(runPassMock).not.toHaveBeenCalled();
  });

  it('will not stack a second pass on top of one still waiting for a receipt', async () => {
    // The reason the flag exists: a burn can sit in flight for a minute, and at a
    // fifteen-second interval four passes would be chasing the same queue. The
    // service's guarded claim is the cross-process answer; this is the cheap
    // in-process one that keeps the logs honest.
    let release: () => void = () => {};
    runPassMock.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        }),
    );

    const w = worker(true);
    w.onApplicationBootstrap();

    const first = w.runOnce();
    await tick();
    const secondWhileBusy = await w.runOnce();
    expect(secondWhileBusy).toBe(0);
    // The timer fired while the first pass was still in flight and was skipped,
    // so the only passes that ran are the one under test and the one after it.
    expect(runPassMock).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBe(1);

    // Released, and the next call is free to run.
    runPassMock.mockResolvedValue(3);
    expect(await w.runOnce()).toBe(3);

    w.onModuleDestroy();
  });

  it('reports zero rather than throwing when the queue read fails', async () => {
    // A thrown error from a Nest bootstrap timer is an unhandled rejection. The
    // rows still say PENDING, so the correct behaviour is to log and wait.
    runPassMock.mockRejectedValue(
      new DomainException(ERROR_CODES.INTERNAL_ERROR, 'database unreachable', HttpStatus.INTERNAL_SERVER_ERROR),
    );

    expect(await worker(true).runOnce()).toBe(0);
  });

  it('logs nothing for an empty pass', async () => {
    // The queue is empty for all of a normal day. A log line per tick would make
    // the file useless, so the pass only speaks when it moved something.
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    runPassMock.mockResolvedValue(0);

    expect(await worker(true).runOnce()).toBe(0);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
