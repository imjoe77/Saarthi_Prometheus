import "server-only";

import { createPublicKey } from "node:crypto";

/**
 * MODULE 02 — server-side configuration for the OAuth and token-minting side.
 *
 * Everything the frontend knows about authentication lives here, and every value
 * is validated at first use rather than at module load. Lazy resolution matters
 * because the marketing pages import the shell, which imports this file: a
 * module-scope throw would make `next build` fail for a page that needs none of
 * it, and would produce an error message with no indication of which variable
 * was wrong.
 *
 * Never prefix anything here with `NEXT_PUBLIC_`. That prefix publishes the value
 * into the client bundle, which would put the OAuth client secret and the token
 * signing key in front of every visitor.
 */

/** Thrown when configuration is missing or unusable. Never carries a secret. */
export class AuthConfigError extends Error {
  constructor(variable: string, problem: string) {
    super(
      `Authentication is not configured correctly: ${variable} ${problem}. ` +
        `Copy .env.example to .env.local and fill in the OAuth and signing values.`,
    );
    this.name = "AuthConfigError";
  }
}

function read(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new AuthConfigError(name, "is missing or empty");
  }

  return value;
}

/**
 * Undoes the escaping a `.env` file applies to a multi-line value.
 *
 * dotenv cannot hold a literal newline inside a quoted value, so a PEM is stored
 * as one line with `\n` sequences. The key parsers need real newlines.
 */
export function normalisePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

/** Google and GitHub are both required: the spec commits to both working. */
export function getGoogleProviderConfig(): OAuthProviderConfig {
  return { clientId: read("GOOGLE_CLIENT_ID"), clientSecret: read("GOOGLE_CLIENT_SECRET") };
}

export function getGitHubProviderConfig(): OAuthProviderConfig {
  return { clientId: read("GITHUB_CLIENT_ID"), clientSecret: read("GITHUB_CLIENT_SECRET") };
}

/** Base URL of the NestJS API, without a trailing slash. */
export function getApiBaseUrl(): string {
  return read("AUTH_API_BASE_URL").replace(/\/+$/, "");
}

/**
 * The RS256 private key that signs access tokens.
 *
 * The backend holds only the matching public key, which is what makes the split
 * enforceable rather than aspirational: even a fully compromised backend cannot
 * mint a token this frontend would accept.
 */
export function getTokenSigningKey(): string {
  const pem = normalisePem(read("AUTH_API_SIGNING_PRIVATE_KEY"));
  const label = /^-----BEGIN ([A-Z0-9 ]+)-----/.exec(pem.trim())?.[1];

  if (!label || !label.includes("PRIVATE KEY")) {
    throw new AuthConfigError(
      "AUTH_API_SIGNING_PRIVATE_KEY",
      "must be a PKCS#8 RSA private key in PEM form",
    );
  }

  try {
    createPublicKey(pem);
  } catch {
    throw new AuthConfigError("AUTH_API_SIGNING_PRIVATE_KEY", "is not a readable key");
  }

  return pem;
}

/** Where the backend expects the token to have come from. */
export function getTokenIssuer(): string {
  return process.env["AUTH_API_ISSUER"]?.trim() || "prometheus-web";
}

export function getTokenAudience(): string {
  return process.env["AUTH_API_AUDIENCE"]?.trim() || "prometheus-api";
}

/** Access token lifetime in seconds. Kept short; it is not the session. */
export function getTokenTtlSeconds(): number {
  const raw = process.env["AUTH_API_TOKEN_TTL_SECONDS"]?.trim();

  if (!raw) return 900;

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 86400) {
    throw new AuthConfigError("AUTH_API_TOKEN_TTL_SECONDS", "must be an integer between 60 and 86400");
  }

  return parsed;
}