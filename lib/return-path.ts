/**
 * MODULE 02 — constrains a "return to" target to a path inside this application.
 *
 * The dedicated login flow carries a `next` parameter (`/login?next=/portfolio`)
 * so a visitor bounced from a protected page can be sent back after signing in.
 * A `next` value, like a `redirectTo`, must never become an open redirect:
 * `//evil.example.com` and `/\evil.example.com` are both treated as absolute
 * URLs by browsers despite looking relative. The same rules apply as in
 * `lib/auth-actions` (`safeRelativePath`), which lives in a `"use server"` file
 * and therefore cannot be imported here.
 */
export function sanitizeReturnPath(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return null;
  }
  return candidate;
}
