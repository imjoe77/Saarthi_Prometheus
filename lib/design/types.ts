/**
 * The shape of a ported design page (MODULE: design integration).
 *
 * Each HTML file under `designs/` is split once, at build time, by
 * `scripts/extract-designs.mjs` into three inert pieces — stylesheet, markup,
 * scripts — plus the page title. Nothing here executes or renders by itself;
 * `components/design/DesignFrame` is what mounts a spec, and it is the only
 * consumer.
 *
 * Splitting at build time (rather than fetching and parsing the HTML at
 * runtime) keeps the markup bundled and type-checked, keeps the original
 * designer's file as the single source of truth in `designs/`, and makes the
 * link rewriting — every design link pointing at another design file becomes
 * one of our routes — a reviewable, testable transformation instead of a
 * runtime surprise.
 */
export interface DesignScript {
  /** An external script (e.g. the trade-buddy bridge), path already rewritten. */
  src?: string;
  /** An inline script, already rewritten and wrapped; executed in list order. */
  code?: string;
}

export interface DesignSpec {
  /** The original `<title>`; applied while the page is mounted. */
  title: string;
  /** `data-theme` from the original `<html>`; set on `<html>` before scripts run. */
  theme: string;
  /** External stylesheets the page needs (Google Fonts), applied while mounted. */
  stylesheets: string[];
  /** Every `<style>` block from the original document, concatenated. */
  css: string;
  /** The original `<body>` markup with all `<script>` elements removed. */
  html: string;
  /**
   * Attributes the original `<body>` carried (`data-view`, `data-page-title`,
   * …). The designs read them when their scripts start to choose which
   * workspace (`.role-view`) to show — `user_dashboard.html` falls back to
   * `expert-view` without one — so `DesignFrame` re-applies them to the
   * document body before the scripts run, and removes them on unmount.
   */
  bodyAttrs?: Record<string, string>;
  /** Scripts in original document order; mounted in that order after the markup. */
  scripts: DesignScript[];
}
