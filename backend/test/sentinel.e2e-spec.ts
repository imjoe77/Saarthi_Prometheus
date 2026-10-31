import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { FakeMarketDataProvider } from '../src/modules/live-data/providers/fake-market-data-provider';
import { FakeVoiceCallProvider } from '../src/modules/sentinel/providers/fake-voice-call-provider';
import { SentinelCallerService } from '../src/modules/sentinel/sentinel-caller.service';
import { SentinelMonitorService } from '../src/modules/sentinel/sentinel-monitor.service';
import { mintToken } from './token-minting';

interface ErrorPayload {
  code: string;
  message: string;
  requestId: string;
}

interface AlertPayload {
  alertId: string;
  symbol: string;
  displayName: string;
  targetPrice: string;
  condition: string;
  status: string;
  voiceEnabled: boolean;
  observedPrice: string | null;
  observedStale: boolean | null;
  callSkipReason: string | null;
  cancelledAt: string | null;
  call: { callId: string; status: string; attempts: number; failReason: string | null } | null;
}

interface StatusPayload {
  voiceProvider: string;
  activeAlerts: number;
  completedCalls: number;
  failedCalls: number;
  callsUsedTodayUtc: number;
  callGate: string;
  voiceSettings: { phoneMasked: string | null; phoneVerified: boolean; consented: boolean };
}

interface AlertPagePayload {
  items: AlertPayload[];
  total: number;
  page: number;
}

/**
 * MODULE 14 - Sentinel end to end, with two standing rules kept absolutely:
 *
 *  1. MARKET DATA IS DETERMINISTIC. The deterministic fake provider is the
 *     selected feed; a test stages the exact quote a case needs and asserts
 *     arithmetic on it. Crypto instruments are used precisely so the session
 *     rule is always OPEN, keeping assertions independent of the wall clock.
 *
 *  2. NO REAL CALLS, EVER. `SENTINEL_VOICE_PROVIDER=fake` is set before boot,
 *     the fake provider only records `dial` inputs, and follow-up outcomes
 *     arrive through the same webhook path a real signed provider callback
 *     would take - with the fake's fixture signature, never real credentials.
 *
 * The worker is off: the run-once route and the pass services are driven
 * directly, so a background timer cannot move state between a request and the
 * assertion about it.
 */
