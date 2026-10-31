import { InvalidPhoneNumberError, maskForDisplay, normaliseToE164 } from './phone';

/**
 * MODULE 14 - the strict E.164 rule, on exact input.
 *
 * A phonely permissive normaliser would dial a real stranger with the wrong
 * country code, so the rule is recorded here: formatting is accepted, an
 * absent country code is refused, and no default country code exists.
 */
describe('sentinel phone normalisation', () => {
  describe('normaliseToE164', () => {
    it('accepts an already-canonical E.164 number', () => {
      expect(normaliseToE164('+14155552671')).toBe('+14155552671');
    });

    it('strips accepted formatting but keeps only digits after the +', () => {
      expect(normaliseToE164('+1 (415) 555-2671')).toBe('+14155552671');
      expect(normaliseToE164('+91-98765-43210')).toBe('+919876543210');
    });

    it('rejects a number without a country code rather than guessing one', () => {
      expect(() => normaliseToE164('4155552671')).toThrow(InvalidPhoneNumberError);
      expect(() => normaliseToE164('9876543210')).toThrow(InvalidPhoneNumberError);
    });

    it('rejects digit counts outside the routable E.164 band', () => {
      expect(() => normaliseToE164('+1234567')).toThrow(InvalidPhoneNumberError);
      expect(() => normaliseToE164('+123456789012345678')).toThrow(InvalidPhoneNumberError);
    });

    it('rejects empty input but maps null to clearing', () => {
      expect(() => normaliseToE164('   ')).toThrow(InvalidPhoneNumberError);
      expect(() => normaliseToE164('')).toThrow(InvalidPhoneNumberError);
      expect(normaliseToE164(null)).toBeNull();
      expect(normaliseToE164(undefined)).toBeNull();
    });

    it('rejects non-digit payloads such as a plus-only string', () => {
      expect(() => normaliseToE164('+')).toThrow(InvalidPhoneNumberError);
    });
  });

  describe('maskForDisplay', () => {
    it('shows the country digit and last four digits only', () => {
      const masked = maskForDisplay('+14155552671');
      expect(masked).toContain('+1');
      expect(masked).toContain('2671');
      expect(masked).not.toContain('415');
    });

    it('gives a different mask for a differently-ended number', () => {
      expect(maskForDisplay('+299123456')).not.toBe(maskForDisplay('+299654321'));
    });
  });
});
