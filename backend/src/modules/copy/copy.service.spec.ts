import { maskEmail } from './copy.service';

/**
 * MODULE 07 - the one place a follower's address is reduced before it is shown
 * to the strategy's owner.
 *
 * The owner is entitled to know who is in their audience and not entitled to
 * collect it. These cases pin the middle ground exactly: what survives, what
 * does not, and what an address without a domain turns into - because "return
 * it unmasked because it looked unusual" is how a mask fails open.
 */
describe('maskEmail', () => {
  it('keeps one character of the local part and the whole domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });

  it('never returns the local part', () => {
    const masked = maskEmail('alice@example.com');
    expect(masked).not.toContain('lice');
    expect(masked).not.toContain('alice');
  });

  it('keeps two followers at different domains distinguishable', () => {
    expect(maskEmail('alice@example.com')).not.toBe(maskEmail('alice@other.com'));
  });

  it('works on an address whose local part is a single character', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('works on a plus-addressed and a dotted local part', () => {
    expect(maskEmail('alice+tag@example.com')).toBe('a***@example.com');
    expect(maskEmail('alice.smith@example.co.uk')).toBe('a***@example.co.uk');
  });

  it('refuses to echo anything back when there is no domain', () => {
    expect(maskEmail('alice')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });
});
