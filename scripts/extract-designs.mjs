#!/usr/bin/env node
/**
 * Design extraction pipeline (MODULE: design integration).
 *
 * The pages under `designs/` are the designer's original, self-contained HTML
 * documents — full-page styles, markup and inline scripts. Next.js cannot route
 * to them as-is, and hand-copying them would immediately drift from the source.
 * So each document is split here, once, into an inert TypeScript module under
 * `lib/design/generated/`:
 *
 *   <title>   → title
 *   <link rel="stylesheet"> → stylesheets (Google Fonts etc., re-applied while mounted)
 *   <style>   → css
 *   <body minus <script>> → html
 *   <script>  → scripts, in document order
 *
 * Two transformations run over the extracted pieces:
 *
 *  1. LINK REWRITING. The designs link to each other as files
 *     (`../portfolio/user_portfolio.html`, `staking.html`, …) and to assets and
 *     scripts by relative path. Every one of those becomes one of our routes or
 *     public assets, so the ported pages navigate inside the app. Any link that
 *     still points at an `.html` file after rewriting fails the build — a
 *     dead link must be decided here, not discovered by a user.
 *
 *  2. SCRIPT PREPARATION. Inline scripts are wrapped so that `setInterval`,
 *     `clearInterval`, `setTimeout` and `requestAnimationFrame` called *by the
 *     design* are recorded in a per-mount registry (`window.__pbReg`), which
 *     `DesignFrame` drains when the page unmounts — otherwise every chart
 *     ticker would outlive its page. `window.addEventListener("load", …)` is
 *     redirected to a helper that fires immediately when the window has
 *     already loaded, because these scripts run after React mounted, not
 *     before the load event.
 *
 * Run: `node scripts/extract-designs.mjs` (idempotent; output is committed).
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "designs");
const outDir = path.join(root, "lib", "design", "generated");

/**
 * Design-relative path → app route (or public asset), applied in order.
 *
 * Order is the whole trick: the longest, most specific pattern first, so
 * `../portfolio/user_portfolio.html` is matched before the bare
 * `user_portfolio.html` that is a suffix of it, and `../assets/…` before
 * `assets/…`. A bare self-reference (`staking.html` inside staking.html)
 * therefore still becomes `/staking`.
 *
 * Anchors ride along untouched: the patterns cover only the file part, so
 * `../portfolio/user_portfolio.html#activity` becomes `/portfolio#activity`.
 */
const REWRITES = [
  ["../Ai%20trade%20buddy/trade-buddy.js", "/trade-buddy.js"],
  ["../assets/prometheus-logo.png", "/assets/prometheus-logo.png"],
  ["assets/prometheus-logo.png", "/assets/prometheus-logo.png"],
  ["../portfolio/liquidity_provider_portfolio.html", "/liquidity/portfolio"],
  ["../portfolio/user_portfolio.html", "/portfolio"],
  ["../portfolio/expert_portfolio.html", "/expert/portfolio"],
  ["../project/copy_trading.html", "/copy-trading"],
  ["../project/ember_token.html", "/tokenomics"],
  ["../changes/trade_view.html", "/discover"],
  ["../staking.html", "/staking"],
  ["../dashboard/liquidity_dashboard.html", "/liquidity/dashboard"],
  ["../dashboard/user_dashboard.html", "/dashboard"],
  ["../dashboard/expert_dashboard.html", "/expert/dashboard"],
  ["dashboard/liquidity_dashboard.html", "/liquidity/dashboard"],
  ["dashboard/user_dashboard.html", "/dashboard"],
  ["dashboard/expert_dashboard.html", "/expert/dashboard"],
  ["liquidity_provider_portfolio.html", "/liquidity/portfolio"],
  ["liquidity_admin.html", "/admin/liquidity"],
  ["platform_admin.html", "/admin"],
  ["project/ember_token.html", "/tokenomics"],
  ["liquidity_dashboard.html", "/liquidity/dashboard"],
  ["expert_dashboard.html", "/expert/dashboard"],
  ["user_dashboard.html", "/dashboard"],
  ["expert_portfolio.html", "/expert/portfolio"],
  ["user_portfolio.html", "/portfolio"],
  ["staking.html", "/staking"],
];