describe('Sentinel (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeMarket: FakeMarketDataProvider;
  let fakeVoice: FakeVoiceCallProvider;
  let monitor: SentinelMonitorService;
  let caller: SentinelCallerService;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    // All of these must be set before `createApp()`: the providers are bound
    // while the module graph is built, and the worker reads its switch during
    // construction.
    process.env['MARKET_DATA_PROVIDER'] = 'fake';
    process.env['SENTINEL_VOICE_PROVIDER'] = 'fake';
    process.env['SENTINEL_WORKER_ENABLED'] = 'false';

    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    fakeMarket = app.get(FakeMarketDataProvider);
    fakeVoice = app.get(FakeVoiceCallProvider);
    monitor = app.get(SentinelMonitorService);
    caller = app.get(SentinelCallerService);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.sentinelVoiceCall.deleteMany({ where: { alert: { ownerId: { in: createdUserIds } } } });
      await prisma.sentinelAlert.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.sentinelVoiceSetting.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
    delete process.env['MARKET_DATA_PROVIDER'];
    delete process.env['SENTINEL_VOICE_PROVIDER'];
    delete process.env['SENTINEL_WORKER_ENABLED'];
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const email = `${label}-${randomUUID()}@sentinel.test`;
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id as string);

    return { token, userId: response.body.id as string };
  }

  /** Drives the full consent pipeline: number -> code -> verify -> consent. */
  async function giveVoicePermission(token: string): Promise<void> {
    await http()
      .patch('/api/sentinel/voice/phone')
      .set(bearer(token))
      .send({ phone: '+1415555' + String(Math.floor(Math.random() * 9000) + 1000) })
      .expect(200);

    const issued = await http().post('/api/sentinel/voice/phone/verification').set(bearer(token)).expect(200);
    expect(issued.body.code).toEqual(expect.any(String));

    await http()
      .post('/api/sentinel/voice/phone/verification/confirm')
      .set(bearer(token))
      .send({ code: issued.body.code as string })
      .expect(200);

    await http().post('/api/sentinel/voice/consent').set(bearer(token)).expect(200);
  }

  async function createAlert(
    token: string,
    body: Record<string, unknown>,
    expectedStatus: 201 | 400 = 201,
  ): Promise<AlertPayload> {
    const response = await http().post('/api/sentinel/alerts').set(bearer(token)).send(body).expect(expectedStatus);
    return response.body as AlertPayload;
  }

  /** Calls the fake webhook door the way the provider would. */
  function fakeWebhook(callId: string, outcome: string, signature = 'fixture') {
    return http()
      .post('/api/sentinel/voice/webhook')
      .type('form')
      .send(`fw-call-id=${callId}&fw-outcome=${outcome}&fw-signature=${signature}`);
  }

  function expectDomainError(
    response: request.Response,
    code: DomainException['code'],
    status: HttpStatus,
  ): ErrorPayload {
    const body = response.body as ErrorPayload;
    expect(body.code).toBe(code);
    expect(response.status).toBe(status);
    expect(typeof body.message).toBe('string');
    return body;
  }

  /** The quiet-hours window that certainly covers this instant, whatever the clock. */
  function coveringQuietHours(): { quietHoursStartUtc: number; quietHoursEndUtc: number } {
    const now = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    return { quietHoursStartUtc: now, quietHoursEndUtc: (now + 1439) % 1440 };
  }

  // ---------------------------------------------------------------------------
  // Voice gates
  // ---------------------------------------------------------------------------

  it('refuses a voice-enabled alert until the phone is verified and consented', async () => {
    const { token } = await createUser('gated');

    const refused = await createAlert(
      token,
      { symbol: 'SOL/USD', displayName: 'Gate Test', targetPrice: '1.00', condition: 'GREATER_THAN_OR_EQUAL', voiceEnabled: true },
      400,
    );

    expect((refused as unknown as ErrorPayload).message).toContain('VOICE_OFF');

    const alerts = (await http().get('/api/sentinel/alerts').set(bearer(token)).expect(200)).body as AlertPagePayload;
    expect(alerts.total).toBe(0);
  });

  it('lets an alert-only (voice disabled) alert exist without any phone', async () => {
    const { token } = await createUser('voiceless');

    const alert = await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'Alert Only',
      targetPrice: '1.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: false,
    });

    expect(alert.voiceEnabled).toBe(false);
    expect(alert.status).toBe('ACTIVE');
  });

  it('masks the stored phone number on every response', async () => {
    const { token } = await createUser('masking');
    await http().patch('/api/sentinel/voice/phone').set(bearer(token)).send({ phone: '+14155552671' }).expect(200);

    const settings = (await http().get('/api/sentinel/voice/settings').set(bearer(token)).expect(200)).body;
    // The mask keeps only the country digit and the last four, ever.
    expect(String(settings.phoneMasked)).not.toContain('415555');
    expect(String(settings.phoneMasked)).toContain('••••');
  });

  it('burns verification attempts and refuses the code after the budget', async () => {
    const { token } = await createUser('attempts');
    await http().patch('/api/sentinel/voice/phone').set(bearer(token)).send({ phone: '+14155559999' }).expect(200);

    const issued = (await http().post('/api/sentinel/voice/phone/verification').set(bearer(token)).expect(200)).body;
    const wrongCode = issued.code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await http()
        .post('/api/sentinel/voice/phone/verification/confirm')
        .set(bearer(token))
        .send({ code: wrongCode })
        .expect(400);
      expect(wrong.body.code).toBe('VALIDATION_FAILED');
    }

    // Even the RIGHT code is rejected now: the budget is spent and burned.
    const right = await http()
      .post('/api/sentinel/voice/phone/verification/confirm')
      .set(bearer(token))
      .send({ code: issued.code as string })
      .expect(400);
    expect(right.body.message).toContain('pending');
  });

  it('refuses consent before the number is verified', async () => {
    const { token } = await createUser('noconsent');
    await http().patch('/api/sentinel/voice/phone').set(bearer(token)).send({ phone: '+14155557777' }).expect(200);

    expectDomainError(
      await http().post('/api/sentinel/voice/consent').set(bearer(token)).expect(400),
      'VALIDATION_FAILED',
      HttpStatus.BAD_REQUEST,
    );
  });

  // ---------------------------------------------------------------------------
  // Alert CRUD and ownership
  // ---------------------------------------------------------------------------

  it('validates the symbol against the instrument catalogue', async () => {
    const { token } = await createUser('symbols');

    expectDomainError(
      await http()
        .post('/api/sentinel/alerts')
        .set(bearer(token))
        .send({ symbol: 'RELIANCE', displayName: 'nope', targetPrice: '85.20', condition: 'GREATER_THAN_OR_EQUAL', voiceEnabled: false })
        .expect(404),
      'NOT_FOUND',
      HttpStatus.NOT_FOUND,
    );
  });

  it('keeps another user from reading, editing or cancelling an alert that is not theirs', async () => {
    const owner = await createUser('owner');
    const stranger = await createUser('stranger');
    await giveVoicePermission(owner.token);

    const alert = await createAlert(owner.token, {
      symbol: 'SOL/USD',
      displayName: 'Owned',
      targetPrice: '9.99',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    const read = await http().get(`/api/sentinel/alerts/${alert.alertId}`).set(bearer(stranger.token)).expect(404);
    expectDomainError(read, 'NOT_FOUND', HttpStatus.NOT_FOUND);

    await http().delete(`/api/sentinel/alerts/${alert.alertId}`).set(bearer(stranger.token)).send({ reason: 'SABOTAGE' }).expect(404);

    const stillThere = await prisma.sentinelAlert.findUnique({ where: { alertId: alert.alertId } });
    expect(stillThere?.status).toBe('ACTIVE');

    await http()
      .patch(`/api/sentinel/alerts/${alert.alertId}`)
      .set(bearer(stranger.token))
      .send({ targetPrice: '0.01' })
      .expect(404);
  });

  it('persists a successful edit of an ACTIVE alert', async () => {
    const { token } = await createUser('edit');
    const alert = await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'Before',
      targetPrice: '50.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: false,
    });

    const edited = (await http()
      .patch(`/api/sentinel/alerts/${alert.alertId}`)
      .set(bearer(token))
      .send({ targetPrice: '85.20', condition: 'LESS_THAN_OR_EQUAL', displayName: 'After', voiceEnabled: false })
      .expect(200)).body as AlertPayload;

    // Prisma decimial.js normalises on the way out: `85.20` is stored exactly
    // and serialised as `85.2`. The value, not its trailing zeros, is the contract.
    expect(edited.targetPrice).toBe('85.2');
    expect(edited.condition).toBe('LESS_THAN_OR_EQUAL');
    expect(edited.displayName).toBe('After');

    // ...and the row, not just the response, carries the new meaning.
    const stored = (await prisma.sentinelAlert.findUnique({ where: { alertId: alert.alertId } }))!;
    expect(stored.targetPrice.toString()).toBe('85.2');
    expect(stored.condition).toBe('LESS_THAN_OR_EQUAL');
    expect(stored.displayName).toBe('After');

    // An empty body is an idempotent read, not a rejection and not a write.
    const unchanged = (await http().patch(`/api/sentinel/alerts/${alert.alertId}`).set(bearer(token)).send({}).expect(200))
      .body as AlertPayload;
    expect(unchanged.targetPrice).toBe('85.2');
  });

  it('refuses to edit a triggered alert and refuses cancelling it', async () => {
    const { token } = await createUser('lifecycle');
    await giveVoicePermission(token);
    const alert = await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'Editing',
      targetPrice: '9.99',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    // Trigger it so it leaves ACTIVE.
    fakeMarket.seedQuote('SOL/USD', '123.45', { asOf: new Date().toISOString() });
    await monitor.runOnce(new Date());
    fakeMarket.clearAll('SOL/USD');

    const edited = await http()
      .patch(`/api/sentinel/alerts/${alert.alertId}`)
      .set(bearer(token))
      .send({ targetPrice: '0.01' })
      .expect(409);
    expectDomainError(edited, 'CONFLICT', HttpStatus.CONFLICT);

    // Cancelling IS still allowed while a call is pending (the owner may stop
    // it), and it must also strangle the queued call job.
    const cancelled = (await http()
      .delete(`/api/sentinel/alerts/${alert.alertId}`)
      .set(bearer(token))
      .send({ reason: 'OWNER_REQUEST' })
      .expect(200)).body as AlertPayload;
    expect(cancelled.status).toBe('CANCELLED');

    const strangled = (await prisma.sentinelVoiceCall.findMany({ where: { alertId: alert.alertId } }))[0];
    expect(strangled?.status).toBe('FAILED');
    expect(strangled?.failReason).toBe('ALERT_CANCELLED');

    // ...and a cancelled alert can no longer be edited either.
    await http()
      .patch(`/api/sentinel/alerts/${alert.alertId}`)
      .set(bearer(token))
      .send({ targetPrice: '0.01' })
      .expect(409);
  });

  // ---------------------------------------------------------------------------
  // Trigger, call and outcomes
  // ---------------------------------------------------------------------------

  it('triggers a priced alert, queues exactly one call and the fake provider receives it', async () => {
    const { token, userId } = await createUser('trigger');
    await giveVoicePermission(token);
    const alert = await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'My Solana Watch',
      targetPrice: '9.99',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    // A price strictly ABOVE the target, fresh and in-session (crypto: always open).
    fakeMarket.seedQuote('SOL/USD', '123.45', { asOf: new Date().toISOString() });

    const pass = await monitor.runOnce(new Date());
    fakeMarket.clearAll('SOL/USD');

    expect(pass.triggered).toBe(1);
    expect(pass.callsQueued).toBe(1);
    expect(fakeVoice.receivedCalls).toHaveLength(0); // not yet - the caller pass makes the dial

    // A REPEATED POLL MUST NOT DOUBLE-TRIGGER.
    const secondPass = await monitor.runOnce(new Date());
    expect(secondPass.triggered).toBe(0);

    const stored = (await prisma.sentinelAlert.findUnique({
      where: { alertId: alert.alertId },
      include: { calls: true },
    }))!;
    expect(stored.status).toBe('CALL_QUEUED');
    expect(stored.triggeredAt).not.toBeNull();
    expect(stored.calls).toHaveLength(1);
    // The message carries the real values, no placeholders, and the disclaimer.
    expect(stored.calls[0]?.spokenText).toContain('Sentinel from Prometheus');
    expect(stored.calls[0]?.spokenText).toContain('My Solana Watch');
    expect(stored.calls[0]?.spokenText).toContain('9 dollars');
    expect(stored.calls[0]?.spokenText).toContain('123 dollars');
    expect(stored.calls[0]?.spokenText).toContain('No trade has been placed');

    // The caller pass dials exactly once - scoped to this user, so jobs other
    // tests leave queued cannot pollute the count.
    const callerStats = await caller.runOnce(new Date(), userId);
    expect(callerStats.initiated).toBe(1);
    expect(fakeVoice.receivedCalls).toHaveLength(1);
    expect(fakeVoice.receivedCalls[0]?.spokenText).toContain('My Solana Watch');
    // The observable record masks the number: the full number never leaks.
    expect(fakeVoice.receivedCalls[0]?.toMasked).not.toContain('+1415555');

    // The callback of a completed call settles both rows through the webhook
    // door. The provider addresses calls by ITS id, not our surrogate id, so
    // the fixture webhook carries the row's stored provider reference.
    const dialled = (await prisma.sentinelVoiceCall.findUniqueOrThrow({ where: { alertId: alert.alertId } }))!;
    expect(dialled.status).toBe('INITIATED');
    expect(dialled.providerCallId).toMatch(/^fake-call-/);
    await fakeWebhook(dialled.providerCallId as string, 'COMPLETED').expect(204);

    const finished = (await prisma.sentinelVoiceCall.findUniqueOrThrow({ where: { callId: dialled.callId } }))!;
    expect(finished.status).toBe('COMPLETED');
    const settledAlert = await prisma.sentinelAlert.findUnique({ where: { alertId: alert.alertId } });
    expect(settledAlert?.status).toBe('CALL_COMPLETED');

    // Duplicate webhook: idempotent, no error, no further change.
    await fakeWebhook(dialled.providerCallId as string, 'COMPLETED').expect(204);
    const again = (await prisma.sentinelVoiceCall.findUniqueOrThrow({ where: { callId: dialled.callId } }))!;
    expect(again.completedAt).toEqual(finished.completedAt);

    // Forged signature is refused wholesale.
    await fakeWebhook(dialled.providerCallId as string, 'COMPLETED', 'forged').expect(403);
  });

  it('records exactly one call no matter how many times the market is polled', async () => {
    const { token, userId } = await createUser('idempotent');
    await giveVoicePermission(token);
    await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'Once',
      targetPrice: '1.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    fakeMarket.seedQuote('SOL/USD', '456.78', { asOf: new Date().toISOString() });
    for (let pass = 0; pass < 3; pass += 1) {
      await monitor.runOnce(new Date());
    }
    fakeMarket.clearAll('SOL/USD');

    const queued = await prisma.sentinelVoiceCall.findMany({ where: { alert: { ownerId: userId } } });
    expect(queued).toHaveLength(1);
  });

  it('never triggers on a stale quote or a missing one', async () => {
    const { token, userId } = await createUser('stale');
    await giveVoicePermission(token);
    const alert = await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'Stale Test',
      targetPrice: '1.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    // A price far over the target but stamped in the deep past: stale.
    fakeMarket.seedQuote('SOL/USD', '999.99', { asOf: '2020-01-01T00:00:00.000Z' });
    const pass = await monitor.runOnce(new Date());
    fakeMarket.clearAll('SOL/USD');

    expect(pass.triggered).toBe(0);

    const stored = (await prisma.sentinelAlert.findUnique({ where: { alertId: alert.alertId } }))!;
    expect(stored.status).toBe('ACTIVE'); // stale data never turns into a trigger
    expect(stored.observedPrice).not.toBeNull(); // the stale observation is recorded
    expect(stored.observedStale).toBe(true);

    // Re-reading the same stale quote keeps the alert ACTIVE and never dials.
    fakeMarket.seedQuote('SOL/USD', '999.99', { asOf: '2020-01-01T00:00:00.000Z' });
    const again = await monitor.runOnce(new Date());
    fakeMarket.clearAll('SOL/USD');
    expect(again.triggered).toBe(0);
    expect(again.callsQueued).toBe(0);

    // Suite hygiene: the monitor pass is global by design (the worker sweeps
    // every owner's book), so an alert this test leaves ACTIVE would be
    // triggered by the next test's staged quote. The assertions above are
    // finished; retiring the alert keeps the following cases hermetic.
    await http().delete(`/api/sentinel/alerts/${alert.alertId}`).set(bearer(token)).send({ reason: 'TEST_CLEANUP' }).expect(200);
  });

  it('expires an alert at its expiry instant and never triggers it', async () => {
    const { token, userId } = await createUser('expires');
    await giveVoicePermission(token);

    // Creating an already-expired alert is refused outright.
    await createAlert(
      token,
      {
        symbol: 'SOL/USD',
        displayName: 'Too Late',
        targetPrice: '1.00',
        condition: 'GREATER_THAN_OR_EQUAL',
        voiceEnabled: false,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      400,
    );

    // A future expiry that passes while ACTIVE is swept into EXPIRED.
    const created = await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'Expiring',
      targetPrice: '1.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: false,
      expiresAt: new Date(Date.now() + 1500).toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 1600));
    fakeMarket.seedQuote('SOL/USD', '456.78', { asOf: new Date().toISOString() });
    const pass = await monitor.runOnce(new Date());
    fakeMarket.clearAll('SOL/USD');

    expect(pass.expired).toBe(1);
    expect(pass.triggered).toBe(0);

    const swept = (await prisma.sentinelAlert.findUnique({ where: { alertId: created.alertId } }))!;
    expect(swept.status).toBe('EXPIRED');
    expect(swept.triggeredAt).toBeNull();
    expect(swept.expiredAt).not.toBeNull();
  });

  it('blocks calls that would break quiet hours, and never revives a finished alert', async () => {
    const { token, userId } = await createUser('quiet');
    await giveVoicePermission(token);
    await createAlert(token, {
      symbol: 'BTC/USD',
      displayName: 'Quiet Test',
      targetPrice: '1.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    await http().patch('/api/sentinel/voice/quiet-hours').set(bearer(token)).send(coveringQuietHours()).expect(200);

    fakeMarket.seedQuote('BTC/USD', '999999.00', { asOf: new Date().toISOString() });
    const pass = await monitor.runOnce(new Date());
    fakeMarket.clearAll('BTC/USD');

    expect(pass.triggered).toBe(1);
    expect(pass.callsQueued).toBe(0);
    expect(pass.gated).toBe(1);

    const alert = (await prisma.sentinelAlert.findFirst({ where: { ownerId: userId } }))!;
    expect(alert.status).toBe('TRIGGERED');
    expect(alert.callSkipReason).toBe('QUIET_HOURS');

    // Clearing the window does not revive a finished alert back into ACTIVE.
    await http().patch('/api/sentinel/voice/quiet-hours').set(bearer(token)).send({ quietHoursStartUtc: null, quietHoursEndUtc: null }).expect(200);

    fakeMarket.seedQuote('BTC/USD', '999999.00', { asOf: new Date().toISOString() });
    const second = await monitor.runOnce(new Date());
    fakeMarket.clearAll('BTC/USD');
    expect(second.triggered).toBe(0);

    const settled = (await prisma.sentinelVoiceCall.findMany({ where: { alert: { ownerId: userId } } }));
    expect(settled).toHaveLength(0); // gated alert: no call job, ever
  });

  it('keeps withdrawn consent from allowing new calls, without touching alerts', async () => {
    const { token, userId } = await createUser('withdrawn');
    await giveVoicePermission(token);

    await createAlert(token, {
      symbol: 'BTC/USD',
      displayName: 'Consent Test',
      targetPrice: '1.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    // Withdraw consent, but leave the alert ACTIVE.
    await http().delete('/api/sentinel/voice/consent').set(bearer(token)).expect(200);

    fakeMarket.seedQuote('BTC/USD', '999999.00', { asOf: new Date().toISOString() });
    const pass = await monitor.runOnce(new Date());
    fakeMarket.clearAll('BTC/USD');

    expect(pass.callsQueued).toBe(0);

    const alert = (await prisma.sentinelAlert.findFirst({ where: { ownerId: userId } }))!;
    expect(alert.status).toBe('TRIGGERED');
    expect(alert.callSkipReason).toBe('CONSENT_MISSING');
  });

  it('removes a cancelled alert from evaluation forever', async () => {
    const { token } = await createUser('cancelled');
    const alert = await createAlert(token, {
      symbol: 'ETH/USD',
      displayName: 'Cancelled',
      targetPrice: '1.00',
      condition: 'LESS_THAN_OR_EQUAL',
      voiceEnabled: false,
    });

    const cancelled = (await http().delete(`/api/sentinel/alerts/${alert.alertId}`).set(bearer(token)).send({ reason: 'OWNER_REQUEST' }).expect(200)).body as AlertPayload;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).not.toBeNull();

    fakeMarket.seedQuote('ETH/USD', '0.50', { asOf: new Date().toISOString() });
    const pass = await monitor.runOnce(new Date());
    fakeMarket.clearAll('ETH/USD');

    expect(pass.triggered).toBe(0); // a cancelled alert is never evaluated again
    const stored = (await prisma.sentinelAlert.findUnique({ where: { alertId: alert.alertId } }))!;
    expect(stored.status).toBe('CANCELLED');
  });

  it('reports status and call history through the API', async () => {
    const { token, userId } = await createUser('statusview');
    await giveVoicePermission(token);
    await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: 'Status Watch',
      targetPrice: '1.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    fakeMarket.seedQuote('SOL/USD', '789.00', { asOf: new Date().toISOString() });
    await monitor.runOnce(new Date());
    fakeMarket.clearAll('SOL/USD');
    await caller.runOnce(new Date(), userId);

    const status = (await http().get('/api/sentinel/status').set(bearer(token)).expect(200)).body as StatusPayload;
    expect(status.voiceProvider).toBe('fake');
    expect(status.activeAlerts).toBe(0);
    expect(status.callsUsedTodayUtc).toBe(1); // initiated today, whatever its outcome
    expect(status.voiceSettings.phoneVerified).toBe(true);

    const history = (await http().get('/api/sentinel/calls').set(bearer(token)).expect(200)).body as {
      items: Array<{ call: { status: string }; displayName: string; symbol: string }>;
    };
    expect(history.items).toHaveLength(1);
    expect(history.items[0]?.symbol).toBe('SOL/USD');
    expect(history.items[0]?.displayName).toBe('Status Watch');
    expect(['INITIATED', 'COMPLETED', 'FAILED']).toContain(history.items[0]?.call.status);
  });

  // ---------------------------------------------------------------------------
  // In-app simulated call (the fake provider's phone, rendered in the app)
  //
  // These cases cover the ring -> answer/decline surface added for local
  // development, where no PSTN call exists to ring. The row still travels the
  // real lifecycle: the monitor queues it, the caller pass "dials" through the
  // fake provider, and the outcome lands through guarded transitions identical
  // to the webhook's - so a simulated answer and a provider callback write
  // history the same way.
  // ---------------------------------------------------------------------------

  interface LiveCallPayload {
    callId: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    ringing: boolean;
    spokenText: string;
    simulated: boolean;
    completedAt: string | null;
    failReason: string | null;
    nextAttemptAt: string | null;
    alert: {
      alertId: string;
      symbol: string;
      displayName: string;
      quoteCurrency: string;
      targetPrice: string;
      condition: string;
      observedPrice: string | null;
      status: string;
    };
  }

  /**
   * Drives one alert to the ringing state: consent, create, quote, monitor
   * pass, caller pass. Scoped passes keep other suites' queued jobs out of the
   * dial count. Returns the token and the observed `alertId`.
   */
  async function armRingingCall(label: string): Promise<{ token: string; userId: string; alertId: string }> {
    const { token, userId } = await createUser(label);
    await giveVoicePermission(token);

    const alert = await createAlert(token, {
      symbol: 'SOL/USD',
      displayName: `${label} Watch`,
      targetPrice: '10.00',
      condition: 'GREATER_THAN_OR_EQUAL',
      voiceEnabled: true,
    });

    fakeMarket.seedQuote('SOL/USD', '99.99', { asOf: new Date().toISOString() });
    await monitor.runOnce(new Date());
    fakeMarket.clearAll('SOL/USD');

    const dialled = await caller.runOnce(new Date(), userId);
    expect(dialled.initiated).toBe(1);

    return { token, userId, alertId: alert.alertId };
  }

  /** Fetches the caller's live call, asserting the common shape once. */
  async function getLive(token: string): Promise<LiveCallPayload | null> {
    const response = await http().get('/api/sentinel/voice/live').set(bearer(token)).expect(200);
    // The route answers an explicit `{ call: ... }` envelope (a bare null would
    // serialize to an empty body), so unwrap before asserting.
    return (response.body as { call: LiveCallPayload | null }).call;
  }

  describe('in-app simulated call', () => {
    it('surfaces a ringing call with the alert facts and the exact spoken text', async () => {
      const { token, alertId } = await armRingingCall('ringing');

      const live = await getLive(token);
      expect(live).not.toBeNull();
      expect(live!.ringing).toBe(true);
      expect(live!.status).toBe('INITIATED');
      expect(live!.simulated).toBe(true); // never claims a telephone call
      expect(live!.completedAt).toBeNull();

      // The caller-ID card's facts come from the alert, not invented values.
      expect(live!.alert.alertId).toBe(alertId);
      expect(live!.alert.symbol).toBe('SOL/USD');
      expect(live!.alert.displayName).toBe('ringing Watch');
      expect(live!.alert.targetPrice).toBe('10');
      expect(live!.alert.condition).toBe('GREATER_THAN_OR_EQUAL');
      expect(live!.alert.observedPrice).toBe('99.99');

      // The text to speak is the monitor's own composition, verbatim.
      expect(live!.spokenText).toContain('Sentinel from Prometheus');
      expect(live!.spokenText).toContain('ringing Watch');
      expect(live!.spokenText).toContain('No trade has been placed');
    });

    it('settles an answered call as COMPLETED and moves the alert to CALL_COMPLETED', async () => {
      const { token, userId, alertId } = await armRingingCall('answer');

      const before = (await getLive(token))!;
      const answered = (await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(token))
        .send({ callId: before.callId, action: 'ANSWERED' })
        .expect(200)).body as LiveCallPayload;

      expect(answered.status).toBe('COMPLETED');
      expect(answered.ringing).toBe(false);
      expect(answered.completedAt).not.toBeNull();
      // A settled call is never retried, so its schedule is cleared — history
      // must not advertise a "retry at" that cannot happen.
      expect(answered.nextAttemptAt).toBeNull();

      const alert = (await prisma.sentinelAlert.findUnique({ where: { alertId } }))!;
      expect(alert.status).toBe('CALL_COMPLETED');

      // Once settled, the phone stops offering it: nothing left to answer.
      expect(await getLive(token)).toBeNull();

      // The outcome is in call history, not just in the overlay's memory.
      const history = (await http().get('/api/sentinel/calls').set(bearer(token)).expect(200)).body as {
        items: Array<{ call: { status: string; completedAt: string | null } }>;
      };
      expect(history.items[0]?.call.status).toBe('COMPLETED');
      expect(history.items[0]?.call.completedAt).not.toBeNull();

      // No trade anywhere: Sentinel has no order path, and answering must not
      // create one. The alert's terminal state is the call's, not a position.
      const orders = await prisma.sentinelVoiceCall.count({ where: { alert: { ownerId: userId } } });
      expect(orders).toBe(1); // exactly one call row, no side effects
    });

    it('treats a duplicate answer as a no-op instead of double-settling', async () => {
      const { token, alertId } = await armRingingCall('dupanswer');

      const live = (await getLive(token))!;
      const first = (await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(token))
        .send({ callId: live.callId, action: 'ANSWERED' })
        .expect(200)).body as LiveCallPayload;

      // A replayed answer (double tap, retried request) reports the same row
      // rather than writing a second completion or a second timestamp.
      const second = (await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(token))
        .send({ callId: live.callId, action: 'ANSWERED' })
        .expect(200)).body as LiveCallPayload;

      expect(second.status).toBe('COMPLETED');
      expect(second.completedAt).toBe(first.completedAt);

      const rows = await prisma.sentinelVoiceCall.count({ where: { alertId } });
      expect(rows).toBe(1);

      const alert = (await prisma.sentinelAlert.findUnique({ where: { alertId } }))!;
      expect(alert.status).toBe('CALL_COMPLETED');
    });

    it('schedules a retry when the user declines, exactly as a no-answer would', async () => {
      const { token, alertId } = await armRingingCall('decline');

      const live = (await getLive(token))!;
      const declined = (await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(token))
        .send({ callId: live.callId, action: 'DECLINED' })
        .expect(200)).body as LiveCallPayload;

      // Decline is a no-answer: the attempt is burnt and the job re-queues
      // with backoff rather than being called "answered". The dial consumed
      // attempt 1 and this decline consumes attempt 2.
      expect(declined.status).toBe('QUEUED');
      expect(declined.attempts).toBe(2);
      expect(declined.failReason).toBe('NO_ANSWER');
      expect(declined.nextAttemptAt).not.toBeNull();

      const alert = (await prisma.sentinelAlert.findUnique({ where: { alertId } }))!;
      expect(alert.status).toBe('CALLING'); // still trying, never CALL_COMPLETED

      // Nothing rings while the job waits for its retry window.
      expect(await getLive(token)).toBeNull();
    });

    it('fails the call for good when a decline exhausts the retry budget', async () => {
      const { token, alertId } = await armRingingCall('declinebudget');

      // Spend the budget first so this decline is the one that runs out. Keyed
      // by the call id: alertId is not unique on the call table (one alert may
      // have carried several jobs across its life).
      const live = (await getLive(token))!;
      await prisma.sentinelVoiceCall.update({
        where: { callId: live.callId },
        data: { attempts: 3, maxAttempts: 3 },
      });

      const declined = (await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(token))
        .send({ callId: live.callId, action: 'DECLINED' })
        .expect(200)).body as LiveCallPayload;

      expect(declined.status).toBe('FAILED');
      expect(declined.failReason).toBe('NO_ANSWER');
      // Terminal: no phantom retry time on a call that will never redial.
      expect(declined.nextAttemptAt).toBeNull();

      const alert = (await prisma.sentinelAlert.findUnique({ where: { alertId } }))!;
      expect(alert.status).toBe('CALL_FAILED');
    });

    it('never lets one owner see or settle another owner’s ringing call', async () => {
      const mine = await armRingingCall('ownerA');
      const stranger = await createUser('ownerB');

      // Ownership: the stranger's live view is empty even though a call rings.
      expect(await getLive(stranger.token)).toBeNull();

      const live = (await getLive(mine.token))!;

      // And a settle attempt against my ring from their token cannot touch it.
      const refused = await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(stranger.token))
        .send({ callId: live.callId, action: 'ANSWERED' })
        .expect(404);
      expectDomainError(refused as request.Response, 'NOT_FOUND', HttpStatus.NOT_FOUND);

      // My ring is untouched: still ringing, still mine.
      const stillMine = (await getLive(mine.token))!;
      expect(stillMine.ringing).toBe(true);
      expect(stillMine.status).toBe('INITIATED');
    });

    it('rejects a malformed action and an unknown call id without side effects', async () => {
      const { token, alertId } = await armRingingCall('validation');
      const live = (await getLive(token))!;

      // An action outside the three allowed verbs is a 400 from the DTO guard.
      const badAction = await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(token))
        .send({ callId: live.callId, action: 'TRADE_SELL' })
        .expect(400);
      expectDomainError(badAction as request.Response, 'VALIDATION_FAILED', HttpStatus.BAD_REQUEST);

      // An id this account does not own is a 404, never a partial write.
      await http()
        .post('/api/sentinel/voice/live')
        .set(bearer(token))
        .send({ callId: randomUUID(), action: 'ANSWERED' })
        .expect(404);

      const alert = (await prisma.sentinelAlert.findUnique({ where: { alertId } }))!;
      expect(alert.status).toBe('CALLING'); // neither attempt disturbed the row
      expect((await getLive(token))!.status).toBe('INITIATED');
    });

    it('requires a session for the live-call surface', async () => {
      await http().get('/api/sentinel/voice/live').expect(401);
      await http().post('/api/sentinel/voice/live').send({ callId: randomUUID(), action: 'ANSWERED' }).expect(401);
    });
  });
});
