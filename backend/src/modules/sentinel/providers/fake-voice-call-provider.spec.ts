import { FakeVoiceCallProvider } from './fake-voice-call-provider';

/**
 * MODULE 14 - the fake provider's ids must be unique the way a real
 * provider's are.
 *
 * THE BUG THIS PINS. `providerCallId` is a UNIQUE column. The first version of
 * this provider minted ids from an in-memory counter, which resets on every
 * process restart: a backend restarted after yesterday's successful call would
 * re-issue `fake-call-000001`, the claim write would violate the unique
 * constraint, and the caller's catch-all would record a spurious
 * PROVIDER_ERROR with attempt 0. Modelling "restart" as "fresh instance" is
 * exactly the regression that escaped: two boots must never collide.
 */

const REQUEST = { to: '+14155550100', spokenText: 'alert text' } as const;

describe('FakeVoiceCallProvider', () => {
  it('mints a fake-prefixed id per dial', async () => {
    const provider = new FakeVoiceCallProvider();
    const result = await provider.dial(REQUEST);

    // The prefix is the provider's own confession on every persisted row.
    expect(result.providerCallId).toMatch(/^fake-call-/);
  });

  it('never repeats an id, even across instances (i.e. across restarts)', async () => {
    const beforeRestart = new FakeVoiceCallProvider();
    const afterRestart = new FakeVoiceCallProvider();

    const issued: string[] = [];
    for (const provider of [beforeRestart, beforeRestart, afterRestart, afterRestart]) {
      issued.push((await provider.dial(REQUEST)).providerCallId);
    }

    // Every dial earned a distinct sid; two boots of the same provider are
    // still two distinct streams. A duplicate here is the restart collision
    // that made real call jobs fail with PROVIDER_ERROR.
    expect(new Set(issued).size).toBe(issued.length);
  });

  it('records every dial for test observation', async () => {
    const provider = new FakeVoiceCallProvider();
    await provider.dial(REQUEST);
    await provider.dial({ ...REQUEST, spokenText: 'second' });

    expect(provider.receivedCalls).toHaveLength(2);
    expect(provider.receivedCalls[1]?.spokenText).toBe('second');
  });

  it('refuses a webhook whose signature is not the fixture', () => {
    const provider = new FakeVoiceCallProvider();

    const refused = provider.verifyAndParseWebhook({
      url: 'http://localhost:3001/api/sentinel/voice/webhook',
      // The signature the suites stage with is 'fixture'; anything else is
      // refused wholesale, exactly as a real provider's check would refuse.
      headers: {},
      params: { 'fw-call-id': 'fake-call-x', 'fw-outcome': 'COMPLETED', 'fw-signature': 'forged' },
    });

    expect(refused).toEqual({ ok: false, reason: 'WEBHOOK_SIGNATURE_INVALID' });
  });
});
