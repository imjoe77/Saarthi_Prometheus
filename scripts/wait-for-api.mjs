#!/usr/bin/env node
/**
 * MODULE: dev tooling.
 *
 * The API is started by `nest start --watch`, which compiles the whole backend
 * before it listens - around twenty seconds from a cold start. Next.js is ready
 * in a few seconds, so the first page loads proxy to a port that is not
 * listening yet and the BFF logs a burst of
 *
 *   [bff] backend unreachable "fetch failed"
 *
 * before the API finally answers. The requests are not wrong, they are early.
 *
 * This waits for the API to report healthy before Next.js starts serving, so
 * the first request a developer makes is a real one. A timeout is a warning
 * rather than a failure: the web server can still serve pages that do not need
 * the API, and refusing to start would hide that.
 */

import { setTimeout as delay } from "node:timers/promises";

const API_PORT = Number(process.env["PROMETHEUS_API_PORT"] ?? 3001);
const HEALTH_URL = `http://127.0.0.1:${API_PORT}/api/health`;
const TIMEOUT_MS = Number(process.env["PROMETHEUS_API_WAIT_MS"] ?? 120_000);
const INTERVAL_MS = 500;

async function isHealthy() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isHealthy()) {
      console.log(`[web] API ready on ${API_PORT}`);
      return;
    }
    await delay(INTERVAL_MS);
  }

  console.warn(`[web] The API did not answer on ${API_PORT} within ${TIMEOUT_MS / 1000}s.`);
  console.warn("[web] Starting Next.js anyway - API calls will fail until the backend is up.");
}

main().catch((error) => {
  console.warn("[web] Could not wait for the API:", error instanceof Error ? error.message : error);
});
