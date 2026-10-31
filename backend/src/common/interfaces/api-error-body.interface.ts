/**
 * Shape of every error response emitted by the API.
 *
 * A single envelope for all failures means the frontend needs exactly one
 * error path, and log aggregation can group on `code` + `path`.
 */
export interface ApiErrorBody {
  /** Stable, machine-readable error identifier. */
  code: string;
  /** Human-readable summary. Safe to show in a UI. */
  message: string;
  /** ISO-8601 UTC timestamp of the failure. */
  timestamp: string;
  /** Request path that produced the failure. */
  path: string;
  /** Correlation id, also emitted in logs and the `x-request-id` header. */
  requestId: string;
  /** Field-level validation failures, present only for VALIDATION_FAILED. */
  details?: string[];
}