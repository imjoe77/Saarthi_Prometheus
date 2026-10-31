import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { fetchJsonWithTimeout } from './http-fetch.util';
import { UsdtProviderError } from './usdt-pricing.types';

/**
 * MODULE 08 extension — the guarded fetch every provider call goes through,
 * tested against a local HTTP server: a healthy 200, a 404, a non-JSON body,
 * and a handler that never answers (the timeout). No external network is
 * involved, so the suite proves the timeout and error labels deterministically.
 */
describe('fetchJsonWithTimeout', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"hello":"world"}');
        return;
      }
      if (req.url === '/missing') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (req.url === '/not-json') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('definitely not json');
        return;
      }
      if (req.url === '/hangs') {
        // Never respond; the client's abort timer must fire.
        return;
      }
      res.writeHead(500);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('returns the parsed JSON of a healthy response', async () => {
    await expect(fetchJsonWithTimeout(`${baseUrl}/ok`, 'test', { timeoutMs: 1000 })).resolves.toEqual({
      hello: 'world',
    });
  });

  it('labels a non-2xx status without echoing the body', async () => {
    await expect(fetchJsonWithTimeout(`${baseUrl}/missing`, 'test', { timeoutMs: 1000 })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('labels an unparseable body', async () => {
    await expect(
      fetchJsonWithTimeout(`${baseUrl}/not-json`, 'test', { timeoutMs: 1000 }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('aborts a hanging request at the timeout and says so', async () => {
    const startedAt = Date.now();

    await expect(fetchJsonWithTimeout(`${baseUrl}/hangs`, 'test', { timeoutMs: 100 })).rejects.toThrow(
      /timed out after 100ms/,
    );
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('throws UsdtProviderError carrying the source label, for every failure mode', async () => {
    try {
      await fetchJsonWithTimeout(`${baseUrl}/missing`, 'coindcx_orderbook', { timeoutMs: 1000 });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(UsdtProviderError);
      expect((error as UsdtProviderError).source).toBe('coindcx_orderbook');
    }
  });

  it('sends caller-supplied headers (the CoinGecko key travels here, never in the URL)', async () => {
    const seen: string | undefined = await new Promise((resolve) => {
      const probe = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        resolve(req.headers['x-cg-demo-api-key'] as string | undefined);
      });
      void probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        void fetchJsonWithTimeout(`http://127.0.0.1:${port}/`, 'test', {
          timeoutMs: 1000,
          headers: { 'x-cg-demo-api-key': 'test-key-not-a-secret' },
        }).finally(() => probe.close());
      });
    });

    expect(seen).toBe('test-key-not-a-secret');
  });
});
