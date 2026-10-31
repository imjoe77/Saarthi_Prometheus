/**
 * MODULE 14 - phone-number normalisation and safe display.
 *
 * ONE STORED FORMAT. Everything Sentinel dials, displays and logs is E.164
 * with a leading `+`. The normaliser is deliberately strict: formatting is
 * accepted (spaces, dashes, parentheses are stripped), but a number without a
 * leading `+` is refused rather than guessed at with a default country code -
 * silently prefixing the wrong country would dial a real stranger, and "the
 * safe answer is to require the caller to say what they mean" also applies to
 * phone numbers.
 *
 * MASKING IS THE ONLY DISPLAY PATH. Logs, errors and any response that does
 * not belong to the number's owner show the mask, never the number.
 */

/** After removing formatting, a routed E.164 number carries 8-15 digits. */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

export class InvalidPhoneNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Normalises user input to canonical E.164 (`+` followed by 8-15 digits),
 * or returns null for an absent value (clearing the stored number).
 */
export function normaliseToE164(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const text = raw.trim();
  if (text === '') {
    throw new InvalidPhoneNumberError('Phone number is empty.');
  }

  if (!text.startsWith('+')) {
    throw new InvalidPhoneNumberError(
      'Phone number must include the country code in E.164 form, for example +14155552671.',
    );
  }

  const digits = text
    .slice(1)
    .split('')
    .filter((char) => /[\d]/.test(char));

  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    throw new InvalidPhoneNumberError(
      `Phone number must carry between ${MIN_E164_DIGITS} and ${MAX_E164_DIGITS} digits after the +.`,
    );
  }

  return `+${digits.join('')}`;
}

/**
 * A user-safe display form: country code and last four digits only, e.g.
 * `+1 •••• 2670`. Never enough of the number to call or identify a person.
 */
export function maskForDisplay(e164: string): string {
  const digits = e164.replace(/[^\d]/g, '');
  const lastFour = digits.slice(-4);
  const country = e164.startsWith('+') ? e164.charAt(1) : '';
  return `+${country} •••• ${lastFour}`;
}
