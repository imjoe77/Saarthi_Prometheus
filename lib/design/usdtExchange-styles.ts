/**
 * USDT exchange styling — ported from the Ansar "INR–USDT Exchange" design and
 * scoped to `.ux-page`.
 *
 * Every selector is rooted at the page container on purpose. This stylesheet is
 * injected unlayered, and unlayered rules outrank Tailwind's `@layer utilities`
 * regardless of specificity, so a bare `*`/`button`/`table` rule here would
 * silently strip the AppShell's spacing and button styles.
 */
export const usdtExchangeStyles = `
.ux-page{
  --panel:rgba(24,26,31,.92);
  --panel-hi:rgba(32,35,42,.98);
  --panel-2:#14161b;
  --line:rgba(255,255,255,.06);
  --line-2:rgba(255,255,255,.1);
  --tx:#ffffff;
  --tx-2:#b3b3b3;
  --mut:#71798a;
  --acc:#ff5a1f;
  --acc-2:#ff8a3d;
  --amber:#ffaa00;
  --up:#00d26a;
  --down:#ff4d6d;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  padding:24px;
  max-width:1440px;
  margin:0 auto;
  color:var(--tx);
  font-variant-numeric:tabular-nums;
  color-scheme:dark;
}
.ux-page *,.ux-page *::before,.ux-page *::after{box-sizing:border-box}

/* ── header ───────────────────────────────────────────────── */
.ux-head{display:block}
.ux-head-main{min-width:0}
.ux-eyebrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:7px}
.ux-eyebrow b{color:var(--acc);font-weight:700}
.ux-eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--up);box-shadow:0 0 9px var(--up)}
.ux-title{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:0}
.ux-sub{margin-top:7px;font-size:12.5px;line-height:1.65;color:var(--mut);max-width:72ch}

/* ── ticker strip ─────────────────────────────────────────── */
.ux-ticker{display:flex;align-items:stretch;gap:0;margin-top:16px;width:100%;border:1px solid var(--line);border-radius:14px;background:var(--panel);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);overflow:hidden;flex-wrap:wrap}
.ux-tick{flex:1 1 0;padding:10px 15px;min-width:112px;overflow:hidden;border-right:1px solid var(--line);display:flex;flex-direction:column;justify-content:center;gap:3px}
.ux-tick:last-child{border-right:0}
.ux-tick-k{font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.ux-tick-v{font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:-.01em;white-space:nowrap}
.ux-tick-v.acc{color:var(--acc-2);font-size:16px}
.ux-tick-v.small{font-size:10.5px;font-weight:600;color:var(--tx-2)}
.ux-tick-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:99px;border:1px solid;font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-top:2px;width:max-content}
.ux-tick-badge.live{color:var(--up);border-color:rgba(0,210,106,.32);background:rgba(0,210,106,.1)}
.ux-tick-badge.fallback{color:var(--amber);border-color:rgba(255,170,0,.32);background:rgba(255,170,0,.1)}
.ux-tick-badge.busy{color:var(--mut);border-color:var(--line-2);background:rgba(255,255,255,.04)}

/* ── buttons ──────────────────────────────────────────────── */
.ux-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 15px;border-radius:10px;border:1px solid var(--line-2);background:transparent;color:var(--tx);font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;transition:border-color .2s ease,color .2s ease,background .2s ease,box-shadow .2s ease}
.ux-btn:hover{border-color:rgba(255,90,31,.5);background:rgba(255,90,31,.08);color:#fff}
.ux-btn:disabled{opacity:.42;cursor:not-allowed}
.ux-btn.primary{background:linear-gradient(135deg,#ff5a1f,#ff8a3d);border-color:transparent;color:#170800;box-shadow:0 10px 28px rgba(255,90,31,.26)}
.ux-btn.primary:hover{box-shadow:0 14px 34px rgba(255,90,31,.36);color:#170800}
.ux-btn.ghost{background:rgba(255,255,255,.04)}
.ux-btn.sm{padding:6px 11px;font-size:11px;border-radius:8px}
.ux-btn.wide{width:100%;padding:13px 16px;font-size:13px;font-weight:700;border-radius:11px}
.ux-btn.buy{background:linear-gradient(135deg,#00b45c,#00d26a);border-color:transparent;color:#001a0c;box-shadow:0 10px 26px rgba(0,210,106,.22)}
.ux-btn.sell{background:linear-gradient(135deg,#ff5a1f,#ff8a3d);border-color:transparent;color:#170800;box-shadow:0 10px 26px rgba(255,90,31,.26)}
.ux-btn.buy:hover,.ux-btn.sell:hover{filter:brightness(1.06)}
.ux-icon-btn{padding:8px;border-radius:9px;border:1px solid var(--line-2);background:rgba(255,255,255,.03);color:var(--tx-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s ease}
.ux-icon-btn:hover{border-color:rgba(255,90,31,.5);color:#fff}
.ux-link{color:var(--acc);text-decoration:none;font-weight:600}
.ux-link:hover{text-decoration:underline;text-underline-offset:2px}

/* ── cards & layout ───────────────────────────────────────── */
.ux-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.ux-top{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:20px;margin-top:20px;align-items:start}
.ux-col{display:flex;flex-direction:column;gap:20px;min-width:0}
.ux-bottom{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px;margin-top:20px;align-items:start}
.ux-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.ux-card-title{font-size:13px;font-weight:700;letter-spacing:-.005em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ux-card-title .badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:99px;border:1px solid var(--line-2);background:rgba(255,255,255,.04);color:var(--mut);font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.ux-card-sub{font-size:10.5px;color:var(--mut);margin-top:3px;line-height:1.55}
.ux-pad{padding:20px}

/* ── settlement path ──────────────────────────────────────── */
.ux-steps{display:flex;flex-direction:column;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:11px;overflow:hidden;margin-top:12px}
.ux-step{display:flex;gap:12px;align-items:flex-start;background:var(--panel-2);padding:11px 13px}
.ux-step-n{font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.06em;color:var(--acc);border:1px solid rgba(255,90,31,.3);background:rgba(255,90,31,.09);border-radius:6px;padding:2px 5px;flex:none;margin-top:1px}
.ux-step b{display:block;font-size:11.5px;font-weight:700;color:var(--tx)}
.ux-step p{margin:2px 0 0;font-size:10.5px;line-height:1.6;color:var(--mut)}
.ux-steps-note{margin:10px 0 0;font-family:var(--mono);font-size:9.5px;line-height:1.6;color:var(--mut)}

/* ── price provenance ─────────────────────────────────────── */
.ux-price{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.ux-price-v{font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1.15}
.ux-price-v .cur{color:var(--acc);margin-right:1px}
.ux-price-unit{font-family:var(--mono);font-size:10px;color:var(--mut);padding-bottom:5px}
.ux-price-side{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:99px;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;border:1px solid;margin-bottom:6px}
.ux-price-side.buy{color:var(--up);border-color:rgba(0,210,106,.32);background:rgba(0,210,106,.1)}
.ux-price-side.sell{color:var(--acc);border-color:rgba(255,90,31,.36);background:rgba(255,90,31,.1)}
.ux-price-note{font-size:11px;line-height:1.6;color:var(--mut);max-width:70ch}
.ux-venue-list{display:flex;flex-direction:column;gap:11px;margin-top:18px}
.ux-venue{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:baseline}
.ux-venue-name{font-size:11.5px;font-weight:600;color:var(--tx-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ux-venue-name .tag{font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--acc);border:1px solid rgba(255,90,31,.32);background:rgba(255,90,31,.1);padding:1px 5px;border-radius:99px;margin-left:6px}
.ux-venue-price{font-family:var(--mono);font-size:12px;font-weight:700;text-align:right;white-space:nowrap}
.ux-venue-track{grid-column:1 / -1;height:5px;border-radius:99px;background:rgba(255,255,255,.06);overflow:hidden}
.ux-venue-fill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,rgba(255,90,31,.55),#ff8a3d);transition:width .5s cubic-bezier(.22,1,.36,1)}
.ux-venue.self .ux-venue-name{color:#fff}
.ux-venue.self .ux-venue-fill{background:linear-gradient(90deg,#ff5a1f,#ffb27d)}
.ux-venue-meta{grid-column:1 / -1;font-family:var(--mono);font-size:9px;color:var(--mut)}
.ux-price-foot{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line);font-family:var(--mono);font-size:10px;color:var(--mut)}
.ux-price-foot b{color:var(--tx-2);font-weight:600}
.ux-savings{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding:10px 13px;border-radius:11px;border:1px solid var(--line);background:rgba(255,255,255,.03);font-size:11px}
.ux-savings span{color:var(--mut)}
.ux-savings b{font-family:var(--mono);font-size:13px;font-weight:700}
.ux-savings b.up{color:var(--up)}
.ux-savings b.down{color:var(--down)}

/* ── order ticket ─────────────────────────────────────────── */
.ux-ticket{position:sticky;top:18px;overflow:hidden}
.ux-ticket-head{padding:16px 18px 0}
.ux-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:11px;background:#101318;border:1px solid var(--line)}
.ux-tab{padding:9px 8px;border-radius:8px;border:0;background:transparent;color:var(--mut);font:inherit;font-size:11px;font-weight:700;letter-spacing:.02em;cursor:pointer;transition:all .2s ease;white-space:nowrap}
.ux-tab:hover{color:var(--tx)}
.ux-tab.on-buy{background:linear-gradient(135deg,#00b45c,#00d26a);color:#001a0c;box-shadow:0 6px 18px rgba(0,210,106,.22)}
.ux-tab.on-sell{background:linear-gradient(135deg,#ff5a1f,#ff8a3d);color:#170800;box-shadow:0 6px 18px rgba(255,90,31,.24)}
.ux-ticket-body{padding:16px 18px 18px}
.ux-balances{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;padding:10px 12px;border-radius:11px;border:1px solid var(--line);background:rgba(255,255,255,.025)}
.ux-balance-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px}
.ux-balance-row span{color:var(--mut)}
.ux-balance-row b{font-family:var(--mono);font-size:11.5px;font-weight:600}
.ux-balance-row b.muted{color:var(--mut);font-weight:500}
.ux-balance-row b.down{color:var(--down)}
.ux-balance-row b.up{color:var(--up)}
.ux-field-k{display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.ux-field-k .hint{font-weight:500;letter-spacing:.02em;text-transform:none;font-size:9.5px;color:#5b6472}
.ux-input-wrap{position:relative;display:flex;align-items:center}
.ux-input{width:100%;background:#101318;border:1px solid var(--line-2);border-radius:10px;color:var(--tx);font:inherit;font-family:var(--mono);font-size:19px;font-weight:700;padding:11px 62px 11px 13px;transition:border-color .2s ease,box-shadow .2s ease}
.ux-input::placeholder{color:#4c5563;font-weight:500}
.ux-input:focus{outline:none;border-color:rgba(255,90,31,.6);box-shadow:0 0 0 3px rgba(255,90,31,.14)}
.ux-input:disabled{opacity:.5}
.ux-input-suffix{position:absolute;right:13px;font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--mut);pointer-events:none}
.ux-presets{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}
.ux-preset{padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--tx-2);font-family:var(--mono);font-size:9.5px;font-weight:700;cursor:pointer;transition:all .2s ease}
.ux-preset:hover{border-color:rgba(255,90,31,.45);color:#fff}
.ux-preset:disabled{opacity:.4;cursor:not-allowed}
.ux-preset-note{font-family:var(--mono);font-size:9px;color:#5b6472;align-self:center}
.ux-swap{display:flex;align-items:center;justify-content:center;gap:10px;margin:13px 0}
.ux-swap-btn{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(255,90,31,.12);border:1px solid rgba(255,90,31,.34);color:var(--acc);flex:none}
.ux-swap-rate{font-family:var(--mono);font-size:10.5px;color:var(--mut)}
.ux-swap-rate b{color:var(--tx-2);font-weight:600}
.ux-readout{display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(0,210,106,.05);border:1px solid rgba(0,210,106,.2);border-radius:10px;padding:11px 13px;font-family:var(--mono)}
.ux-readout-k{font-family:inherit;font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--mut)}
.ux-readout-v{font-size:19px;font-weight:700;color:var(--up);letter-spacing:-.02em;white-space:nowrap}
.ux-summary{margin-top:13px;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.025);padding:11px 13px;display:flex;flex-direction:column;gap:7px}
.ux-summary-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:11px}
.ux-summary-row span{color:var(--mut);white-space:nowrap}
.ux-summary-row b{font-family:var(--mono);font-size:11px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.ux-summary-row b .hint{display:block;margin-top:2px;font-family:var(--mono);font-size:8.5px;font-weight:500;letter-spacing:.01em;color:var(--mut);text-transform:none}
.ux-summary-row b.up{color:var(--up)}
.ux-summary-row b.down{color:var(--down)}
.ux-summary-row.total{border-top:1px solid var(--line);padding-top:8px;margin-top:1px}
.ux-summary-row.total span{color:var(--tx);font-weight:600}
.ux-summary-row.total b{font-size:13px;font-weight:700}
.ux-guard{margin-top:13px}
.ux-guard .ux-input{font-size:13px;padding:8px 11px;font-weight:600}
.ux-guard-note{font-family:var(--mono);font-size:9px;line-height:1.55;color:var(--mut);margin-top:5px}
.ux-error{display:flex;gap:7px;align-items:flex-start;margin-top:9px;font-size:10.5px;line-height:1.55;color:#ff9c7f;font-family:var(--mono)}
.ux-error.warn{color:var(--amber)}
.ux-error svg{flex:none;margin-top:1px}
.ux-ticket-actions{margin-top:15px;display:flex;flex-direction:column;gap:8px}
.ux-ticket-note{font-family:var(--mono);font-size:9px;line-height:1.6;color:var(--mut);margin:0;text-align:center}
.ux-ticket-sep{height:1px;background:var(--line);margin:14px 0}

/* ── tables ───────────────────────────────────────────────── */
.ux-table-wrap{overflow-x:auto}
.ux-table{width:100%;border-collapse:collapse;min-width:560px}
.ux-table th{text-align:left;font-family:var(--mono);font-size:9px;letter-spacing:.11em;text-transform:uppercase;color:var(--mut);font-weight:600;padding:0 12px 9px 0;border-bottom:1px solid var(--line);white-space:nowrap}
.ux-table td{padding:10px 12px 10px 0;border-bottom:1px solid rgba(255,255,255,.045);font-size:11.5px;vertical-align:middle}
.ux-table tbody tr:last-child td{border-bottom:0}
.ux-table tbody tr:hover td{background:rgba(255,255,255,.02)}
.ux-table .num{font-family:var(--mono);text-align:right;white-space:nowrap}
.ux-table .mono{font-family:var(--mono)}
.ux-table .dim{color:var(--mut)}
.ux-table .strong{font-weight:700}
.ux-side{display:inline-flex;align-items:center;padding:2px 7px;border-radius:99px;font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.08em;border:1px solid}
.ux-side.buy{color:var(--up);border-color:rgba(0,210,106,.32);background:rgba(0,210,106,.1)}
.ux-side.sell{color:var(--acc);border-color:rgba(255,90,31,.36);background:rgba(255,90,31,.1)}
.ux-table-note{margin-top:10px;font-family:var(--mono);font-size:9.5px;line-height:1.6;color:var(--mut)}
.ux-empty{padding:26px 18px;text-align:center;color:var(--mut);font-size:12px;border:1px dashed var(--line-2);border-radius:12px;background:rgba(255,255,255,.015);line-height:1.65}
.ux-more{display:flex;justify-content:center;margin-top:13px}

/* ── pricing status card ──────────────────────────────────── */
.ux-status-list{display:flex;flex-direction:column;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:11px;overflow:hidden}
.ux-status-row{background:var(--panel-2);padding:9px 12px;display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:10.5px}
.ux-status-row span{color:var(--mut);white-space:nowrap}
.ux-status-row b{font-family:var(--mono);font-size:10.5px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.ux-status-row b.up{color:var(--up)}
.ux-status-row b.amber{color:var(--amber)}
.ux-reasons{margin:10px 0 0;padding:0 0 0 15px;font-family:var(--mono);font-size:9px;line-height:1.65;color:var(--mut)}
.ux-fees{margin-top:11px;padding-top:10px;border-top:1px solid var(--line);font-size:10px;line-height:1.6;color:var(--mut)}

/* ── banners ──────────────────────────────────────────────── */
.ux-banner{display:flex;gap:12px;align-items:flex-start;border-radius:12px;padding:13px 15px;font-size:11.5px;line-height:1.6;margin-top:16px}
.ux-banner svg{flex:none;margin-top:1px}
.ux-banner .body{flex:1;min-width:0}
.ux-banner b{display:block;color:#fff;font-size:12px;margin-bottom:2px}
.ux-banner .dismiss{margin-left:auto}
.ux-banner.ok{border:1px solid rgba(0,210,106,.35);background:rgba(0,210,106,.07);color:#b9f5d3}
.ux-banner.ok svg{color:var(--up)}
.ux-banner.warn{border:1px solid rgba(255,170,0,.35);background:rgba(255,170,0,.07);color:#ffe0a3}
.ux-banner.warn svg{color:var(--amber)}
.ux-banner.bad{border:1px solid rgba(255,90,31,.35);background:rgba(255,90,31,.07);color:#ffd3c2}
.ux-banner.bad svg{color:var(--acc)}
.ux-banner .mini{font-family:var(--mono);font-size:9.5px;color:var(--mut);margin-top:5px;line-height:1.6}
.ux-banner ul{margin:4px 0 0;padding-left:16px;font-family:var(--mono);font-size:9.5px;color:var(--mut);line-height:1.65}

/* ── modal ────────────────────────────────────────────────── */
.ux-overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(4,5,7,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);--panel:rgba(24,26,31,.92);--panel-hi:rgba(32,35,42,.98);--panel-2:#14161b;--line:rgba(255,255,255,.06);--line-2:rgba(255,255,255,.1);--tx:#ffffff;--tx-2:#b3b3b3;--mut:#71798a;--acc:#ff5a1f;--acc-2:#ff8a3d;--amber:#ffaa00;--up:#00d26a;--down:#ff4d6d;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.ux-modal{width:100%;max-width:480px;max-height:calc(100vh - 40px);overflow-y:auto;background:#15181e;border:1px solid rgba(255,90,31,.34);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.ux-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 0}
.ux-modal-title{font-size:16px;font-weight:800;letter-spacing:-.015em;margin:0}
.ux-modal-sub{font-size:10.5px;color:var(--mut);margin-top:3px}
.ux-modal-body{padding:15px 20px 20px}
.ux-modal-callout{border:1px solid rgba(255,170,0,.28);background:rgba(255,170,0,.06);border-radius:10px;padding:11px 13px;font-size:11px;line-height:1.65;color:#ffe0a3;margin-bottom:14px}
.ux-modal-callout b{color:#fff}
.ux-modal-rows{display:flex;flex-direction:column;gap:8px;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.025);padding:12px 14px}
.ux-modal-rows .ux-summary-row{font-size:11.5px}
.ux-modal-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.ux-modal-actions .ux-btn{flex:1;min-width:130px}
.ux-modal-failure{margin-top:12px;border:1px solid rgba(255,90,31,.35);background:rgba(255,90,31,.08);border-radius:10px;padding:11px 13px}
.ux-modal-failure b{display:block;font-size:11.5px;color:#ff9c7f}
.ux-modal-failure p{font-size:10.5px;color:var(--tx-2);line-height:1.6;margin:3px 0 0}
.ux-modal-failure ul{margin:5px 0 0;padding-left:16px;font-family:var(--mono);font-size:9.5px;color:var(--mut);line-height:1.65}

/* ── misc ─────────────────────────────────────────────────── */
.ux-spin{animation:uxSpin 1s linear infinite}
@keyframes uxSpin{to{transform:rotate(360deg)}}
.ux-loading{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--mut)}
.ux-foot{margin-top:20px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.02);padding:16px 18px;display:flex;gap:12px;align-items:flex-start}
.ux-foot svg{flex:none;margin-top:2px;color:var(--amber)}
.ux-foot b{display:block;font-size:12px;color:#fff;margin-bottom:3px}
.ux-foot p{margin:0;font-size:10.5px;line-height:1.7;color:var(--mut)}

@media(max-width:1180px){
  .ux-top{grid-template-columns:minmax(0,1fr)}
  .ux-top > .ux-col:nth-child(2){order:-1}
  .ux-ticket{position:static}
  .ux-bottom{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:820px){
  .ux-page{padding:16px}
  .ux-title{font-size:25px}
  .ux-ticker{width:100%}
  .ux-tick{flex:1 1 40%;border-bottom:1px solid var(--line)}
  .ux-price-v{font-size:26px}
  .ux-modal-actions .ux-btn{flex:1 1 100%}
  .ux-bottom,.ux-top{gap:14px;margin-top:14px}
}
@media(max-width:560px){
  .ux-tabs{grid-template-columns:minmax(0,1fr)}
  .ux-tab{white-space:normal}
  .ux-ticket-head{padding:14px 14px 0}
  .ux-ticket-body{padding:14px}
  .ux-summary-row{flex-wrap:wrap}
  .ux-readout{flex-wrap:wrap}
  .ux-readout-v{font-size:17px}
}
`;
