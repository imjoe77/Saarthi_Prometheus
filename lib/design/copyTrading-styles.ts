/**
 * Generated from the project design reference (copy_trading.html).
 * Injected by the page as a <style> element so it unmounts on navigation
 * instead of leaking these global selectors into the rest of the app.
 *
 * Rebuilt for the product: the reference's Manrope / JetBrains Mono stack is
 * never loaded by the app, so every figure it set fell back to the system
 * mono face and the page read as a different product. The tokens below now
 * use the app's own Geist faces, and the surfaces use the Prometheus palette
 * (near-black panels, ember accent) so this page matches the rest of the
 * platform.
 */
export const copyTradingStyles = `
:root {
  --bg: #0b0d10;
  --side: #12151a;
  --panel: transparent;
  --p2: rgba(255, 255, 255, 0.03);
  --p3: rgba(255, 255, 255, 0.06);
  --line: #1f252e;
  --line-light: #2c333f;
  --ink: #f3f4f6;
  --mute: #9ca3af;
  --dim: #6b7280;
  --ember: #ff5a1f;
  --ember-glow: rgba(255, 90, 31, 0.22);
  --soft: rgba(255, 90, 31, 0.10);
  --gain: #22b980;
  --gain-soft: rgba(34, 185, 128, 0.12);
  --loss: #f0616c;
  --loss-soft: rgba(240, 97, 108, 0.12);
  --amber: #f59e0b;
  --amber-soft: rgba(245, 158, 11, 0.12);
  --sans: var(--font-geist-sans), system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
  --radius-sm: 12px;
  --radius-md: 16px;
  --radius-lg: 20px;
  --shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  --grid-line: rgba(255, 255, 255, .015);
  color-scheme: dark;
}
html[data-theme="light"] {
  --bg: #f5f6f8;
  --side: #ffffff;
  --panel: #ffffff;
  --p2: #f3f4f6;
  --p3: #e5e7eb;
  --line: #e5e7eb;
  --line-light: #d1d5db;
  --ink: #111418;
  --mute: #5f6672;
  --dim: #8a909b;
  --ember: #e04a14;
  --ember-glow: rgba(224, 74, 20, .16);
  --soft: rgba(224, 74, 20, .09);
  --gain: #078267;
  --gain-soft: rgba(7, 130, 103, .11);
  --loss: #d63d4b;
  --loss-soft: rgba(214, 61, 75, .10);
  --amber: #996000;
  --amber-soft: rgba(153, 96, 0, .11);
  --shadow: 0 24px 64px rgba(28, 39, 58, .18);
  --grid-line: rgba(23, 28, 40, .035);
  color-scheme: light;
}

/* Scoped to this page. The AppShell around it is built from Tailwind
   utilities, and an unlayered universal reset here would strip their padding
   (unlayered rules win over @layer utilities). */
.cp-page, .cp-page *, .cp-page *::before, .cp-page *::after { box-sizing: border-box; }
.cp-page * { margin: 0; padding: 0; }
* { scrollbar-width: thin; scrollbar-color: var(--line-light) transparent; }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: var(--line-light); }
::-webkit-scrollbar-thumb:hover { background: var(--dim); }
::-webkit-scrollbar-track { background: transparent; }
::selection { background: var(--ember); color: #120700; }

.cp-page {
  background:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px),
    var(--bg);
  background-size: 64px 64px, 64px 64px, auto;
  color: var(--ink);
  font: 14px/1.55 var(--sans);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.003em;
  -webkit-font-smoothing: antialiased;
}

.cp-page button {
  font: inherit;
  color: inherit;
  background: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  cursor: pointer;
  transition: border-color 0.18s ease, color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}
.cp-page button:hover { border-color: var(--line-light); color: var(--ink); }
.cp-page :focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }

.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.mute { color: var(--mute); }
.amtv { font-family: var(--mono); }

.app { display: grid; grid-template-columns: 250px minmax(0, 1fr); min-height: 100vh; }

/* ── Sidebar ────────────────────────────────────────── */
.side {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 250px;
  height: 100vh;
  background: var(--side);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: 22px 14px;
  overflow-y: auto;
  z-index: 20;
  transition: width .45s cubic-bezier(.42,0,.33,1), left .45s cubic-bezier(.42,0,.33,1), top .45s cubic-bezier(.42,0,.33,1), transform .45s cubic-bezier(.42,0,.33,1), padding .45s cubic-bezier(.42,0,.33,1), border-radius .35s ease, box-shadow .35s ease;
}
.side nav { display:flex; flex-direction:column; }
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 6px 22px;
  font-weight: 800;
  font-size: 17px;
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--line);
}
.brand .brand-logo {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  object-fit: cover;
  flex: none;
}
.brand b {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: var(--ember);
  display: grid;
  place-items: center;
  color: #120700;
  font-size: 15px;
  font-weight: 800;
}
.grp { font: 800 10px/1 var(--sans); letter-spacing: 0.14em; color: var(--dim); padding: 22px 12px 9px; text-transform: uppercase; }
.side a {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-left: 2px solid transparent;
  border-radius: 0;
  color: var(--mute);
  text-decoration: none;
  font-weight: 600;
  font-size: 13.5px;
  margin-bottom: 2px;
  transition: color 0.16s ease, border-color 0.16s ease, background 0.16s ease;
}
.side a:hover { background: var(--p2); color: var(--ink); }
.side a.on { background: transparent; color: var(--ember); border-left-color: var(--ember); font-weight: 700; }
.side svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.sp { flex: 1; min-height: 20px; }
.me { display: flex; align-items: center; gap: 11px; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 11px; }
.av { width: 32px; height: 32px; border-radius: var(--radius-sm); background: linear-gradient(135deg, #ff6a1a, #a855f7); display: grid; place-items: center; font-weight: 800; font-size: 12px; color: #fff; flex: none; }
.me b { display: block; font-size: 12.5px; line-height: 1.25; }
.me small { color: var(--mute); font-size: 11px; font-family: var(--mono); }
.scrim { display: none; }

/* ── Content / top bar ──────────────────────────────── */
.content { grid-column: 2; grid-row: 1; padding: 0 36px 60px; min-width: 0; }
.top { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 18px 0; border-bottom: 1px solid var(--line); }
.menu { display: inline-flex; align-items:center; justify-content:center; width:40px; height:40px; padding:0; margin-right:auto; border-radius:10px; color:var(--mute); background:var(--side); transition:color .2s ease, background .2s ease, border-color .2s ease, transform .18s ease; }
.menu:hover { color:var(--ember); border-color:var(--ember); background:var(--soft); }
.menu:active { transform:scale(.94); }
.side-menu { display:inline-flex; flex:none; margin:0 0 0 auto; }
.mobile-menu { display:none; }
.menu svg { width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; transition:transform .35s cubic-bezier(.2,.8,.2,1); }
.menu[aria-expanded="false"] svg { transform:rotate(180deg); }
.theme-toggle { display:flex; align-items:center; gap:8px; padding:7px 11px; border-radius:var(--radius-sm); color:var(--mute); font-size:12px; font-weight:700; }
.theme-toggle:hover { color:var(--ember); border-color:var(--ember); background:var(--soft); }
.theme-toggle svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; transition:transform .28s cubic-bezier(.2,.8,.2,1); }
.theme-toggle:hover svg { transform:rotate(-12deg) scale(1.08); }
html[data-theme="dark"] .theme-toggle .sun-mark, html[data-theme="light"] .theme-toggle .moon-mark { display:none; }
html.theme-reveal::view-transition-old(root) { animation:none; }
html.theme-reveal::view-transition-new(root) { animation:pageReveal .72s cubic-bezier(.2,.8,.2,1) both; }
@keyframes pageReveal { from { clip-path:circle(0 at var(--theme-x, 50%) var(--theme-y, 50%)); } to { clip-path:circle(150vmax at var(--theme-x, 50%) var(--theme-y, 50%)); } }
.theme-wipe { position:fixed; inset:0; z-index:999; pointer-events:none; opacity:0; clip-path:circle(0 at var(--theme-x, 50%) var(--theme-y, 50%)); background:radial-gradient(circle at var(--theme-x, 50%) var(--theme-y, 50%), rgba(255,106,26,.22), rgba(255,106,26,.08) 42%, transparent 74%); }
.theme-wipe.run { animation:themeWipe .72s cubic-bezier(.2,.8,.2,1) both; }
@keyframes themeWipe { 0% { opacity:1; clip-path:circle(0 at var(--theme-x) var(--theme-y)); } 75% { opacity:.9; } 100% { opacity:0; clip-path:circle(150vmax at var(--theme-x) var(--theme-y)); } }
.wallet {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 5px 12px;
  color: var(--mute);
  background: transparent;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.cp-page h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.025em; padding-top: 26px; }
.cp-page h1::after { content: ""; display: block; width: 40px; height: 2px; background: var(--ember); margin-top: 10px; }

/* ── Copy-book metrics: compact tiles with a real detail toggle ── */
.kpi-wrap { margin:28px 0 0; }
.kpi-head { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px; }
.kpi-heading { display:flex;align-items:center;gap:9px;color:var(--mute);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase; }
.kpi-live { display:inline-flex;align-items:center;gap:6px;color:var(--gain);font-size:9.5px;letter-spacing:.06em; }
.kpi-live i { width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px var(--gain-soft); }
.kpi-toggle { display:inline-flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--mute);font-size:10px;font-weight:700;transition:border-color .2s,color .2s,background .2s; }
.kpi-toggle:hover,.kpi-toggle:focus-visible { border-color:var(--ember);color:var(--ember);background:var(--soft); }
.kpi-switch { width:28px;height:16px;padding:2px;border-radius:99px;background:var(--line-light);transition:background .2s; }
.kpi-switch i { display:block;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .22s cubic-bezier(.2,.8,.2,1); }
.kpi-toggle[aria-checked="true"] .kpi-switch { background:var(--ember); }
.kpi-toggle[aria-checked="true"] .kpi-switch i { transform:translateX(12px); }
.kpi { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px; }
.kpi-card { min-width:0;position:relative;isolation:isolate;overflow:hidden;padding:16px 17px 15px;background:var(--side);border:1px solid var(--line);border-radius:14px;box-shadow:0 3px 12px rgba(0,0,0,.28);transition:border-color .18s,box-shadow .18s,background .18s; }
.kpi-card::before { content:"";position:absolute;z-index:-1;top:0;left:17px;width:28px;height:2px;border-radius:0 0 3px 3px;background:var(--ember); }
.kpi-card:hover { border-color:var(--line-light);box-shadow:0 6px 18px rgba(0,0,0,.34); }
.kpi-label { display:flex;align-items:center;gap:8px;min-width:0; }
.kpi-icon { display:grid;place-items:center;flex:none;width:26px;height:26px;border-radius:8px;background:var(--soft);color:var(--ember);font:600 12px var(--mono);transition:background .18s,color .18s; }
.kpi-card:hover .kpi-icon { background:var(--ember);color:#fff; }
.kpi small { color:var(--dim);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;line-height:1.35; }
.kpi b { display:block;margin:12px 0 3px;font:600 clamp(20px,2vw,24px)/1.2 var(--mono);letter-spacing:-.02em; }
.kpi-sub { display:block;min-height:17px;color:var(--dim);font-size:10.5px; }
.kpi-extra { display:block;max-height:0;overflow:hidden;opacity:0;color:var(--mute);font-size:10px;line-height:1.5;transition:max-height .28s ease,opacity .2s ease,margin .2s ease; }
.kpi.details-on .kpi-extra { max-height:42px;opacity:1;margin-top:9px; }
@media(prefers-reduced-motion:reduce){.kpi-card,.kpi-card::before,.kpi-icon,.kpi-toggle,.kpi-switch i,.kpi-extra{transition:none}.kpi-card:hover,.kpi:active{transform:none}}

/* ── Risk profile block — one panel, ember corner tick ─ */
.you {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 20px 24px;
  margin: 28px 0 32px;
  background-image: linear-gradient(90deg, var(--ember) 44px, transparent 44px);
  background-repeat: no-repeat;
  background-size: 100% 2px;
  background-position: top left;
}
.you-head { margin-bottom: 16px; }
.you-head small { color: var(--dim); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; }
.you-body { display: flex; flex-direction: column; gap: 20px; }
.budget-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.budget-top small { color: var(--mute); font-size: 12px; font-weight: 600; }
.budget-top b { font: 700 20px var(--mono); color: var(--ink); }
.used small { color: var(--mute); font-size: 12px; }

.seg { display: inline-flex; gap: 2px; }
.seg button { border: 0; background: transparent; padding: 7px 12px; color: var(--dim); font-weight: 600; font-size: 12px; border-radius: 0; border-bottom: 2px solid transparent; }
.seg button:hover { color: var(--ink); background: transparent; }
.seg button.on { color: var(--ember); border-bottom-color: var(--ember); font-weight: 700; }

.cp-page input[type=range] { accent-color: var(--ember); width: 100%; height: 4px; background: var(--line); border-radius: 1px; cursor: pointer; }

.bar { height: 8px; border: 0; border-radius: 0; margin-top: 10px; overflow: hidden; background: repeating-linear-gradient(90deg, var(--line-light) 0 1px, transparent 1px 9px); }
.bar span { display: block; height: 100%; background: var(--ember); border-radius: 0; transition: width 0.4s ease; }

/* ── Main grid / tabs / tools ───────────────────────── */
.main { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 28px; align-items: start; }
.tabs { display: flex; gap: 4px; margin: 0 0 16px; border-bottom: 1px solid var(--line); }
.tabs button { padding: 9px 4px; font-size: 13px; font-weight: 600; color: var(--dim); border: 0; border-radius: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs button:hover { color: var(--ink); background: transparent; }
.tabs button.on { color: var(--ember); border-bottom-color: var(--ember); background: transparent; font-weight: 700; }

.tools { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.strategy-search { position:relative; flex:1; min-width:200px; display:flex; align-items:center; gap:10px; padding:5px 12px 5px 6px; color:var(--dim); background:var(--side); border:1px solid var(--line); border-radius:12px; box-shadow:inset 0 1px 0 rgba(255,255,255,.04); transition:border-color .18s ease, background .18s ease, box-shadow .18s ease; }
.strategy-search-button { width:34px; height:34px; flex:none; display:grid; place-items:center; padding:0; color:var(--ember); border:1px solid rgba(255,90,31,.2); border-radius:10px; background:var(--soft); transition:color .18s ease,background .18s ease,border-color .18s ease; }
.strategy-search-button:hover { color:#fff; border-color:var(--ember); background:var(--ember); }
.strategy-search-button svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; }
.strategy-search input[type=search] { flex:1; min-width:0; width:100%; padding:8px 0; color:var(--ink); background:transparent; border:0; outline:0; font:inherit; font-size:13px; }
.strategy-search input::placeholder { color:var(--dim); transition:color .2s ease; }
.strategy-search:hover { border-color:var(--line-light); box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 4px 14px rgba(0,0,0,.2); }
.strategy-search:focus-within { color:var(--ember); border-color:var(--ember); box-shadow:0 0 0 3px var(--ember-glow); }
.strategy-search:focus-within input::placeholder { color:var(--mute); }
html[data-theme="light"] .strategy-search { background:#fff; border-color:var(--line); box-shadow:inset 0 1px 0 #fff,0 3px 12px rgba(28,39,58,.06); }
html[data-theme="light"] .strategy-search-button { color:var(--ember); border-color:rgba(224,74,20,.2); background:var(--soft); box-shadow:none; }
html[data-theme="light"] .strategy-search-button:hover { color:#fff; border-color:var(--ember); background:var(--ember); }
html[data-theme="light"] .strategy-search:hover { background:#fff; border-color:var(--line-light); box-shadow:inset 0 1px 0 #fff,0 4px 14px rgba(28,39,58,.08); }
html[data-theme="light"] .strategy-search:focus-within { background:#fff; box-shadow:0 0 0 3px var(--ember-glow); }
@media (prefers-reduced-motion:reduce) { .strategy-search,.strategy-search-button { transition:none; } }
.tools select { background:var(--side); border:1px solid var(--line); border-radius:var(--radius-sm); color:var(--ink); font:inherit; padding:8px 14px; font-size:13px; transition:border-color .2s ease, background .2s ease, box-shadow .2s ease; }
.tools select:hover { border-color:var(--line-light); background:var(--p2); }
.tools select:focus { border-color:var(--ember); outline:none; box-shadow:0 0 0 3px var(--ember-glow); }
.tools option { background: var(--side); }

/* ── Trader cards ───────────────────────────────────── */
.card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 16px;
  align-items: center;
  padding: 16px 18px;
  background: var(--side);
  border: 1px solid var(--line);
  border-radius: 16px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.card:hover { border-color: var(--line-light); background: var(--p2); }
.card:focus-visible { outline: 2px solid var(--ember); outline-offset: 3px; }
.card.sel { border-color: var(--ember); background: var(--p2); box-shadow: inset 3px 0 0 var(--ember); }
.ava { width: 48px; height: 48px; border-radius: var(--radius-sm); display: grid; place-items: center; font: 600 20px var(--sans); color: #fff; }
.card h3 { font: 600 15px/1.3 var(--sans); letter-spacing: -0.01em; }
.card p { font-size: 12.5px; line-height: 1.5; color: var(--mute); margin-top: 3px; }
.badges { display: flex; gap: 14px; margin-top: 8px; flex-wrap: wrap; }
.b { font-size: 10.5px; font-weight: 700; padding: 0; border: 0; background: transparent; color: var(--mute); text-transform: uppercase; letter-spacing: 0.06em; display: inline-flex; align-items: center; gap: 6px; }
.b::before { content: ""; width: 5px; height: 5px; background: var(--dim); flex: none; }
.b.rec { color: var(--ember); }
.b.rec::before { background: var(--ember); }
.b.fol { color: var(--gain); }
.b.fol::before { background: var(--gain); }

.ring { width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(var(--c) calc(var(--m)*1%), var(--line) 0); padding: 3px; }
.ring span { width: 100%; height: 100%; border-radius: 50%; background: var(--bg); display: grid; place-items: center; font-weight: 600; font-size: 12.5px; font-family: var(--mono); }
.ringl { text-align: center; font-size: 10px; color: var(--dim); margin-top: 4px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--mono); }

/* ── Detail pane ────────────────────────────────────── */
.detail {
  position: sticky;
  top: 16px;
  background: var(--side);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 0;
  box-shadow: var(--shadow);
  background-image: linear-gradient(90deg, var(--ember) 44px, transparent 44px);
  background-repeat: no-repeat;
  background-size: 100% 2px;
  background-position: top left;
}
.detail.detail-reveal { animation: detailReveal .2s ease both; }
@keyframes detailReveal { from { opacity:0; } to { opacity:1; } }
.detail .dh { padding: 22px 24px 0; display: flex; gap: 16px; align-items: center; }
.detail .dh h2 { font-size: 19px; font-weight: 700; letter-spacing: -0.02em; }
.pane { padding: 0 24px 12px; }

.dtabs { display: flex; gap: 8px; margin: 20px 24px 16px; border-bottom: 1px solid var(--line); }
.dtabs button { border: 0; border-radius: 0; padding: 10px 14px; color: var(--mute); font-weight: 600; border-bottom: 2px solid transparent; margin-bottom: -1px; background: transparent; }
.dtabs button:hover { color: var(--ink); background: transparent; }
.dtabs button.on { color: var(--ink); border-bottom-color: var(--ember); font-weight: 700; }

.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-bottom: 20px; border: 1px solid var(--line); }
.facts div { padding: 10px 12px; border-left: 1px solid var(--line); }
.facts div:first-child { border-left: 0; }
.facts small { display: block; font-size: 10.5px; color: var(--dim); font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; }
.facts b { font-size: 13px; font-weight: 500; font-family: var(--mono); display: block; margin-top: 3px; }

.chart { width: 100%; height: 180px; display: block; margin-top: 10px; }
.view-trade-card { border:1px solid var(--line); border-radius:var(--radius-md); padding:20px; background:var(--p2); }
.view-trade-card h3 { font-size:16px; margin-bottom:6px; }
.view-trade-card p { color:var(--mute); font-size:13px; max-width:620px; }
.view-trade-card .trade-preview { margin:16px 0; border-left:3px solid var(--ember); padding:12px 14px; border-radius:0 var(--radius-sm) var(--radius-sm) 0; background:var(--soft); color:var(--ink); }
.view-trade-card .go { display:inline-flex; align-items:center; gap:8px; text-decoration:none; }
@media(max-width:650px) { .view-trade-card { padding:15px; } }
.big { display: flex; gap: 30px; flex-wrap: wrap; margin-top: 14px; }
.big small { display: block; color: var(--dim); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
.big b { font: 700 22px/1.2 var(--mono); }

.why li { list-style: none; padding: 6px 0 6px 26px; position: relative; font-size: 13px; }
.why li::before { content: "✓"; position: absolute; left: 0; color: var(--gain); font-weight: 800; }
.why li.no::before { content: "!"; color: var(--amber); }

.comm { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; border: 1px solid var(--line); }
.comm div { padding: 12px 14px; border-left: 1px solid var(--line); }
.comm div:first-child { border-left: 0; }
.comm b { font: 700 17px var(--mono); display: block; }
.comm small { color: var(--dim); font-size: 11px; }

.leave { display: grid; grid-template-columns: 150px 1fr 36px; gap: 10px; align-items: center; font-size: 12px; margin: 6px 0; }
.leave i { height: 5px; background: var(--amber); border-radius: 0; display: block; }

.cp-page blockquote { border-left: 2px solid var(--ember); background: var(--p2); padding: 10px 14px; border-radius: 0; margin: 10px 0; font-size: 13px; }
.cp-page blockquote small { display: block; color: var(--mute); margin-top: 4px; font-size: 11px; }

.foot { position: sticky; bottom: 0; background: var(--side); border-top: 1px solid var(--line); padding: 16px 24px 20px; margin-top: 16px; }
.foot .r { display: flex; justify-content: space-between; font-size: 12px; color: var(--mute); margin-bottom: 8px; }
.foot .r b { color: var(--ink); font-size: 16px; font-family: var(--mono); }

.da { margin-top: 14px; }
.da .go { display: block; width: 100%; }
.go { background: var(--ember); border-color: var(--ember); color: #140800; font-weight: 700; padding: 12px 18px; border-radius: var(--radius-sm); letter-spacing: 0; }
.go:hover { filter: brightness(1.08); border-color: var(--ember); }
.go:active:not(:disabled) { filter: brightness(.96); }
.go:disabled { opacity: .35; cursor: not-allowed; filter: none; background: var(--p3); border-color: var(--line); color: var(--dim); }
.go.stop { background: transparent; color: var(--loss); border-color: rgba(255, 77, 77, 0.45); }
.go.stop:hover { background: var(--loss-soft); filter: none; }

.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chips button { border-radius: var(--radius-sm); padding: 5px 12px; font-size: 12px; font-weight: 600; color: var(--mute); }
.chips button.on { border-color: var(--ember); color: var(--ember); background: transparent; }

.met { display: flex; gap: 18px; align-items: center; margin: 10px 0 4px; }
.met small { display: block; font-size: 10.5px; color: var(--dim); font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; }
.met b { font-size: 13px; font-weight: 500; font-family: var(--mono); }
.spk { width: 84px; height: 28px; margin-left: auto; }

.live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--gain); margin-right: 6px; box-shadow: 0 0 0 3px var(--gain-soft); }

/* ── History ────────────────────────────────────────── */
.history { margin-top: 36px; border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 24px; background-image: linear-gradient(90deg, var(--ember) 44px, transparent 44px); background-repeat: no-repeat; background-size: 100% 2px; background-position: top left; }
.hh { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.hh p { font-size: 13px; color: var(--mute); margin-top: 4px; }
.hs { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 0; margin: 20px 0; border: 1px solid var(--line); }
.st { padding: 14px; border-left: 1px solid var(--line); }
.st:first-child { border-left: 0; }
.st small { display: block; color: var(--dim); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; }
.st b { display: block; font-size: 19px; margin-top: 4px; font-weight: 600; font-family: var(--mono); }
.hc { position:relative; height:40px; display:flex; gap:4px; align-items:stretch; margin-top:10px; padding:0 1px; }
.hc::before { content:""; position:absolute; left:0; right:0; top:50%; height:1px; background:var(--line-light); opacity:.8; }
.hc .bar-slot { position:relative; z-index:1; flex:1; min-width:4px; height:100%; }
.hc .bar-slot i { position:absolute; left:0; right:0; bottom:50%; height:var(--bar-h); border-radius:4px 4px 0 0; background:var(--gain); opacity:.9; transform:scaleY(0); transform-origin:bottom; animation:barRise .48s cubic-bezier(.2,.8,.2,1) forwards; box-shadow:0 0 12px var(--gain-soft); }
.hc .bar-slot i.loss { top:50%; bottom:auto; border-radius:0 0 4px 4px; background:var(--loss); transform-origin:top; box-shadow:0 0 12px rgba(255,77,77,.18); }
@keyframes barRise { to { transform:scaleY(1); } }

.ht { overflow-x: auto; margin-top: 10px; }
.history table { width: 100%; border-collapse: collapse; min-width: 650px; font-family: var(--mono); }
.history th, .history td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
.history th { color: var(--dim); font-weight: 700; font-family: var(--sans); text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.07em; }
.history tr:hover td { background: rgba(255, 255, 255, 0.02); }
.note { font-size: 11px; color: var(--mute); margin-top: 14px; }

/* A follow whose expert has traded and whose copy has not caught up yet. */
.pending-tag { display: inline-block; margin-left: 8px; padding: 2px 8px; border: 1px solid rgba(240,180,77,.38); border-radius: 999px; background: rgba(240,180,77,.12); color: var(--amber); font: 700 10px/1.6 var(--sans); letter-spacing: .03em; white-space: nowrap; }

/* ── Copy activity: the charts and the cross-follow tape ── */
.activity { margin-top: 36px; border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 24px; background-image: linear-gradient(90deg, var(--ember) 44px, transparent 44px); background-repeat: no-repeat; background-size: 100% 2px; background-position: top left; }
.activity-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 16px; margin-top: 20px; }
.activity-panel { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--side); padding: 16px; }
.activity-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.activity-panel-head b { font-size: 13px; font-weight: 700; }
.activity-panel-head span { font-size: 11px; color: var(--dim); }
.activity-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.activity-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
.activity-legend span { font-size: 11px; color: var(--mute); font-family: var(--mono); }
.activity-empty { display: grid; place-items: center; min-height: 160px; text-align: center; color: var(--dim); font-size: 12px; line-height: 1.6; padding: 20px; }
.activity-marks { font-size: 11px; color: var(--dim); margin-top: 10px; }
.activity-marks b { color: var(--gain); font-weight: 700; }
.activity-marks b.sell { color: var(--loss); }
.activity table { width: 100%; border-collapse: collapse; min-width: 880px; font-family: var(--mono); }
.activity th, .activity td { text-align: left; padding: 11px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
.activity th { color: var(--dim); font-weight: 700; font-family: var(--sans); text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.07em; }
.activity td.r, .activity th.r { text-align: right; }
.activity tbody tr { transition: background .18s ease; }
.activity tbody tr:hover { background: color-mix(in srgb, var(--soft) 35%, transparent); }
.activity tbody tr:hover td { background: transparent; }
.activity-strategy { font-family: var(--sans); font-weight: 700; }
@media (max-width: 1100px) { .activity-grid { grid-template-columns: minmax(0, 1fr); } }

/* ── Ratings ────────────────────────────────────────── */
.stars { position: relative; display: inline-block; color: var(--line-light); letter-spacing: 2px; white-space: nowrap; }
.stars > span { position: absolute; left: 0; top: 0; overflow: hidden; color: var(--amber); }
.rt { font-size: 12px; color: var(--mute); }
.rt b { color: var(--ink); font-family: var(--mono); }
.rsum { display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: center; margin-bottom: 18px; }
.rsum > div:first-child { text-align: center; }
.rsum .n { font: 700 26px/1.15 var(--mono); }
.dist div { display: grid; grid-template-columns: 14px 1fr 34px; gap: 8px; align-items: center; font-size: 11px; color: var(--mute); margin: 4px 0; }
.dist em { height: 5px; background: var(--p3); border-radius: 0; overflow: hidden; display: block; }
.dist i { display: block; height: 100%; width: 0; background: var(--amber); transition: width 0.7s ease; }
.rate { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 16px; margin-bottom: 18px; }
.rate h4 { margin-bottom: 8px !important; font-size: 13px; }
.pick { display: flex; gap: 4px; align-items: center; }
.pick button { border: 0; padding: 0 2px; font-size: 28px; line-height: 1; color: var(--line-light); transition: transform .12s, color .12s; background: transparent; }
.pick button.on { color: var(--amber); }
.pick button:hover { transform: scale(1.2); background: transparent; }
.pick.rating{flex-direction:row-reverse;justify-content:flex-end;gap:.3rem;--stroke:#666;--fill:#ffc73a}
.pick.rating button{display:grid;place-items:center;padding:0;width:2rem;height:2rem;color:var(--stroke)}
.pick.rating button:focus-visible{outline:2px solid var(--amber);outline-offset:3px;border-radius:5px}
.pick.rating button svg{width:2rem;height:2rem;overflow:visible;fill:transparent;stroke:var(--stroke);stroke-width:1.35;stroke-linejoin:bevel;stroke-dasharray:12;animation:rating-idle 4s linear infinite;transition:stroke .2s,fill .5s}
.pick.rating button:hover svg,.pick.rating button:hover~button svg{stroke:var(--fill)}
.pick.rating button.on svg{fill:var(--fill);stroke:var(--fill);stroke-opacity:0;stroke-dasharray:0;stroke-linejoin:miter;stroke-width:8px}
.pick.rating.pop button.on svg{animation:rating-idle 4s linear infinite,rating-yippee 2s cubic-bezier(.2,.8,.2,1) backwards;animation-delay:0s,calc(var(--star-step,0)*2s)}
@keyframes rating-idle{from{stroke-dashoffset:24}}
@keyframes rating-yippee{0%{transform:scale(1);fill:var(--fill);fill-opacity:0;stroke-opacity:1;stroke:var(--stroke);stroke-dasharray:10;stroke-width:1px;stroke-linejoin:bevel}30%{transform:scale(0);fill:var(--fill);fill-opacity:0;stroke-opacity:1;stroke:var(--stroke);stroke-dasharray:10;stroke-width:1px;stroke-linejoin:bevel}30.1%{stroke:var(--fill);stroke-dasharray:0;stroke-linejoin:miter;stroke-width:8px}60%,100%{transform:scale(1.12);fill:var(--fill);fill-opacity:1;stroke-opacity:0}}
.rate textarea { width: 100%; margin-top: 10px; background: transparent; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink); font: inherit; padding: 10px; resize: vertical; min-height: 64px; }
.rate .go { margin-top: 10px; padding: 8px 16px; font-size: 12px; }

/* ── Modal & toast ──────────────────────────────────── */
.modal { position: fixed; inset: 0; background: rgba(4, 5, 8, 0.8); backdrop-filter: blur(3px); display: grid; place-items: center; z-index: 50; padding: 16px; }
.modal[hidden] { display: none; }
.sheet { background: var(--side); border: 1px solid var(--line-light); border-radius: var(--radius-lg); padding: 28px; width: min(460px, 100%); box-shadow: var(--shadow); background-image: linear-gradient(90deg, var(--ember) 44px, transparent 44px); background-repeat: no-repeat; background-size: 100% 2px; background-position: top left; }
.sheet h3 { font: 800 21px var(--sans); margin-bottom: 16px; }
.sheet .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.sheet .row b { font-family: var(--mono); }
.ck { display: flex; gap: 12px; margin: 20px 0; font-size: 12px; color: var(--mute); align-items: flex-start; }
.ck input { accent-color: var(--ember); margin-top: 3px; }
.mact { display: flex; gap: 12px; justify-content: flex-end; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translate(-50%, 20px); background: var(--side); border: 1px solid var(--line-light); border-left: 2px solid var(--ember); color: var(--ink); padding: 12px 22px; border-radius: var(--radius-sm); font-weight: 700; opacity: 0; transition: .25s; pointer-events: none; z-index: 60; box-shadow: var(--shadow); }
.toast.on { opacity: 1; transform: translate(-50%, 0); }

/* ── Responsive ─────────────────────────────────────── */
@media(max-width:1100px) { .main { grid-template-columns: 1fr; } .detail { position: static; max-height: none; } }
@media(min-width:901px) {
  .app, .content { transition:grid-template-columns .45s cubic-bezier(.42,0,.33,1), padding .45s cubic-bezier(.42,0,.33,1); }
  .app.off { grid-template-columns:0 minmax(0,1fr); }
  .app.off .side { position:fixed; left:50%; top:14px; bottom:auto; width:auto; height:auto; max-width:calc(100vw - 20px); transform:translateX(-50%); flex-direction:row; align-items:center; gap:4px; padding:6px 8px; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; background:var(--side); border:1px solid var(--line); border-radius:14px; box-shadow:0 18px 42px -18px rgba(0,0,0,.42); }
  .app.off .side::-webkit-scrollbar { display:none; }
  .app.off .brand { flex:none; padding:0 4px; border:0; }
  .app.off .brand-name { display:none; }
  .app.off .brand .brand-logo { width:30px;height:30px; }
  .app.off .side nav { flex-direction:row; align-items:center; gap:2px; }
  .app.off .side nav .grp, .app.off .side .sp, .app.off .side .me { display:none; }
  .app.off .side nav a { width:auto; min-width:42px; min-height:40px; justify-content:center; gap:0; margin:0; padding:8px 10px; border:0; border-radius:9px; overflow:hidden; }
  .app.off .side nav a .nav-label { max-width:0; opacity:0; overflow:hidden; white-space:nowrap; transform:translateX(-5px); transition:max-width .32s cubic-bezier(.42,0,.33,1), opacity .22s ease, transform .32s ease, margin .32s ease; }
  .app.off .side nav a:hover .nav-label, .app.off .side nav a:focus-visible .nav-label { max-width:135px; opacity:1; transform:none; margin-left:8px; }
  .app.off .content { grid-column:1/-1; padding-top:96px; }
}
@media(max-width:900px) {
  .app { grid-template-columns: 1fr; }
  .content { grid-column: 1; }
  .side { position: fixed; left: 0; top: 0; width: min(280px, calc(100vw - 48px)); transform: translateX(-105%); transition: transform .38s cubic-bezier(.2,.8,.2,1); border-radius:0 18px 18px 0; box-shadow:none; }
  .side.open { transform: none; box-shadow:16px 0 50px -30px rgba(0,0,0,.7); }
  .side-menu { display:none; }
  .scrim.open { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); z-index: 10; backdrop-filter: blur(2px); }
  .mobile-menu { display:inline-flex; }
  .content { padding: 0 18px 36px; }
  h1 { font-size: 26px; }
  .kpi { grid-template-columns: 1fr 1fr; }
  .hs { grid-template-columns: 1fr; }
  .hs .st { border-left: 0; border-top: 1px solid var(--line); }
  .hs .st:first-child { border-top: 0; }
}
@media(max-width:560px){.kpi-head{align-items:flex-start}.kpi{grid-template-columns:1fr}.kpi-card{padding:15px}.kpi b{font-size:22px}}

/* ========================================================
   Trading Buddy — floating chat widget (sharp, no bubbles)
   ======================================================== */
.cfab {
  position: fixed; right: 22px; bottom: 22px; z-index: 70;
  width: 56px; height: 56px; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer;
  background: var(--ember); border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 10px 28px -12px rgba(255, 90, 31, .6);
  transition: background .18s ease, border-color .18s ease;
}
.cfab:hover { background: #e04a14; }
.cfab svg { width: 26px; height: 26px; fill: none; stroke: #140800; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.cfab .cdot { position: absolute; top: 3px; right: 3px; width: 11px; height: 11px; border-radius: 50%; background: var(--gain); border: 2px solid var(--bg); }

.cchat {
  position: fixed; right: 22px; bottom: 86px; z-index: 71;
  width: 370px; max-width: calc(100vw - 32px);
  height: 540px; max-height: calc(100vh - 130px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--side); border: 1px solid var(--line-light);
  border-radius: var(--radius-lg); box-shadow: 0 24px 60px rgba(0, 0, 0, .6);
  transform: translateY(8px); opacity: 0; visibility: hidden;
  transition: transform .2s ease, opacity .2s ease, visibility .2s;
}
.cchat[hidden] { display: none; }
.cchat.on { transform: none; opacity: 1; visibility: visible; }

.cch { display: flex; align-items: center; gap: 10px; padding: 13px 14px; border-bottom: 1px solid var(--line); background: transparent; }
.cch .av { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background:var(--soft); border:1px solid var(--ember); color:var(--ember); flex: none; }
.cch .av svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.cch .ti { flex: 1; min-width: 0; }
.cch .ti b { display: block; font-size: 13.5px; }
.cch .ti small { color: var(--gain); font-size: 11px; display: flex; align-items: center; gap: 5px; }
.cch .ti small::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--gain); }
.cch button { background: none; border: 0; color: var(--mute); cursor: pointer; font-size: 20px; line-height: 1; padding: 4px 6px; border-radius: var(--radius-sm); transition: color .2s, background .2s; }
.cch button:hover { color: var(--ink); background: var(--p2); }

.cbody { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; }
.msg { max-width: 84%; padding: 9px 12px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; animation: msgIn .18s ease backwards; }
@keyframes msgIn { from { opacity: 0; } to { opacity: 1; } }
.msg.bot { align-self: flex-start; background: var(--p2); border: 1px solid var(--line); color: var(--ink); }
.msg.me { align-self: flex-end; background: var(--ember); color: #140800; font-weight: 600; }
.msg.typing span { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: var(--mute); margin-right: 3px; animation: dot 1.1s infinite; }
.msg.typing span:nth-child(2) { animation-delay: .15s; }
.msg.typing span:nth-child(3) { animation-delay: .3s; margin-right: 0; }
@keyframes dot { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

.cchips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; }
.cchips button { background: transparent; border: 1px solid var(--line); color: var(--mute); border-radius: var(--radius-sm); padding: 5px 11px; font-size: 11.5px; cursor: pointer; transition: color .18s, border-color .18s; }
.cchips button:hover { color: var(--ember); border-color: var(--ember); background: transparent; }

.cin { display: flex; gap: 8px; padding: 11px 12px; border-top: 1px solid var(--line); background: transparent; }
.cin input { flex: 1; min-width: 0; background: transparent; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 9px 14px; color: var(--ink); font: inherit; font-size: 13px; outline: none; transition: border-color .2s; }
.cin input::placeholder { color: var(--dim); }
.cin input:focus { border-color: var(--ember); }
.cin button { width: 38px; height: 38px; border-radius: var(--radius-sm); border: 0; background: var(--ember); color: #140800; display: grid; place-items: center; cursor: pointer; flex: none; transition: filter .2s; }
.cin button:hover { filter: brightness(1.08); }
.cin button:disabled { opacity: .4; cursor: not-allowed; }
.cin button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

@media (max-width: 560px) {
  .cchat { right: 12px; left: 12px; width: auto; bottom: 84px; height: min(70vh, 480px); }
  .cfab { right: 16px; bottom: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
  .pick.rating.pop button.on svg { animation:none; }
  html.theme-reveal::view-transition-new(root) { animation:none; }
  .cfab { animation: none; }
  .msg { animation: none; }
  .cchat { transition: opacity .2s ease; }
}

html[data-theme="light"] .name-highlight{display:inline;background:none;padding:0;box-shadow:none}html[data-theme="light"] .name-first{color:#fff;background:#18212e;padding:.04em .16em .08em;border-radius:.18em;box-shadow:0 2px 7px rgba(18,28,43,.14)}html[data-theme="light"] .name-last{color:#f47719}html[data-theme="dark"] .name-highlight{background:none;padding:0;box-shadow:none}html[data-theme="dark"] .name-first{color:var(--ink);background:none;padding:0;box-shadow:none}html[data-theme="dark"] .name-last{color:var(--gold,var(--ember,#ff6a1a))}
/* ── Interaction pass: quiet affordances ──────────────
   The reference moved things. A desk that trades should not: hover changes a
   border or a colour, never a position, a rotation or a glow. */
.you { transition:border-color .18s ease,box-shadow .18s ease,background .18s ease; }
.you:hover { border-color:color-mix(in srgb,var(--ember) 24%,var(--line)); }
.you-head small { transition:color .18s ease; }
.seg button { position:relative; transition:color .18s ease,background .18s ease; }
.seg button:hover { color:var(--ember); }
.seg button.on { box-shadow:inset 0 -2px 0 var(--ember); }
.seg button.on:hover { color:var(--ember); }
.budget-top b { transition:color .18s ease; }
.budget:focus-within .budget-top b { color:var(--ember); }
.budget input[type=range] { cursor:ew-resize; }
.budget input[type=range]::-webkit-slider-thumb { transition:box-shadow .18s ease; }
.budget input[type=range]:hover::-webkit-slider-thumb,.budget input[type=range]:focus-visible::-webkit-slider-thumb { box-shadow:0 0 0 6px var(--ember-glow); }
.budget input[type=range]::-moz-range-thumb { transition:box-shadow .18s ease; }
.budget input[type=range]:hover::-moz-range-thumb,.budget input[type=range]:focus-visible::-moz-range-thumb { box-shadow:0 0 0 6px var(--ember-glow); }
.tools select:focus-visible { outline:0;border-color:var(--ember);box-shadow:0 0 0 3px var(--ember-glow); }
.tabs button { transition:color .18s ease,border-color .18s ease; }
.card { position:relative; }
.card .ava { transition:background .18s ease; }
.ring { transition:filter .18s ease; }
.detail { transition:border-color .18s ease,box-shadow .18s ease; }
.detail:hover { border-color:var(--line-light); }
.dtabs button { transition:color .18s ease,border-color .18s ease; }
.facts div,.comm div { transition:background .18s ease; }
.rate { transition:border-color .18s ease,box-shadow .18s ease; }
.rate:hover,.rate:focus-within { border-color:var(--line-light); }
.rate textarea { transition:border-color .18s ease,box-shadow .18s ease,background .18s ease; }
.rate textarea:hover { border-color:var(--line-light); }
.rate textarea:focus { outline:0;border-color:var(--ember);box-shadow:0 0 0 3px var(--ember-glow); }
.history { transition:border-color .18s ease,box-shadow .18s ease; }
.history:hover { border-color:var(--line-light); }
.st { transition:background .18s ease; }
.st b { transition:color .18s ease; }
.hc .bar-slot { cursor:crosshair; }
.hc .bar-slot i { transition:filter .18s ease; }
.hc .bar-slot:hover i { filter:brightness(1.22); }
.history tbody tr { transition:background .18s ease; }
.history tbody tr:hover { background:color-mix(in srgb,var(--soft) 35%,transparent); }
.history tbody tr:hover td { background:transparent; }
.history tbody tr td { transition:color .18s ease,border-color .18s ease; }
.go { transition:box-shadow .18s ease,filter .18s ease; }
.go:hover:not(:disabled) { box-shadow:0 8px 20px -14px var(--ember); }
@media(prefers-reduced-motion:reduce){
 .you,.seg button,.budget-top b,.budget input[type=range]::-webkit-slider-thumb,.budget input[type=range]::-moz-range-thumb,.tabs button,.card .ava,.ring,.detail,.dtabs button,.facts div,.comm div,.facts b,.comm b,.rate,.rate textarea,.history,.st,.st b,.hc .bar-slot i,.history tbody tr,.history tbody tr td,.go { transition:none!important; }
}
`;
