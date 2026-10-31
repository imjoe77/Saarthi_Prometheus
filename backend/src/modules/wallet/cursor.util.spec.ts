import { HttpStatus } from '@nestjs/common';

import { DomainException } from '../../common/errors/domain.exception';
import { decodeCursor, encodeCursor } from './cursor.util';

/**
 * MODULE 03 - keyset cursors.
 *
 * The cursor is only ever produced by us and echoed back by a client, so the
 * tests cover the round trip at millisecond precision and the ways a client can
 * corrupt it. All corruptions must collapse to one indistinguishable 400.
 */
describe('cursor util', () => {
  describe('encode/decode round trip', () => {
    it('recovers the exact instant and id', () => {
      const createdAt = new Date('2026-10-02T10:00:00.123Z');
      const id = '11111111-2222-3333-4444-555555555555';

      const decoded = decodeCursor(encodeCursor(createdAt, id));

      expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
      expect(decoded.id).toBe(id);
    });

    it('produces a url-safe token', () => {
      const cursor = encodeCursor(new Date('2026-10-02T10:00:00.000Z'), 'some-id');

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('rejected cursors', () => {
    function expectInvalid(run: () => unknown): void {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainException);
        expect((error as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        return;
      }

      throw new Error('Expected the cursor to be rejected, but it decoded.');
    }

    it.each([
      ['', 'empty string'],
      ['not base64url!', 'invalid characters'],
      [Buffer.from('not json').toString('base64url'), 'valid base64 but not JSON'],
      [Buffer.from('{}').toString('base64url'), 'JSON without the required fields'],
      [
        Buffer.from(JSON.stringify({ v: 99, createdAt: '2026-01-01T00:00:00.000Z', id: 'x' })).toString('base64url'),
        'an unknown version',
      ],
      [
        Buffer.from(JSON.stringify({ v: 1, createdAt: 'not-a-date', id: 'x' })).toString('base64url'),
        'an unparseable date',
      ],
      [
        Buffer.from(JSON.stringify({ v: 1, createdAt: '2026-01-01T00:00:00.000Z', id: '' })).toString('base64url'),
        'an empty id',
      ],
    ])('rejects %s (%s)', (cursor) => {
      expectInvalid(() => decodeCursor(cursor));
    });
  });
});
