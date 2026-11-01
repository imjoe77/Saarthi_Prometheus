#!/usr/bin/env node
/**
 * MODULE: dev tooling.
 *
 * `npm run dev` starts Next.js and the NestJS API against one project
 * directory, and only one copy of that pair may run at a time. A second copy
 * cannot share the directory: both write into `.next/`, the newcomer
 * overwrites the incumbent's route manifest, and from that moment every
 * `/api/*` route answers with an HTML 404 page instead of JSON. Auth.js then
 * fails to parse that page and throws
 *
 *   ClientFetchError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * Next.js refuses a second `next dev` on its own, but only after it has
 * already begun writing into `.next/`. This guard checks first, so an
 * incumbent dev server is never disturbed and the directory is never half
 * written.
 *
 * It also refuses to start when the API port is taken, because that means half
 * of the pair is already running: the new API would fail to bind and the web
 * server would proxy to a backend that is not there.
 */

import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Next.js writes this while a dev server owns the directory. */
const LOCK_FILE = resolve(projectRoot, ".next/dev/lock");

/** The API port, overridable so the guard follows the backend's own PORT. */
const API_PORT = Number(process.env["PROMETHEUS_API_PORT"] ?? 3001);

function readLock() {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, port: Number(parsed.port) || 3000, url: parsed.appUrl || null };
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

function portIsTaken(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (taken) => {
      socket.destroy();
      resolvePromise(taken);
    };
    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function refuse(lines) {
  console.error("");
  console.error("  A Prometheus dev server is already running.");
  console.error("");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  console.error("  Stop the running one before starting another. Two dev servers");
  console.error("  cannot share this directory - they overwrite each other's");
  console.error("  route table and every /api route starts answering with HTML.");
  console.error("");
  process.exit(1);
}

async function main() {
  const lock = readLock();

  if (lock && isAlive(lock.pid)) {
    refuse([
      `Next.js dev server: PID ${lock.pid}${lock.url ? `, ${lock.url}` : `, port ${lock.port}`}.`,
      "",
      "If it is already serving the app you want, just use it.",
    ]);
  }

  if (await portIsTaken(API_PORT)) {
    refuse([
      `The Prometheus API port ${API_PORT} is already in use.`,
      "",
      "A previous dev server is still holding it.",
    ]);
  }
}

main().catch((error) => {
  console.error("[dev-guard] could not check the dev environment:", error instanceof Error ? error.message : error);
  process.exit(1);
});
