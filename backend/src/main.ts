import { bootstrap } from './bootstrap';

/**
 * Process entrypoint.
 *
 * A crash during bootstrap is fatal and intentional: a service that cannot
 * validate its environment or reach its dependencies must not run in a
 * partially-initialised state. The non-zero exit code is what a container
 * orchestrator and a deploy pipeline act on.
 */
bootstrap().catch((error: unknown) => {
  // The Nest logger may not be configured yet, so this writes directly.
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});