/**
 * Recorded before a design script runs, so `DesignFrame` can cancel everything
 * the page scheduled when the page goes away. The wrapper shadows the timer
 * globals *lexically* — only code inside the wrapper sees them, so React's and
 * Next's own timers are never touched.
 */
const REGISTRY_PRELUDE = `window.__pbReg = window.__pbReg || { intervals: [], timeouts: [], frames: [] };
(function () {
  var reg = window.__pbReg;
  var setInterval = function (fn, ms) { var id = window.setInterval(fn, ms); reg.intervals.push(id); return id; };
  var clearInterval = function (id) { reg.intervals = reg.intervals.filter(function (x) { return x !== id; }); return window.clearInterval(id); };
  var setTimeout = function (fn, ms) { var args = Array.prototype.slice.call(arguments, 2); var id = window.setTimeout(function () { fn.apply(null, args); }, ms); reg.timeouts.push(id); return id; };
  var clearTimeout = function (id) { reg.timeouts = reg.timeouts.filter(function (x) { return x !== id; }); return window.clearTimeout(id); };
  var requestAnimationFrame = function (fn) { var id = window.requestAnimationFrame(fn); reg.frames.push(id); return id; };
  var cancelAnimationFrame = function (id) { reg.frames = reg.frames.filter(function (x) { return x !== id; }); return window.cancelAnimationFrame(id); };
`;

const REGISTRY_EPILOGUE = `})();`;

/**
 * `window.addEventListener("load", …)` inside a ported script would never fire:
 * these scripts run after React has mounted, and the load event is already
 * behind us (or arrives later — both cases handled).
 */
