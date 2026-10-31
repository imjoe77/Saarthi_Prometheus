/**
 * The ported `nav.dside` sidebar stylesheet for AppShell pages
 * (MODULE: design integration).
 *
 * Extracted from `lib/design/generated/*.design.ts` — the fixed 200px rail, the
 * two labelled dock groups, the sliding `.molten` hover indicator and the
 * collapse-to-top horizontal rail — so `/copy-trading`, `/wallet`, `/discover`
 * … show the same sidebar the design pages show.
 *
 * Two deliberate deviations from the source CSS:
 *
 *  - **Namespaced selectors.** Every rule is scoped under `.pb-shell` /
 *    `.pb-main` instead of the design's global `.app` / `.content`. Several
 *    AppShell pages inject their own global styles (`copyTrading-styles.ts`
 *    defines `.app`, `.content`, `.grp`, `.me`), and unscoped copies of those
 *    names would fight them. Class-scoped custom properties also beat anything
 *    a page sets on `:root`, because a declaration on the element itself wins
 *    over an inherited one regardless of cascade order.
 *  - **App-chrome palette.** The custom properties carry the application's own
 *    dark chrome (`#0E1116` rail, `#1B2028` hairlines, `#FF5A1F` ember accent —
 *    the colour the pre-port AppShell sidebar used for its active row) rather
 *    than the design mock's warm-brown theme, so the rail sits natively inside
 *    the `#0B0D10` shell it now belongs to. The geometry, spacing, transitions
 *    and collapse behaviour are the design's own, rule for rule.
 *
 * The collapse rules are wrapped in `min-width: 901px`: at ≤900px the design
 * turns the rail into a top icon strip, so the `off` state has nothing to do
 * there and the `#menu` toggle is hidden (matching that behaviour).
 */
