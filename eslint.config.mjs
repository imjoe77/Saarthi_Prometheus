import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The backend is a separate package with its own ESLint config and its own
    // build output. Linting compiled `dist/` from here reported require() calls
    // in generated JavaScript that no human wrote and cannot fix.
    "backend/**",
    // Browser-shipped widget scripts, adapted from the design hand-off under
    // `UI/Frontend2(nikhil)/Promotehus/Ai trade buddy/`. They are static
    // assets the page loads at runtime, not app source: every difference from
    // the origin file is a deliberate diff (branding, asset paths), so their
    // lint findings are reviewed against that origin instead of gating the
    // application build here.
    "public/**",
  ]),
]);

export default eslintConfig;