function retargetLoadListener(code) {
  return code.replace(
    /window\.addEventListener\(\s*(['"])load\1\s*,/g,
    '__pbAfterLoad("load",',
  );
}

const BOOT_HELPER = `function __pbAfterLoad(type, fn, opts) {
  if (document.readyState === "complete") { try { fn(); } catch (error) { console.error(error); } }
  else { window.addEventListener(type, fn, opts); }
}
`;

/** `liquidity_provider_portfolio.html` → `liquidityProviderPortfolio`. */
function camelKey(filename) {
  return filename
    .replace(/\.html$/, "")
    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Final pass: a script referenced without any directory (`trade-buddy.js`, as
 * `liquidity_admin.html` does) becomes root-relative. The preceding-character
 * class keeps an already-rewritten `/trade-buddy.js` from doubling its slash.
 */
function rewriteBareScriptRef(value) {
  return value.replace(/(^|["'(=\s])trade-buddy\.js/g, "$1/trade-buddy.js");
}

function rewrite(value) {
  let out = value;
  for (const [from, to] of REWRITES) {
    // Every `to` is root-relative while most `from`s are relative, so a later
    // rule can otherwise re-match an earlier rule's output: `../assets/x` →
    // `/assets/x` would be hit again by the bare `assets/x` row and come out
    // as the protocol-relative `//assets/x`. Skipping matches already
    // preceded by `/` makes the table idempotent — every rule maps only raw
    // design-relative references, never a value the table itself produced.
    out = out.replace(new RegExp(`(?<!/)${escapeRegExp(from)}`, "g"), to);
  }
  return rewriteBareScriptRef(out);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fails loudly on any link the rewrite table did not decide. */
function assertNoLeftoverFileLinks(where, text) {
  const leftover = text.match(/(?:href|src)\s*=\s*["']([^"']*\.html[^"']*)["']/);
  if (leftover) {
    throw new Error(`${where}: link still points at a design file after rewriting: ${leftover[1]}`);
  }

  // Two rules firing on the same reference (a relative one rewriting into a
  // root-relative path a later row then matches again) would emit `//…`, which
  // browsers read as protocol-relative. Catch it rather than ship a dead image.
  const doubled = text.match(/(?:href|src)\s*=\s*["'](\/\/[^"']*)["']|url\(\s*['"]?(\/\/[^'")]+)/);
  if (doubled) {
    throw new Error(`${where}: rewriting doubled the leading slash: ${doubled[1] ?? doubled[2]}`);
  }
}

async function extract(filename) {
  const raw = await readFile(path.join(sourceDir, filename), "utf8");

  const title = raw.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? "";
  if (!title) throw new Error(`${filename}: no <title>`);

  // The documents set `data-theme` on <html> and their CSS redefines variables
  // under `:root[data-theme=…]`, so the frame has to reproduce that attribute
  // before the scripts run — a toggle script then reads it the same way the
  // original page would have.
  const theme = raw.match(/<html[^>]*\bdata-theme="([^"]+)"/)?.[1] ?? "";

  const stylesheets = [...raw.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)]
    .map((match) => match[1]);

  const css = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join("\n")
    .trim();
  if (!css) throw new Error(`${filename}: no <style> block`);

  // Scripts are taken from the whole document, in order, and removed from the
  // markup: a <script> injected through innerHTML parses but never executes, so
  // the frame runs them explicitly instead.
  const scripts = [];
  for (const match of raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = match[1].match(/\bsrc\s*=\s*"([^"]+)"/)?.[1];
    if (src) {
      scripts.push({ src: rewrite(src) });
      if (!scripts[scripts.length - 1].src.startsWith("/")) {
        throw new Error(`${filename}: script src not rewritten to an app path: ${src}`);
      }
    } else {
      const rewritten = rewrite(match[2]);
      const prepared =
        BOOT_HELPER +
        retargetLoadListener(rewritten);
      scripts.push({
        code: `${REGISTRY_PRELUDE}\n${prepared}\n${REGISTRY_EPILOGUE}`,
      });
    }
  }
  if (scripts.length === 0) throw new Error(`${filename}: no scripts`);

  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error(`${filename}: no <body>`);
  const html = rewrite(bodyMatch[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));

  // Attributes on <body> itself (data-view, data-page-title, …) are read by the
  // design's own scripts to pick a workspace. The body tag is not part of the
  // extracted markup, so they are carried in the spec and re-applied by
  // DesignFrame — without them `user_dashboard.html` shows `expert-view`.
  const bodyAttrs = {};
  for (const attr of raw.match(/<body([^>]*)>/)?.[1]?.matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g) ?? []) {
    bodyAttrs[attr[1]] = attr[2];
  }

  assertNoLeftoverFileLinks(`${filename} (markup)`, html);
  for (const script of scripts) {
    if (script.code) assertNoLeftoverFileLinks(`${filename} (inline script)`, script.code);
  }

  return {
    key: camelKey(filename),
    filename,
    spec: {
      title,
      theme,
      stylesheets,
      css,
      html,
      ...(Object.keys(bodyAttrs).length > 0 ? { bodyAttrs } : {}),
      scripts,
    },
  };
}

function renderModule({ key, filename, spec }) {
  return `// AUTO-GENERATED by \`node scripts/extract-designs.mjs\` — do not edit.
// Source of truth: designs/${filename}. Edit the design file (or the rewrite
// table in the extraction script) and re-run the script.
import type { DesignSpec } from "../types";

export const ${key}Design: DesignSpec = ${JSON.stringify(spec, null, 2)};
`;
}

async function main() {
  const files = (await readdir(sourceDir))
    .filter((name) => name.endsWith(".html"))
    .sort();
  if (files.length === 0) throw new Error(`no design files in ${sourceDir}`);

  await mkdir(outDir, { recursive: true });

  const extracted = [];
  for (const filename of files) {
    const result = await extract(filename);
    extracted.push(result);
    await writeFile(path.join(outDir, `${result.key}.design.ts`), renderModule(result), "utf8");
    const inline = result.spec.scripts.filter((script) => script.code).length;
    const external = result.spec.scripts.length - inline;
    console.log(
      `${filename.padEnd(36)} → ${result.key}.design.ts  ` +
        `(css ${(result.spec.css.length / 1024).toFixed(0)}KB, html ${(result.spec.html.length / 1024).toFixed(0)}KB, ` +
        `${inline} inline + ${external} external scripts)`,
    );
  }

  const index = `// AUTO-GENERATED by \`node scripts/extract-designs.mjs\` — do not edit.
${extracted
  .map(({ key, filename }) => `import { ${key}Design } from "./${key}.design"; // designs/${filename}`)
  .join("\n")}

import type { DesignSpec } from "../types";

export const designs = {
${extracted.map(({ key }) => `  ${key}: ${key}Design,`).join("\n")}
} satisfies Record<string, DesignSpec>;

export type DesignKey = keyof typeof designs;
`;
  await writeFile(path.join(outDir, "index.ts"), index, "utf8");

  console.log(`\n${extracted.length} designs → ${path.relative(root, outDir)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