export const shellSidebarStyles = `
.pb-shell {
  --nav: 200px;
  --gleasing: cubic-bezier(.2,.8,.2,1);
  --pn: #0E1116;
  --ln: #1B2028;
  --p2: rgba(255,255,255,.045);
  --ink: #F3F4F6;
  --mu: #9CA3AF;
  --dm: #6B7280;
  --gold: #FF5A1F;
  --bl: #7C2D12;
  --sans: var(--font-geist-sans), system-ui, -apple-system, sans-serif;
  display: flex;
}
.pb-shell .dside {
  position: fixed; left: 0; top: 0; bottom: 0; width: var(--nav); flex: none; z-index: 55;
  background: var(--pn); border-right: 1px solid var(--ln); padding: 16px 12px;
  display: flex; flex-direction: column; gap: 6px; overflow: auto;
  transition: left .45s var(--gleasing), top .45s var(--gleasing), width .45s var(--gleasing), opacity .3s ease;
}
.pb-shell .dside .logo {
  display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 13px;
  letter-spacing: .06em; padding: 0 6px 14px; color: var(--ink); text-decoration: none;
}
.pb-shell .dside .logo .mark {
  width: 28px; height: 28px; background: transparent; display: block;
  object-fit: contain; flex: none; filter: drop-shadow(0 0 9px rgba(255,90,31,.4));
}
.pb-shell .dside .grp {
  font: 700 9px/1 var(--sans); letter-spacing: .1em; color: var(--dm);
  padding: 12px 8px 5px; text-transform: uppercase;
}
.pb-shell .dside .dock { position: relative; display: flex; flex-direction: column; gap: 2px; }
.pb-shell .molten {
  position: absolute; left: 4px; right: 4px; top: 0; height: 0; border-radius: 9px;
  opacity: 0; pointer-events: none; will-change: top, height;
  background: var(--p2); border: 1px solid var(--ln);
  transition: top .34s var(--gleasing), height .34s var(--gleasing), opacity .2s ease;
}
.pb-shell .molten::before {
  content: ""; position: absolute; left: -1px; top: 50%; width: 3px; height: 56%;
  margin-top: -28%; border-radius: 99px; background: var(--gold);
}
.pb-shell .dside .dock a {
  position: relative; z-index: 1; display: flex; align-items: center; gap: 9px;
  padding: 7px 8px; border-radius: 8px; color: var(--mu); text-decoration: none;
  font-size: 13px; font-weight: 500; transition: color .18s ease, background .18s ease;
}
.pb-shell .dside .dock a:hover { color: var(--ink); background: var(--p2); }
.pb-shell .dside .dock a.on { color: var(--gold); font-weight: 700; }
.pb-shell .dside .ntx { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pb-shell .dside .nic { display: grid; place-items: center; width: 16px; height: 16px; flex: none; }
.pb-shell .dside .dock a svg {
  width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor;
  stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
}
.pb-shell .dside .me {
  margin-top: auto; display: flex; align-items: center; gap: 8px;
  border: 1px solid var(--ln); border-radius: 9px; padding: 8px;
  background: var(--p2); font: 11px var(--sans); color: var(--mu);
}
.pb-shell .dside .me b { display: block; color: var(--ink); font-size: 12px; }
.pb-shell .dside .me i {
  width: 26px; height: 26px; border-radius: 50%; flex: none;
  background: linear-gradient(135deg, var(--gold), var(--bl));
}
/* Sign-out, sat directly under the identity card: a dock row by look and by
   behaviour (same padding, radius, hover and focus treatment) so the rail's
   own language is what the control speaks. The label ellipses rather than
   wraps, so a long email prefix can never push it off the rail. */
.pb-shell .dside .me-out {
  display: flex; align-items: center; gap: 9px;
  margin-top: 2px; padding: 7px 8px; border: 0; border-radius: 8px;
  background: transparent; color: var(--mu); cursor: pointer; text-align: left;
  font: 500 13px var(--sans);
  transition: color .18s ease, background .18s ease;
}
.pb-shell .dside .me-out:hover { color: var(--ink); background: var(--p2); }
.pb-shell .dside .me-out:hover svg { color: var(--gold); }
.pb-shell .dside .me-out:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.pb-shell .dside .me-out svg {
  width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor;
  stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
}
.pb-shell .dside .me-out .ntx { min-width: 0; }
/* Content column: the design's .content, minus its page padding (each page
   brings its own) so the header and scroll area keep the shell's layout. */
.pb-shell .pb-main {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  margin-left: var(--nav);
  transition: margin-left .45s var(--gleasing);
}
/* The design's #menu button, living in the AppShell header's left slot. */
.pb-shell .menu-btn {
  display: grid; place-items: center; width: 38px; height: 38px; padding: 0;
  border-radius: 10px; background: transparent; border: 1px solid var(--ln);
  color: var(--ink); cursor: pointer;
  transition: background .18s ease, border-color .18s ease;
}
.pb-shell .menu-btn:hover { background: var(--p2); border-color: #2B3340; }
.pb-shell .menu-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.pb-shell .menu-btn svg {
  width: 18px; height: 18px; fill: none; stroke: currentColor;
  stroke-width: 2; stroke-linecap: round;
}
/* Collapsed = horizontal nav dock, parked in the header band (the design's
   top-rail collapse). Desktop widths only — see the ≤900px block below. */
@media (min-width: 901px) {
  .pb-shell.off .dside {
    left: 50%; right: auto; top: 6px; bottom: auto; width: max-content;
    max-width: calc(100vw - 150px); height: 46px; transform: translateX(-50%);
    flex-direction: row; align-items: center; gap: 4px; padding: 6px 8px;
    background: var(--pn); border: 1px solid var(--ln); border-radius: 12px;
    box-shadow: 0 10px 26px -20px rgba(0,0,0,.65);
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
    transition: left .45s var(--gleasing), top .45s var(--gleasing), height .35s var(--gleasing), opacity .3s ease;
  }
  .pb-shell.off .dside::-webkit-scrollbar { display: none; }
  .pb-shell.off .pb-main { margin-left: 0; }
  .pb-shell.off .dside .logo { width: auto; padding: 0 5px; flex: none; }
  .pb-shell.off .dside .logo .wm,
  .pb-shell.off .dside .grp,
  .pb-shell.off .dside .me { display: none; }
  /* The identity card has no room in the horizontal pill, but sign-out still
     has to be reachable from it: the row stays, its label folds away. */
  .pb-shell.off .dside .me-out { margin-top: 0; padding: 7px 9px; }
  .pb-shell.off .dside .me-out .ntx { display: none; }
  .pb-shell.off .molten { display: none; }
  .pb-shell.off .dock { flex-direction: row; gap: 2px; flex: none; }
  .pb-shell.off .dock + .dock {
    margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--ln);
  }
  .pb-shell.off .dock a {
    justify-content: center; min-width: 36px; padding: 7px 9px; gap: 0; background: none;
  }
  .pb-shell.off .dock a .ntx {
    max-width: 0; overflow: hidden; opacity: 0; font-size: 11px; color: var(--ink);
    white-space: nowrap;
    transition: max-width .3s var(--gleasing), opacity .22s ease, margin .3s var(--gleasing);
  }
  .pb-shell.off .dock a:hover .ntx,
  .pb-shell.off .dock a:focus-visible .ntx { max-width: 130px; opacity: 1; margin-left: 7px; }
}
/* Between the rail's natural width and the header's right cluster (the session
   controls) a centred pill would overlap, so in that band it parks left of the
   header content instead — same pill, guaranteed clearance at any email length. */
@media (min-width: 901px) and (max-width: 1240px) {
  .pb-shell.off .dside {
    left: 70px; transform: none; max-width: calc(100vw - 450px);
  }
}
@media (max-width: 900px) {
  .pb-shell { flex-direction: column; }
  .pb-shell .dside {
    position: static; height: auto; width: auto; flex: none;
    flex-direction: row; overflow-x: auto; overflow-y: hidden;
    padding: 10px; align-items: center; gap: 4px;
    border-right: 0; border-bottom: 1px solid var(--ln);
  }
  .pb-shell .dside .logo { padding: 0 8px; flex: none; }
  .pb-shell .dside .logo .wm { display: none; }
  .pb-shell .dside .grp,
  .pb-shell .dside .me { display: none; }
  /* No identity card on the top strip either, but the sign-out it belongs to
     rides along as an icon — the strip is where the rail has no text at all. */
  .pb-shell .dside .me-out { margin-top: 0; padding: 7px 9px; flex: none; }
  .pb-shell .dside .me-out .ntx { display: none; }
  .pb-shell .dside .ntx { display: none; }
  .pb-shell .molten { display: none; }
  /* Same specificity as the base .pb-shell .dside .dock rule (media queries
     do not raise it) and later in the sheet, so the horizontal docks win. */
  .pb-shell .dside .dock { flex-direction: row; gap: 4px; }
  .pb-shell .pb-main { margin-left: 0; }
  .pb-shell .menu-btn { display: none; }
}
`;
