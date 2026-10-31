import { composeVoiceAlertMessage, speakAmount, speakTime } from './voice-message';

/**
 * MODULE 14 - what Sentinel says out loud, exactly.
 *
 * The clauses that make a automated call safe - self-identification, the
 * no-trade disclaimer, and where to act - are asserted verbatim, because a
 * paraphrase that dropped "No trade has been placed" would promise execution
 * the product never makes. The money wording is asserted to come from the
 * observation's real decimal, never from a rounding the composer invented.
 */
describe('sentinel voice message', () => {
  const base = {
    instrumentName: 'Reliance Industries',
    currency: 'INR',
    targetPrice: '85',
    observedPrice: '85.20',
    condition: 'GREATER_THAN_OR_EQUAL' as const,
    observedAsOf: '2026-10-23T14:32:00.000Z',
  };

  it('composes the exact safety clauses', () => {
    const message = composeVoiceAlertMessage(base);

    expect(message).toContain('This is Sentinel from Prometheus.');
    expect(message).toContain('Your price alert for Reliance Industries has been triggered.');
    expect(message).toContain('The latest reported price is');
    expect(message).toContain('meeting your target of');
    expect(message).toContain('This is an alert only. No trade has been placed.');
    expect(message).toContain('Please review your position in Prometheus.');
  });

  it('uses the observation price verbatim, not a rounded one', () => {
    const message = composeVoiceAlertMessage({ ...base, observedPrice: '85.20' });
    expect(message).toContain('85 rupees and 20 paise');
    expect(message).not.toContain('85 rupees and 21 paise');
  });

  it('speaks the target as the user defined it', () => {
    const message = composeVoiceAlertMessage({ ...base, targetPrice: '85.00' });
    expect(message).toContain('meeting your target of 85 rupees.');
  });

  it('switches units with the currency', () => {
    const message = composeVoiceAlertMessage({
      ...base,
      currency: 'USD',
      observedPrice: '232.50',
      targetPrice: '230',
    });
    expect(message).toContain('232 dollars and 50 cents');
    expect(message).toContain('meeting your target of 230 dollars.');
  });

  it('never truncates a crypto-precision observation', () => {
    const message = composeVoiceAlertMessage({
      ...base,
      currency: 'USD',
      observedPrice: '97123.456789',
      targetPrice: '95000',
    });
    expect(message).toContain('97123.456789 dollars');
  });

  it('names the observation window in UTC', () => {
    const message = composeVoiceAlertMessage(base);
    expect(message).toContain('recorded at 14:32 UTC on 23 October.');
  });

  describe('speakAmount', () => {
    it('says the major unit alone when the fraction is zero', () => {
      expect(speakAmount('100.00', { major: 'dollars', minor: 'cents' })).toBe('100 dollars');
    });

    it('says the minor unit for an exact hundredths fraction', () => {
      expect(speakAmount('0.07', { major: 'dollars', minor: 'cents' })).toBe('0 dollars and 7 cents');
    });

    it('says excess precision verbatim in the major unit', () => {
      const spoken = speakAmount('97000.123456', { major: 'dollars', minor: 'cents' });
      expect(spoken).toBe('97000.123456 dollars');
    });
  });

  describe('speakTime', () => {
    it('formats a UTC instant', () => {
      expect(speakTime('2026-10-23T14:32:00.000Z')).toBe(
        'The observation was recorded at 14:32 UTC on 23 October.',
      );
    });

    it('says nothing on an unparseable instant rather than lying', () => {
      expect(speakTime('not-a-date')).toBe('');
    });
  });
});
