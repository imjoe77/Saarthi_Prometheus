/**
 * Wallet page styling — ported from the Ansar "Digital Wallet" design and
 * scoped to `.wlt-page`.
 *
 * Scoping is not cosmetic: this CSS is injected unlayered, and unlayered rules
 * beat Tailwind's `@layer utilities` regardless of specificity. A bare `*` or
 * `button` rule here would strip the AppShell's spacing and button styles, so
 * every selector below is rooted at the page container.
 */
export const walletStyles = `
.wlt-page{
  --panel:rgba(24,26,31,.92);
  --panel-hi:rgba(32,35,42,.98);
  --panel-2:#14161b;
  --line:rgba(255,255,255,.06);
  --line-2:rgba(255,255,255,.1);
  --tx:#ffffff;
  --tx-2:#b3b3b3;
  --mut:#71798a;
  --acc:#ff5a1f;
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
.wlt-page *,.wlt-page *::before,.wlt-page *::after{box-sizing:border-box}

/* ── header ───────────────────────────────────────────────── */
.wlt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.wlt-eyebrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:7px}
.wlt-eyebrow b{color:var(--acc);font-weight:700}
.wlt-eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--up);box-shadow:0 0 9px var(--up)}
.wlt-title{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:0}
.wlt-sub{margin-top:7px;font-size:12.5px;line-height:1.6;color:var(--mut);max-width:78ch}
.wlt-head-actions{display:flex;gap:8px;flex-wrap:wrap}

/* ── buttons ──────────────────────────────────────────────── */
.wlt-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 15px;border-radius:10px;border:1px solid var(--line-2);background:transparent;color:var(--tx);font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;transition:border-color .2s ease,color .2s ease,background .2s ease,box-shadow .2s ease}
.wlt-btn:hover{border-color:rgba(255,90,31,.5);background:rgba(255,90,31,.08);color:#fff}
.wlt-btn:disabled{opacity:.45;cursor:not-allowed}
.wlt-btn.primary{background:linear-gradient(135deg,#ff5a1f,#ff8a3d);border-color:transparent;color:#170800;box-shadow:0 10px 28px rgba(255,90,31,.26)}
.wlt-btn.primary:hover{box-shadow:0 14px 34px rgba(255,90,31,.36);color:#170800}
.wlt-btn.ghost{background:rgba(255,255,255,.04)}
.wlt-icon-btn{padding:9px;border-radius:10px;border:1px solid var(--line-2);background:rgba(255,255,255,.03);color:var(--tx-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s ease}
.wlt-icon-btn:hover{border-color:rgba(255,90,31,.5);color:#fff}

/* ── cards ────────────────────────────────────────────────── */
.wlt-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);transition:border-color .25s ease,background .25s ease,box-shadow .25s ease,transform .25s ease}
.wlt-card.lift:hover{border-color:rgba(255,90,31,.32);background:var(--panel-hi);box-shadow:0 16px 40px rgba(0,0,0,.45);transform:translateY(-2px)}

/* ── layout ───────────────────────────────────────────────── */
.wlt-layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:20px;margin-top:20px;align-items:start}
.wlt-left{display:flex;flex-direction:column;gap:16px}
.wlt-right{display:flex;flex-direction:column;gap:16px;min-width:0}

/* ── total card ───────────────────────────────────────────── */
.wlt-total{padding:22px}
.wlt-total-k{font-size:10px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--mut)}
.wlt-total-v{font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-.03em;margin-top:6px;line-height:1.2;overflow-wrap:anywhere}
.wlt-total-v .cur{color:var(--acc);margin-right:2px}
.wlt-total-note{margin-top:6px;font-size:10.5px;color:var(--mut);line-height:1.5}
.wlt-split{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}
.wlt-split-item{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:11px;padding:10px 12px}
.wlt-split-k{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);font-weight:600}
.wlt-split-v{font-family:var(--mono);font-size:13px;font-weight:700;margin-top:3px;overflow-wrap:anywhere}
.wlt-split-v.up{color:var(--up)}
.wlt-split-v.amb{color:var(--amber)}
.wlt-actions{display:flex;gap:8px;margin-top:14px}
.wlt-action{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 6px;border-radius:10px;border:1px solid var(--line-2);background:rgba(255,255,255,.03);color:var(--tx-2);font:inherit;font-size:11px;font-weight:600;text-decoration:none;cursor:pointer;transition:all .2s ease;white-space:nowrap}
.wlt-action:hover{border-color:rgba(255,90,31,.5);background:rgba(255,90,31,.1);color:#fff}

/* ── asset rail ───────────────────────────────────────────── */
.wlt-assets{padding:16px}
.wlt-assets-k{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--tx-2);margin-bottom:11px}
.wlt-coin-list{display:flex;flex-direction:column;gap:6px}
.wlt-coin{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:11px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:all .2s ease}
.wlt-coin:hover{background:rgba(255,255,255,.04);border-color:var(--line-2)}
.wlt-coin.on{background:rgba(255,255,255,.055);border-color:color-mix(in srgb,var(--coin) 45%,transparent)}
.wlt-coin-icon{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex:none;transition:border-color .2s ease}
.wlt-coin-body{flex:1;min-width:0}
.wlt-coin-sym{display:block;font-size:12.5px;font-weight:700;letter-spacing:.01em}
.wlt-coin-bal{display:block;font-family:var(--mono);font-size:10.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.wlt-coin-dot{width:6px;height:6px;border-radius:50%;background:var(--coin);box-shadow:0 0 9px var(--coin);flex:none}
.wlt-rail-note{margin-top:11px;padding-top:10px;border-top:1px solid var(--line);font-size:10px;line-height:1.55;color:var(--mut)}

/* ── asset detail ─────────────────────────────────────────── */
.wlt-detail{padding:22px}
.wlt-detail-head{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.wlt-detail-icon{width:52px;height:52px;border-radius:15px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;flex:none}
.wlt-detail-name{font-size:19px;font-weight:800;letter-spacing:-.015em}
.wlt-detail-sym{font-family:var(--mono);font-size:11px;color:var(--mut);margin-top:2px}
.wlt-kind{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:99px;font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;border:1px solid;white-space:nowrap}
.wlt-kind.k-fiat{color:var(--amber);border-color:rgba(255,170,0,.32);background:rgba(255,170,0,.1)}
.wlt-kind.k-stablecoin{color:var(--up);border-color:rgba(0,210,106,.32);background:rgba(0,210,106,.1)}
.wlt-kind.k-token{color:var(--acc);border-color:rgba(255,90,31,.36);background:rgba(255,90,31,.1)}
.wlt-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:16px}
.wlt-stat{background:var(--panel-2);padding:13px 15px;min-width:0}
.wlt-stat-k{font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--mut)}
.wlt-stat-v{font-family:var(--mono);font-size:17px;font-weight:700;margin-top:4px;overflow-wrap:anywhere;line-height:1.3}
.wlt-stat-v.blue{color:#ffb27d}
.wlt-stat-n{font-size:10px;color:var(--mut);margin-top:2px}
.wlt-splitline{margin-bottom:16px}
.wlt-splitline-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:10.5px;color:var(--mut)}
.wlt-splitline-head b{font-family:var(--mono);color:var(--tx);font-weight:700}
.wlt-bar{height:6px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden;margin-top:7px}
.wlt-bar span{display:block;height:100%;border-radius:99px;transition:width .5s cubic-bezier(.22,1,.36,1)}
.wlt-detail-actions{display:flex;gap:8px;flex-wrap:wrap}
.wlt-detail-actions .wlt-btn{flex:1;min-width:130px}

/* ── transaction card ─────────────────────────────────────── */
.wlt-tx{padding:20px}
.wlt-tx-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.wlt-tx-title{font-size:13px;font-weight:700;letter-spacing:-.005em}
.wlt-tx-title span{color:var(--acc)}
.wlt-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wlt-search{position:relative;display:flex;align-items:center}
.wlt-search svg{position:absolute;left:11px;color:var(--mut);pointer-events:none}
.wlt-input{background:#101318;border:1px solid var(--line-2);border-radius:9px;color:var(--tx);font:inherit;font-size:12px;padding:8px 11px;transition:border-color .2s ease,box-shadow .2s ease}
.wlt-input::placeholder{color:#5b6472}
.wlt-input:focus{outline:none;border-color:rgba(255,90,31,.6);box-shadow:0 0 0 3px rgba(255,90,31,.14)}
.wlt-search .wlt-input{padding-left:33px;width:230px}
select.wlt-input{padding-right:10px;cursor:pointer}
.wlt-table-wrap{overflow-x:auto}
.wlt-table{width:100%;border-collapse:collapse;min-width:760px}
.wlt-table th{text-align:left;font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:600;padding:0 12px 10px 0;border-bottom:1px solid var(--line);white-space:nowrap}
.wlt-table td{padding:11px 12px 11px 0;border-bottom:1px solid rgba(255,255,255,.045);font-size:12px;vertical-align:middle}
.wlt-table tbody tr:last-child td{border-bottom:0}
.wlt-table tbody tr:hover td{background:rgba(255,255,255,.02)}
.wlt-table .num{font-family:var(--mono);text-align:right;white-space:nowrap}
.wlt-table .mono{font-family:var(--mono)}
.wlt-table .dim{color:var(--mut)}
.wlt-type{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;white-space:nowrap}
.wlt-type i{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid var(--line);font-style:normal;flex:none}
.wlt-pill{display:inline-flex;align-items:center;padding:3px 8px;border-radius:99px;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border:1px solid;white-space:nowrap}
.wlt-pill.completed{color:var(--up);border-color:rgba(0,210,106,.32);background:rgba(0,210,106,.1)}
.wlt-pill.pending{color:var(--amber);border-color:rgba(255,170,0,.32);background:rgba(255,170,0,.1)}
.wlt-pill.failed{color:var(--down);border-color:rgba(255,77,109,.34);background:rgba(255,77,109,.1)}
.wlt-pill.reversed{color:#9aa2b1;border-color:var(--line-2);background:rgba(255,255,255,.05)}
.wlt-empty{padding:30px 18px;text-align:center;color:var(--mut);font-size:12.5px;border:1px dashed var(--line-2);border-radius:12px;background:rgba(255,255,255,.015);line-height:1.6}
.wlt-note{margin-top:11px;font-size:10.5px;color:var(--mut);text-align:center;font-family:var(--mono);line-height:1.6}
.wlt-more{display:flex;justify-content:center;margin-top:14px}

/* ── states ───────────────────────────────────────────────── */
.wlt-alert{display:flex;gap:12px;align-items:flex-start;border:1px solid rgba(255,90,31,.35);background:rgba(255,90,31,.07);border-radius:12px;padding:14px 16px;font-size:12px;color:#ffd3c2;line-height:1.6}
.wlt-alert svg{flex:none;margin-top:1px;color:var(--acc)}
.wlt-alert b{color:#fff;display:block;margin-bottom:2px;font-size:12.5px}
.wlt-alert a{color:var(--acc);text-decoration:underline;text-underline-offset:2px}
.wlt-loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:64px 20px;border:1px solid var(--line);border-radius:16px;background:var(--panel);font-family:var(--mono);font-size:12px;color:var(--mut)}
.wlt-spin{animation:wltSpin 1s linear infinite}
@keyframes wltSpin{to{transform:rotate(360deg)}}
.wlt-noWallet{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:56px 24px;border:1px dashed var(--line-2);border-radius:16px;background:rgba(255,255,255,.015)}
.wlt-noWallet-icon{width:52px;height:52px;border-radius:15px;background:rgba(255,90,31,.1);border:1px solid rgba(255,90,31,.32);color:var(--acc);display:flex;align-items:center;justify-content:center}
.wlt-noWallet h2{font-size:17px;font-weight:800;margin:0}
.wlt-noWallet p{font-size:12px;color:var(--mut);max-width:48ch;line-height:1.65;margin:0}

/* ── unfinished top-up (Razorpay rail) ────────────────────── */
/* Shown when a top-up was started but its payment sheet was closed: the
   deposit is PENDING with its order intact, so the honest copy is "nothing has
   been credited" plus a way back into the SAME order. Amber, not red - nothing
   is broken, the payment is simply unfinished. */
.wlt-resume{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:13px 15px;border:1px solid rgba(255,170,0,.34);background:rgba(255,170,0,.07);border-radius:13px}
.wlt-resume-copy{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:11.5px;line-height:1.6;color:#ffe0a3}
.wlt-resume-copy b{color:#fff;font-size:12.5px}
.wlt-resume-actions{display:flex;gap:8px;flex-wrap:wrap}

/* ── add-funds modal ──────────────────────────────────────── */
/* The overlay re-declares the design tokens so the panel renders identically
   wherever it is mounted: position:fixed escapes the page box, and the tokens
   would otherwise have to travel with it. */
.wlt-overlay{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(4,5,7,.74);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);--panel:rgba(24,26,31,.96);--panel-2:#14161b;--line:rgba(255,255,255,.06);--line-2:rgba(255,255,255,.1);--tx:#ffffff;--tx-2:#b3b3b3;--mut:#71798a;--acc:#ff5a1f;--amber:#ffaa00;--up:#00d26a;--down:#ff4d6d;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.wlt-modal{width:100%;max-width:440px;max-height:calc(100vh - 40px);overflow-y:auto;background:var(--panel);border:1px solid var(--line-2);border-radius:18px;box-shadow:0 28px 70px rgba(0,0,0,.6)}
.wlt-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:20px 22px 0}
.wlt-modal-title{margin:0;font-size:17px;font-weight:800;letter-spacing:-.015em}
.wlt-modal-sub{margin:5px 0 0;font-size:11.5px;color:var(--mut);line-height:1.55}
.wlt-modal-body{padding:18px 22px 22px}
.wlt-modal-actions{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
.wlt-modal-actions .wlt-btn{flex:1;min-width:120px}
.wlt-close{padding:7px;border-radius:9px;border:1px solid var(--line-2);background:rgba(255,255,255,.03);color:var(--tx-2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none}
.wlt-close:hover{border-color:rgba(255,90,31,.5);color:#fff}

.wlt-field-label{display:block;font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--mut);margin-bottom:7px}
.wlt-amount{display:flex;align-items:center;gap:9px;background:#101318;border:1px solid var(--line-2);border-radius:11px;padding:0 13px;transition:border-color .2s ease,box-shadow .2s ease}
.wlt-amount:focus-within{border-color:rgba(255,90,31,.6);box-shadow:0 0 0 3px rgba(255,90,31,.14)}
.wlt-amount .cur{font-family:var(--mono);font-size:17px;font-weight:700;color:var(--amber)}
.wlt-amount input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--tx);font-family:var(--mono);font-size:22px;font-weight:700;padding:13px 0}
.wlt-amount input::placeholder{color:#4d5464}
.wlt-presets{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.wlt-preset{padding:6px 12px;border-radius:99px;border:1px solid var(--line-2);background:rgba(255,255,255,.03);color:var(--tx-2);font:inherit;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s ease}
.wlt-preset:hover{border-color:rgba(255,90,31,.5);color:#fff;background:rgba(255,90,31,.08)}
.wlt-preset.on{border-color:rgba(255,90,31,.65);background:rgba(255,90,31,.16);color:#fff}
.wlt-modal-note{margin-top:14px;padding:11px 13px;border-radius:11px;border:1px solid var(--line);background:rgba(255,255,255,.025);font-size:11px;line-height:1.6;color:var(--mut)}
.wlt-modal-note b{color:var(--tx-2)}
.wlt-modal-failure{margin-top:14px;padding:12px 13px;border-radius:11px;border:1px solid rgba(255,77,109,.34);background:rgba(255,77,109,.09);font-size:11.5px;line-height:1.6;color:#ffd3dc}
.wlt-modal-failure b{display:block;color:#fff;margin-bottom:3px}
.wlt-modal-success{margin-top:14px;padding:12px 13px;border-radius:11px;border:1px solid rgba(0,210,106,.32);background:rgba(0,210,106,.09);font-size:11.5px;line-height:1.6;color:#c6f5da}
.wlt-modal-success b{display:block;color:#fff;margin-bottom:3px}
.wlt-modal-hint{margin-top:9px;font-size:10.5px;color:var(--mut);font-family:var(--mono)}

@media(max-width:1180px){
  .wlt-layout{grid-template-columns:minmax(0,1fr)}
  .wlt-left{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}
  /* Two columns halve the card width, so the three shortcut buttons must be
     allowed to wrap instead of overflowing their card. */
  .wlt-actions{flex-wrap:wrap}
  .wlt-action{flex:1 1 110px;min-width:0}
}
@media(max-width:820px){
  .wlt-page{padding:16px}
  .wlt-left{grid-template-columns:minmax(0,1fr)}
  .wlt-stats{grid-template-columns:minmax(0,1fr)}
  .wlt-title{font-size:25px}
  .wlt-search .wlt-input{width:100%}
  .wlt-search{flex:1;min-width:160px}
  .wlt-filters{width:100%}
  .wlt-total-v{font-size:26px}
}
@media(max-width:560px){
  .wlt-actions{flex-wrap:wrap}
  .wlt-action{flex:1 1 100%}
  .wlt-split{grid-template-columns:minmax(0,1fr)}
  .wlt-total-v{font-size:21px}
  .wlt-detail-head{flex-wrap:wrap}
  .wlt-kind{margin-left:0}
  .wlt-detail-actions .wlt-btn{flex:1 1 100%}
  .wlt-resume{align-items:flex-start}
  .wlt-resume-actions{width:100%}
  .wlt-resume-actions .wlt-btn{flex:1 1 100%}
}
`;
