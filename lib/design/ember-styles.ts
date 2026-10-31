/**
 * Generated from the project design reference (ember_token.html).
 * Injected by the page as a <style> element so it unmounts on navigation
 * instead of leaking these global selectors into the rest of the app.
 */
export const emberStyles = `
:root{--bg:#0c0d10;--panel:#14161b;--p2:#1a1d23;--line:#24272f;--tx:#eceef2;--mut:#8a8f9b;--acc:#ff6a1a;--soft:rgba(255,106,26,.12);--up:#3ddc97;--dn:#ff5d5d;--amb:#ffb020;--blue:#5b8cff;
box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){--bg:#f4f5f7;--panel:#fff;--p2:#f0f1f4;--line:#e1e3e8;--tx:#16181d;--mut:#6a707c;--acc:#e8570a;--soft:rgba(232,87,10,.1);--up:#12935d;--dn:#d33;--amb:#b9770e;--blue:#3b6fe0}}
/* Scoped to the page so the design reset cannot strip the AppShell's Tailwind
   spacing (unlayered rules win over @layer utilities). */
.ember-page, .ember-page *{box-sizing:border-box}
.ember-page *{margin:0}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
.ember-page{background:var(--bg);color:var(--tx);font:14px/1.5 Manrope,system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.ember-page button,.ember-page input{font:inherit;color:inherit}
.ember-page button{cursor:pointer;background:none;border:0}
.ember-page :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.app{display:flex;min-height:100vh}
.side{width:200px;flex:none;align-self:flex-start;transition:margin-left .35s ease,opacity .35s ease;border-right:1px solid var(--line);padding:22px 14px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:6px;overflow:auto}
.app.off .side{margin-left:-201px;opacity:0;pointer-events:none}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:17px;letter-spacing:.04em;padding:0 8px 18px}
.logo .mark{position:relative;width:36px;height:36px;flex:none;object-fit:contain;background:transparent;filter:drop-shadow(0 0 12px rgba(255,106,26,.45));animation:markBreath 3.8s ease-in-out infinite}
@keyframes markBreath{0%,100%{box-shadow:0 0 10px rgba(255,106,26,.35)}50%{box-shadow:0 0 24px rgba(255,130,50,.85)}}
@keyframes markRing{0%{opacity:.5;transform:scale(.86)}60%{opacity:0;transform:scale(1.5)}100%{opacity:0;transform:scale(1.5)}}
.grp{font-size:10.5px;font-weight:700;letter-spacing:.13em;color:var(--mut);padding:16px 10px 6px;text-transform:uppercase;opacity:.85}
/* ---- Molten Dock navigation ---- */
.dock{position:relative;display:flex;flex-direction:column;gap:2px}
.molten{position:absolute;left:4px;right:4px;top:0;height:0;border-radius:9px;opacity:0;pointer-events:none;will-change:top,height;background:var(--p2);border:1px solid var(--line);transition:top .34s cubic-bezier(.4,0,.2,1),height .34s cubic-bezier(.4,0,.2,1),opacity .2s ease}
.molten::before{content:"";position:absolute;left:-1px;top:50%;width:3px;height:56%;margin-top:-28%;border-radius:99px;background:var(--acc)}
.dock a{position:relative;z-index:1;display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:9px;color:var(--mut);text-decoration:none;font-weight:500;transition:color .18s ease,background .18s ease}
.dock a:hover{color:var(--tx);background:var(--p2)}
.dock a.hot{background:var(--p2)}
.dock a.on{color:var(--acc);font-weight:700}
.dock a.on .nic{filter:drop-shadow(0 0 7px rgba(255,106,26,.75))}
.nic{display:grid;place-items:center;width:18px;height:18px;flex:none;transition:transform .24s cubic-bezier(.4,0,.2,1)}
.dock a:hover .nic{transform:scale(1.08)}
.dock a .ntx{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side svg,.ic svg{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.me{margin-top:auto;display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;font-size:12px;color:var(--mut)}
.me b{display:block;color:var(--tx);font-size:13px}.me i{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--acc),#7a3bff)}
main{padding:0 30px 48px;min-width:0;flex:1}
.bar{display:flex;align-items:center;gap:12px;padding:18px 0;color:var(--mut);font-size:13px;flex-wrap:wrap}.bar b{color:var(--tx);font-weight:600}.bar .sp{flex:1}
.ic{width:36px;height:36px;border:1px solid var(--line);border-radius:9px;display:grid;place-items:center;background:var(--panel)}.ic:hover{background:var(--p2)}
.btn{padding:9px 16px;border-radius:9px;border:1px solid var(--line);background:var(--panel);font-weight:600;font-size:13px}.btn:hover{background:var(--p2)}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff}.btn.pri:hover{filter:brightness(1.08)}.btn.w{width:100%;padding:12px}
.head{margin:6px 0 22px}h1{font-size:26px;font-weight:700;letter-spacing:-.02em}.sub{color:var(--mut);max-width:620px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px}
.lbl{color:var(--mut);font-size:13px;font-weight:500}.up{color:var(--up)}.dn{color:var(--dn)}
h2{font-size:18px;font-weight:700}.sec{margin:34px 0 14px}.sec p{color:var(--mut);font-size:13px}
.hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px}
.fur{position:relative;overflow:hidden;border-radius:14px;background:#08080a;border:1px solid #2a1a12;color:#f4f1ee;min-height:460px;display:flex;flex-direction:column}
.fur canvas{position:absolute;inset:0;width:100%;height:100%}
.burn-visual{position:absolute;z-index:1;right:9%;top:18%;width:190px;height:230px;pointer-events:none;display:grid;place-items:center;filter:drop-shadow(0 10px 28px rgba(255,84,10,.2))}
.burn-aura{position:absolute;inset:22px 10px 14px;border-radius:50%;background:radial-gradient(ellipse,rgba(255,106,26,.24),rgba(255,106,26,.08) 42%,transparent 72%);animation:burnAura 2.2s ease-in-out infinite}
.burn-flame{position:absolute;top:8px;width:62px;height:94px;border-radius:55% 45% 52% 48%/70% 70% 30% 30%;background:radial-gradient(ellipse at 50% 72%,#fff8d6 0 5%,#ffd36c 15%,#ff9b22 38%,#ff5914 66%,transparent 72%);clip-path:polygon(50% 0,61% 22%,82% 38%,75% 58%,100% 78%,80% 100%,18% 100%,0 76%,26% 59%,21% 41%,39% 26%);transform-origin:50% 90%;filter:drop-shadow(0 0 14px rgba(255,126,25,.75));animation:flameDance .72s ease-in-out infinite alternate}
.burn-coin{position:absolute;top:80px;width:104px;height:104px;border-radius:50%;display:grid;place-items:center;color:#ffe8a1;font:800 46px/1 Manrope,system-ui,sans-serif;background:radial-gradient(circle at 35% 25%,#ffe7a1 0,#db8a2b 19%,#8a3d12 45%,#30150d 63%,#ffad3e 68%,#6a2b0b 76%,#170d0a 100%);border:3px solid #ffbc55;box-shadow:inset 0 0 0 4px rgba(255,230,158,.22),inset 0 0 20px #ff5e14,0 0 24px rgba(255,109,25,.65);text-shadow:0 2px 7px #71310a;animation:coinBurn 3.6s ease-in-out infinite}
.burn-coin::before{content:"";position:absolute;inset:10px;border:1px solid rgba(255,231,161,.58);border-radius:50%}.burn-coin::after{content:"";position:absolute;inset:0;border-radius:50%;background:linear-gradient(112deg,transparent 28%,rgba(255,255,220,.38) 46%,transparent 61%);animation:coinShine 2.8s linear infinite}
.burn-ash{position:absolute;top:171px;width:5px;height:5px;border-radius:50%;background:#ffd282;box-shadow:0 0 10px 3px rgba(255,116,28,.8);animation:ashRise 1.8s ease-out infinite}.burn-ash.a{left:42px;animation-delay:-.4s}.burn-ash.b{right:39px;animation-delay:-1.1s}.burn-ash.c{left:82px;animation-delay:-1.5s}
@keyframes burnAura{50%{opacity:.62;transform:scale(1.08)}}@keyframes flameDance{to{transform:rotate(5deg) scale(.9,1.08);filter:brightness(1.2) drop-shadow(0 0 20px rgba(255,126,25,.9))}}@keyframes coinBurn{0%,100%{transform:rotateY(-12deg) translateY(0);filter:brightness(1)}50%{transform:rotateY(12deg) translateY(3px);filter:brightness(1.16) saturate(1.12)}}@keyframes coinShine{to{transform:rotate(360deg)}}@keyframes ashRise{0%{opacity:0;transform:translateY(15px) scale(.4)}25%{opacity:1}100%{opacity:0;transform:translateY(-65px) translateX(12px) scale(.1)}}
.burn-flames{position:absolute;z-index:2;left:18px;top:70px;width:154px;height:120px;pointer-events:none}
.burn-flames i{position:absolute;display:block;width:28px;height:70px;bottom:0;border-radius:50% 46% 46% 54%/82% 76% 24% 18%;transform-origin:50% 100%;background:radial-gradient(ellipse at 50% 83%,#fff4c4 0 7%,#ffd05c 18%,#ff9b2a 42%,#f64c14 69%,rgba(209,42,10,.12) 83%,transparent 88%);filter:blur(.25px) drop-shadow(0 0 8px rgba(255,100,25,.65));animation:flameLick .62s ease-in-out infinite alternate}
.burn-flames .l1{left:2px;height:62px;animation-duration:.57s}.burn-flames .l2{right:0;height:75px;animation-delay:-.31s;animation-duration:.73s}.burn-flames .l3{left:31px;height:43px;bottom:-3px;--lean:-20deg;animation-delay:-.22s;animation-duration:.51s}.burn-flames .l4{right:26px;height:51px;bottom:-2px;--lean:18deg;animation-delay:-.4s;animation-duration:.66s}.burn-flames .l5{left:61px;height:55px;bottom:8px;width:23px;animation-delay:-.16s;animation-duration:.8s}
.burn-coin{z-index:1;top:84px;width:88px;height:88px;color:#ffe3a0;background:radial-gradient(circle at 34% 25%,#eebd67 0,#9d5b24 25%,#563019 53%,#24160f 69%,#a5642a 74%,#21130d 100%);border:2px solid #cc8b3d;box-shadow:inset 0 0 0 4px rgba(255,215,146,.12),inset 0 -9px 15px rgba(0,0,0,.8),0 0 20px rgba(255,90,20,.46);animation:coinSmolder 2.8s ease-in-out infinite}
.burn-coin span{position:relative;z-index:2}.burn-coin::before{inset:8px;border-color:rgba(255,222,165,.36)}.burn-coin::after{z-index:1;opacity:.8;background:linear-gradient(165deg,transparent 28%,rgba(20,8,3,.12) 43%,rgba(10,5,3,.85) 100%);animation:charCreep 2.4s ease-in-out infinite alternate}
@keyframes flameLick{0%{opacity:.68;transform:scale(.78,.76) rotate(calc(var(--lean,0deg) - 5deg))}100%{opacity:1;transform:scale(1.05,1.12) rotate(calc(var(--lean,0deg) + 6deg));filter:brightness(1.24) drop-shadow(0 0 12px rgba(255,111,27,.85))}}@keyframes coinSmolder{0%,100%{transform:rotateY(-7deg) translateY(1px);filter:brightness(.84) saturate(.82)}50%{transform:rotateY(8deg) translateY(-1px);filter:brightness(1.03) saturate(1.05)}}@keyframes charCreep{from{opacity:.5;transform:translateY(8px)}to{opacity:.94;transform:translateY(-2px)}}
.fi{position:relative;z-index:1;padding:24px;display:flex;flex-direction:column;flex:1;pointer-events:none}
.fi .lbl{color:#b9a79d}.chipf{align-self:flex-start;font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;background:rgba(255,106,26,.16);color:#ff8a4a}
.bn{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin-top:8px;color:#fff}.bn small{font-size:16px;color:#ff8a4a;font-weight:700}
.fst{margin-top:auto;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding-top:150px}
.fst div{background:rgba(255,255,255,.06);backdrop-filter:blur(6px);border-radius:10px;padding:10px 12px}.fst b{display:block;font-size:17px;color:#fff}
.flow{position:relative;z-index:1;display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;padding:16px 24px;border-top:1px solid rgba(255,255,255,.08);background:rgba(8,8,10,.7)}
.flow .nd{border-radius:10px;padding:10px 12px;font-size:12.5px;background:rgba(255,255,255,.05)}.flow b{display:block;font-size:14px;color:#fff}
.flow .ar{color:#ff8a4a;font-size:12px;font-weight:700;text-align:center}.flow .bu{background:rgba(255,106,26,.16)}.flow .yi{background:rgba(61,220,151,.12)}
.vault .tb{display:flex;justify-content:space-between;align-items:center}.badge{font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;background:var(--soft);color:var(--acc)}
.vb{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:8px}.vb small{font-size:15px;color:var(--mut);font-weight:700}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.two div{background:var(--p2);border-radius:10px;padding:10px 12px}.two b{display:block;font-size:16px}
.rw{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px;border:1px dashed var(--acc);border-radius:10px;background:var(--soft);margin-bottom:18px}
.rw b{display:block}
.seg{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0 14px}
.seg button{border:1px solid var(--line);border-radius:10px;padding:8px 4px;text-align:center;background:var(--p2)}
.seg button.on{border-color:var(--acc);background:var(--soft)}.seg b{display:block;font-size:13px}.seg span{font-size:12px;color:var(--mut)}.seg button.on span{color:var(--acc);font-weight:700}
.seg i{display:block;font-style:normal;font-size:11px;letter-spacing:2px;color:var(--acc);height:14px}
.amt{display:flex;align-items:center;border:1px solid var(--line);border-radius:10px;background:var(--p2);padding:2px 10px}
.amt input{flex:1;background:none;border:0;padding:10px 0;font-weight:700;font-size:16px;min-width:0}.amt input:focus{outline:0}.amt button{color:var(--acc);font-weight:800;font-size:12px}
.est{display:flex;justify-content:space-between;margin:12px 0 16px;font-size:13px}
.utility-section{margin:34px 0 8px}.utility-heading{align-items:flex-end;margin-bottom:14px}.utility-heading .eyebrow{margin-bottom:7px}.utility-heading h2{font-size:20px}.utility-heading p{margin-top:4px;color:var(--mut);font-size:13px}.utility-rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.utility-item{min-width:0;padding:4px 20px}.utility-item:first-child{padding-left:4px}.utility-item+.utility-item{border-left:1px solid var(--line)}.utility-lead{display:flex;align-items:center;gap:9px;color:var(--mut);font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.utility-icon{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;color:var(--acc);background:var(--soft)}.utility-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.utility-item b{display:block;margin:12px 0 4px;font-size:14px;letter-spacing:-.01em}.utility-item small{color:var(--mut);font-size:11px}.utility-item:hover b{color:var(--acc)}
.tk{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:16px;align-items:start}
/* Animated Interactive Pie Chart */
.ring{position:relative;width:min(280px,100%);aspect-ratio:1/1;margin:0 auto;display:flex;align-items:center;justify-content:center}
.ring svg{width:100%;height:100%;display:block;overflow:visible}
.pie-slice{cursor:pointer;transform-origin:150px 150px;transform:translate(0,0) scale(1);transition:transform .38s cubic-bezier(.34,1.56,.64,1),filter .28s ease,opacity .22s ease;will-change:transform,filter,opacity}
.pie-slice.active{transform:translate(var(--tx),var(--ty)) scale(1.05);filter:drop-shadow(0 0 16px var(--glow)) brightness(1.22);opacity:1 !important}
.ring.has-hover .pie-slice:not(.active){opacity:.32;filter:grayscale(30%) brightness(.8);transform:scale(.985)}
@keyframes sliceIn{from{opacity:0;transform:scale(.65) rotate(-15deg)}to{opacity:1;transform:translate(0,0) scale(1) rotate(0)}}
.pie-entering .pie-slice{animation:sliceIn .65s cubic-bezier(.34,1.56,.64,1) backwards}
.pie-hub{position:absolute;width:132px;height:132px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;pointer-events:none;background:radial-gradient(circle,rgba(255,255,255,.04) 0%,rgba(16,18,22,.88) 75%);border:1px solid rgba(255,255,255,.08);box-shadow:0 4px 24px rgba(0,0,0,.45),inset 0 0 16px rgba(0,0,0,.35);backdrop-filter:blur(8px);padding:8px;transition:border-color .25s ease,box-shadow .25s ease}
.hub-pill{font-size:11px;font-weight:700;letter-spacing:.05em;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.06);color:var(--mut);transition:color .2s,background .2s;max-width:116px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hub-val{font-size:24px;font-weight:800;letter-spacing:-.025em;color:#fff;line-height:1.15;margin:3px 0 2px;transition:transform .18s ease}
.hub-sub{font-size:10.5px;color:var(--mut);font-weight:500;line-height:1.25}
.lg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.lg button{text-align:left;background:var(--p2);border-radius:12px;padding:12px 14px;border:1px solid transparent;transition:border-color .25s,background .25s,transform .22s cubic-bezier(.34,1.56,.64,1),box-shadow .25s;cursor:pointer}
.lg button:hover,.lg button.on{transform:translateY(-3px) scale(1.01);background:var(--panel);border-color:var(--c);box-shadow:0 6px 20px rgba(0,0,0,.22),0 0 14px var(--c-glow)}
.lg .lbl{display:flex;gap:7px;align-items:center}
.lg .lbl::before{content:"";width:9px;height:9px;border-radius:3px;background:var(--c);box-shadow:0 0 8px var(--c)}
.lg b{display:block;font-size:17px;margin-top:2px;color:#fff}
.lg small{color:var(--mut);font-size:12px}
#lk{display:flex;align-items:center;justify-content:center;gap:8px;font-weight:700;font-size:14px;padding:12px;margin-top:4px;border-radius:10px;background:linear-gradient(135deg,var(--acc),#e05006);border:1px solid rgba(255,106,26,.4);color:#fff;box-shadow:0 4px 16px rgba(255,106,26,.25);transition:transform .18s cubic-bezier(.34,1.56,.64,1),box-shadow .2s}
#lk:hover{transform:translateY(-1.5px);box-shadow:0 6px 22px rgba(255,106,26,.4)}
#lk:active{transform:translateY(0.5px)}
.tel{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px}
.vel{font-size:26px;font-weight:700;color:var(--acc)}.vel small{font-size:14px;color:var(--mut);font-weight:600}
.bars{height:90px;margin:14px 0 4px}.bars svg{width:100%;height:100%;display:block}
.fac{display:flex;flex-direction:column;gap:10px;font-size:13px}.fac div{display:flex;justify-content:space-between;padding:10px 12px;background:var(--p2);border-radius:10px}.fac b{font-weight:700}
.tabs{display:flex;gap:4px;background:var(--p2);padding:3px;border-radius:9px}.tabs button{padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:600;color:var(--mut)}.tabs button.on{background:var(--panel);color:var(--tx);box-shadow:0 0 0 1px var(--line)}
.hr{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:640px}th{font-size:12px;color:var(--mut);font-weight:500;text-align:left;padding:8px}td{padding:12px 8px;border-top:1px solid var(--line);font-size:13px}.r{text-align:right}
.ev{display:inline-flex;gap:8px;align-items:center;font-weight:600}.ev i{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;font-style:normal}
.ev.burn i{background:var(--soft)}.ev.dist i{background:rgba(61,220,151,.12)}.ev.lock i{background:rgba(91,140,255,.14)}
.st{font-size:12px;font-weight:700;padding:3px 9px;border-radius:99px}.st.burn{color:var(--acc);background:var(--soft)}.st.dist{color:var(--up);background:rgba(61,220,151,.12)}.st.lock{color:var(--blue);background:rgba(91,140,255,.14)}
.hash{color:var(--mut);font-family:ui-monospace,Consolas,monospace;font-size:12px}
@keyframes ni{from{background:var(--soft)}to{background:transparent}}tr.new{animation:ni 2.2s}
#toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translate(-50%,20px);background:var(--tx);color:var(--bg);padding:10px 16px;border-radius:10px;font-weight:600;opacity:0;pointer-events:none;transition:.25s;z-index:9}#toast.on{opacity:1;transform:translate(-50%,0)}
@media (max-width:1100px){.hero,.tk,.tel{grid-template-columns:1fr}.utility-rail{grid-template-columns:repeat(2,minmax(0,1fr))}.utility-item:nth-child(3){border-left:0}.utility-item:nth-child(n+3){border-top:1px solid var(--line);padding-top:16px;margin-top:12px}}
@media (max-width:820px){.app{display:block}.app.off .side{display:none;margin:0}.side{position:static;height:auto;width:auto;flex-direction:row;overflow-x:auto;padding:10px;align-items:center;gap:4px}.grp,.me,.logo .wm,.dock a .ntx{display:none}.dock{flex-direction:row;gap:4px}.molten{display:none}.logo{padding:0 8px}main{padding:0 16px 40px}.bn{font-size:26px}.fst{grid-template-columns:1fr}.lg{grid-template-columns:1fr}.flow{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){tr.new{animation:none}}
.cr{display:flex;gap:8px;flex-wrap:wrap}.chipf.g{background:rgba(61,220,151,.14);color:#4ee0a0}
.fz{position:relative;z-index:1;padding:10px 24px;font-size:12.5px;color:#b9a79d;background:rgba(8,8,10,.85);border-top:1px solid rgba(255,255,255,.06)}.fz b{color:#fff;font-weight:600}
.flow .hx{color:#ff8a4a;font-family:ui-monospace,Consolas,monospace}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.tl{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.tl b{display:block;font-size:20px;font-weight:800;letter-spacing:-.01em;margin:4px 0 2px}.tl b small{font-size:12px;color:var(--mut);font-weight:700}.tl .n{font-size:12.5px;color:var(--mut)}
.tl .tg{float:right;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--p2);color:var(--mut)}.tl .tg.o{background:var(--soft);color:var(--acc)}.tl .tg.u{background:rgba(61,220,151,.12);color:var(--up)}
@media (max-width:1100px){.tiles{grid-template-columns:repeat(2,1fr)}}@media (max-width:560px){.tiles{grid-template-columns:1fr}}
/* ---- Visual overhaul: ambient depth, molten rim, scroll reveal ---- */
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;background:radial-gradient(1100px 520px at 18% -6%,rgba(255,106,26,.085),transparent 62%),radial-gradient(900px 460px at 92% 8%,rgba(255,140,60,.055),transparent 60%),radial-gradient(1000px 600px at 60% 104%,rgba(255,90,20,.05),transparent 62%)}
.side{background:linear-gradient(180deg,rgba(255,255,255,.022),transparent 40%)}
/* hero molten rim + heat */
.fur{box-shadow:0 24px 70px -34px rgba(255,90,20,.55),0 2px 0 rgba(255,255,255,.02) inset;border-color:rgba(255,106,26,.28)}
.fur::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:2;background:linear-gradient(180deg,rgba(255,120,40,.10),transparent 26%,transparent 74%,rgba(255,90,20,.07)),radial-gradient(120% 62% at 50% 118%,rgba(255,106,26,.16),transparent 62%);animation:heatPulse 5.2s ease-in-out infinite;mix-blend-mode:screen}
@keyframes heatPulse{0%,100%{opacity:.62}50%{opacity:1}}
.bn{text-shadow:0 0 22px rgba(255,106,26,.45),0 0 44px rgba(255,106,26,.18)}
/* cards: melted-glow hover lift */
.card{transition:transform .34s cubic-bezier(.34,1.4,.5,1),border-color .3s ease,box-shadow .34s ease,background .3s ease}
.card:hover{transform:translateY(-3px);border-color:rgba(255,106,26,.3);box-shadow:0 18px 44px -22px rgba(255,90,20,.5),0 0 0 1px rgba(255,106,26,.06)}
.vault:hover{box-shadow:0 18px 44px -22px rgba(255,90,20,.4)}
/* buttons & CTA glow */
.btn{transition:background .2s ease,transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .24s ease,border-color .2s ease}
.btn:hover{transform:translateY(-1.5px)}
.btn.pri{box-shadow:0 0 0 rgba(255,106,26,0)}
.btn.pri:hover{box-shadow:0 6px 22px -6px rgba(255,106,26,.65),0 0 18px rgba(255,106,26,.28)}
.btn.pri:active{transform:translateY(1px)}
/* tiles + sections reveal */
.rv{opacity:0;transform:translateY(16px)}
.rv-in{opacity:1;transform:none;transition:opacity .6s ease,transform .7s cubic-bezier(.22,1,.36,1)}
.tl{transition:border-color .3s ease,box-shadow .3s ease,transform .3s cubic-bezier(.34,1.5,.5,1)}
.tl:hover{border-color:rgba(255,106,26,.28);box-shadow:0 14px 34px -18px rgba(255,90,20,.5);transform:translateY(-2px)}
.tl b{font-variant-numeric:tabular-nums}
.vel{font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.rv{opacity:1;transform:none}.fur::after,.logo .mark,.logo .mark::after,.molten::before{animation:none}}

/* ---- Slide to confirm (replaces the Lock button) ---- */
.slide{position:relative;width:100%;height:56px;border-radius:28px;background:#262626;overflow:hidden;
  touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer;
  transition:background .3s ease,opacity .25s ease}
.slide:active{cursor:grabbing}
.slide .sl-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:28px;
  background:linear-gradient(90deg,rgba(255,106,26,.32),var(--acc));
  transition:width .1s linear,background .3s ease}
.slide .sl-label{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;
  font-weight:700;font-size:13.5px;letter-spacing:.02em;color:#8a8f9b;
  transition:opacity .2s ease,color .3s ease}
.slide .sl-handle{position:absolute;left:6px;top:6px;width:44px;height:44px;border-radius:50%;
  background:#f5f5f5;display:grid;place-items:center;cursor:grab;will-change:transform;
  box-shadow:0 2px 10px rgba(0,0,0,.45)}
.slide .sl-handle:active{cursor:grabbing}
.slide .sl-handle svg{width:18px;height:18px;fill:none;stroke:#262626;stroke-width:2.2;
  stroke-linecap:round;stroke-linejoin:round;transition:stroke .3s ease}
.slide .sl-handle .spin{width:18px;height:18px;border-radius:50%;
  border:2px solid rgba(38,38,38,.22);border-top-color:#262626;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.slide.ok{background:#22c55e}
.slide.ok .sl-fill{background:#22c55e}
.slide.ok .sl-handle{background:#fff}
.slide.ok .sl-handle svg{stroke:#22c55e}
.slide.err{background:#e5484d}
.slide.err .sl-fill{background:#e5484d}
.slide.err .sl-handle{background:#fff}
.slide.err .sl-handle svg{stroke:#e5484d}
.slide.disabled{opacity:.45;pointer-events:none}
@media(max-width:820px){.app.off .side{display:flex;margin:0;opacity:1;pointer-events:auto}.burn-visual{right:-16px;top:20%;transform:scale(.72);opacity:.68}}
@media(max-width:520px){.burn-visual{right:-44px;top:17%;transform:scale(.58);opacity:.48}.fi{padding:18px}.bn{font-size:26px}.fst{padding-top:118px}}
@media(prefers-reduced-motion:reduce){.logo .mark,.burn-aura,.burn-flame,.burn-flames i,.burn-coin,.burn-coin::after,.burn-ash{animation:none!important}.burn-coin{transform:none!important}}
.fur canvas{display:none}.burn-visual{left:50%;right:auto;top:38%;width:190px;height:190px;transform:translate(-50%,-50%);filter:none;opacity:1;perspective:800px}
.coin-container{position:relative;z-index:2;display:grid;place-items:center;transform-style:preserve-3d;animation:floatCoin 5s ease-in-out infinite}
.coin-heat-ring{position:absolute;inset:-22px;border-radius:50%;background:conic-gradient(from 25deg,rgba(255,174,68,.05),rgba(255,126,28,.52),rgba(255,210,112,.12),rgba(255,102,20,.4),rgba(255,174,68,.05));filter:blur(15px);opacity:.62;animation:coinAura 3s ease-in-out infinite}
.coin-body{position:relative;width:144px;height:144px;padding:5px;border-radius:50%;background:linear-gradient(135deg,#ffe9ac 0%,#bd741e 20%,#32180b 49%,#f3bd59 69%,#201108 100%);border:2px solid rgba(255,210,112,.72);box-shadow:inset 0 0 0 2px rgba(255,238,185,.24),0 0 24px rgba(255,112,27,.32);transform-style:preserve-3d}
.coin-face{position:relative;width:100%;height:100%;overflow:hidden;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 48% 28%,#392315 0%,#15100d 54%,#080808 100%);border:1px solid rgba(255,171,54,.62);box-shadow:inset 0 0 22px rgba(255,113,25,.18),inset 0 -12px 18px rgba(0,0,0,.72)}
.coin-face::before{content:"";position:absolute;inset:0;opacity:.18;background-image:radial-gradient(rgba(255,153,0,.82) .7px,transparent .9px);background-size:8px 8px}
.coin-face::after{content:"";position:absolute;inset:-25%;background:linear-gradient(112deg,transparent 34%,rgba(255,245,207,.22) 48%,transparent 60%);transform:translateX(-80%) rotate(12deg);animation:coinShine 5s ease-in-out infinite}
.coin-mark{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#ffdf96;text-shadow:0 3px 8px rgba(0,0,0,.85)}
.coin-mark strong{font-size:58px;line-height:.9;font-weight:800;background:linear-gradient(#fff0bd,#ffc452 55%,#bd6416);color:transparent;background-clip:text;-webkit-background-clip:text;filter:drop-shadow(0 3px 5px rgba(0,0,0,.75))}
.coin-mark i{width:32px;height:2px;margin:7px 0 5px;border-radius:9px;background:rgba(255,174,61,.72)}.coin-mark small{font-size:8px;letter-spacing:.16em;text-transform:uppercase;font-weight:800;color:rgba(255,194,101,.86)}
.coin-shadow{position:absolute;bottom:-18px;width:78px;height:10px;border-radius:50%;background:rgba(255,111,25,.27);filter:blur(8px);animation:coinShadow 5s ease-in-out infinite}
@keyframes floatCoin{0%,100%{transform:translateY(0) rotateY(-8deg) rotateZ(-1deg)}50%{transform:translateY(-12px) rotateY(12deg) rotateZ(1deg)}}@keyframes coinAura{0%,100%{opacity:.42;transform:scale(.96)}50%{opacity:.78;transform:scale(1.08)}}@keyframes coinShine{0%,28%{transform:translateX(-80%) rotate(12deg)}72%,100%{transform:translateX(80%) rotate(12deg)}}@keyframes coinShadow{0%,100%{transform:scaleX(1);opacity:.62}50%{transform:scaleX(.76);opacity:.34}}
@media(max-width:820px){.burn-visual{right:auto;top:42%;transform:translate(-50%,-50%);opacity:.9}}
@media(max-width:520px){.burn-visual{right:auto;top:42%;width:156px;height:156px;transform:translate(-50%,-50%);opacity:.86}.coin-body{width:118px;height:118px}.coin-mark strong{font-size:48px}}
@media(prefers-reduced-motion:reduce){.coin-container,.coin-heat-ring,.coin-face::after,.coin-shadow{animation:none!important}.coin-container{transform:none}}
/* Vault treatment: one calm surface, with data separated by space and fine rules. */
.card.vault{position:relative;overflow:hidden;padding:24px;background:radial-gradient(ellipse at 100% 0,rgba(255,106,26,.09),transparent 42%),linear-gradient(155deg,#17191e 0%,#121418 62%,#151316 100%);border:1px solid rgba(255,143,62,.2);border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.035)}
.vault .tb{position:relative;z-index:1}.vault .badge{padding:5px 11px;background:rgba(255,106,26,.12);border:1px solid rgba(255,139,64,.18)}
.vault .vb{margin-top:12px;font-size:26px;letter-spacing:-.03em;line-height:1.15}.vault .vb small{font-size:13px;letter-spacing:0;color:#a5a8b1}.vault #usd{margin-top:6px}
.vault .two{gap:0;margin:22px 0 14px;padding:14px 0;border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.08)}
.vault .two div{padding:2px 14px 2px 0;background:transparent;border-radius:0}.vault .two div+div{padding:2px 0 2px 16px;border-left:1px solid rgba(255,255,255,.09)}.vault .two b{margin-top:5px;font-size:18px;letter-spacing:-.02em}
.vault .rw{margin:0 0 20px;padding:14px 0;border:0;border-bottom:1px solid rgba(255,255,255,.08);border-radius:0;background:transparent}.vault .rw .lbl{font-size:12px}.vault .rw b{margin-top:4px;font-size:14px}.vault .rw .btn.pri{padding:8px 15px;border-radius:999px;background:rgba(255,106,26,.1);border:1px solid rgba(255,130,49,.42);color:#ff9856;box-shadow:none}.vault .rw .btn.pri:hover{background:rgba(255,106,26,.18)}
.vault>.lbl{font-size:12px}.vault .seg{gap:10px;margin:9px 0 14px}.vault .seg button{padding:8px 2px 10px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--mut);transition:color .2s,border-color .2s}.vault .seg button.on{border-color:var(--acc);background:transparent;color:var(--acc);box-shadow:none}.vault .seg button b{font-size:13px}.vault .seg button span{font-size:11px}.vault .seg button i{font-size:9px;height:12px;letter-spacing:3px}
.vault .amt{padding:1px 0 3px;border:0;border-bottom:1px solid rgba(255,255,255,.16);border-radius:0;background:transparent}.vault .amt:focus-within{border-color:var(--acc)}.vault .amt input{padding:10px 0;font-size:20px}.vault .amt .lbl{font-size:11px}.vault .amt button{padding:6px 0 6px 10px;font-size:11px}
.vault .est{margin:14px 0 17px;padding-bottom:13px;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px}.vault .est b{font-size:12px}
.vault .slide{height:48px;border:1px solid rgba(255,139,64,.25);background:#282019;box-shadow:inset 0 1px 4px rgba(0,0,0,.35)}.vault .slide .sl-fill{background:linear-gradient(90deg,#b84d16,#ff791f 78%,#ffad43)}.vault .slide .sl-handle{top:4px;left:4px;width:38px;height:38px;box-shadow:0 2px 12px rgba(0,0,0,.35)}.vault .slide .sl-label{font-size:12px;color:#ffe1c2}
@media(max-width:520px){.card.vault{padding:19px}.vault .vb{font-size:26px}.vault .two b{font-size:16px}.vault .seg{gap:6px}}
@media(max-width:520px){.utility-rail{grid-template-columns:1fr;padding:8px 0}.utility-item,.utility-item:first-child{padding:13px 4px}.utility-item+.utility-item,.utility-item:nth-child(3){border-left:0}.utility-item+.utility-item{border-top:1px solid var(--line);margin-top:4px}.utility-item:nth-child(n+3){padding-top:13px}}
/* Collapsed sidebar becomes the same icon dock used by the other dashboards. */
@media(min-width:821px){.app.off .side{position:fixed;left:50%;right:auto;top:6px;bottom:auto;width:max-content;max-width:calc(100vw - 112px);height:52px;margin:0;transform:translateX(-50%);flex-direction:row;align-items:center;gap:4px;padding:6px 8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 26px -20px rgba(0,0,0,.65);opacity:1;pointer-events:auto;z-index:56;transition:left .45s cubic-bezier(.4,0,.2,1),top .45s cubic-bezier(.4,0,.2,1),height .35s cubic-bezier(.4,0,.2,1),opacity .3s ease}.app.off .side::-webkit-scrollbar{display:none}.app.off .logo{width:auto;padding:0 5px;flex:none}.app.off .logo .wm,.app.off .grp,.app.off .me{display:none}.app.off .molten{display:none}.app.off .dock{flex-direction:row;gap:2px;flex:none}.app.off .dock+.dock{margin-left:4px;padding-left:6px;border-left:1px solid var(--line)}.app.off .dock a{justify-content:center;min-width:42px;padding:8px 10px;gap:0;background:none}.app.off .dock a .ntx{display:inline-block;max-width:0;overflow:hidden;opacity:0;font-size:11px;color:var(--tx);white-space:nowrap;transition:max-width .3s cubic-bezier(.4,0,.2,1),opacity .22s ease,margin .3s cubic-bezier(.4,0,.2,1)}.app.off .dock a:hover .ntx,.app.off .dock a:focus-visible .ntx{max-width:130px;opacity:1;margin-left:7px}}
@media(max-width:820px){.app.off .side{position:fixed;left:50%;right:auto;top:6px;bottom:auto;width:max-content;max-width:calc(100vw - 16px);height:52px;margin:0;transform:translateX(-50%);z-index:56;display:flex;flex-direction:row;align-items:center;gap:4px;padding:6px 8px;overflow-x:auto;overflow-y:hidden;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 26px -20px rgba(0,0,0,.65);opacity:1;pointer-events:auto}.app.off .side .logo .wm,.app.off .side .grp,.app.off .side .me{display:none}.app.off .side .logo{padding:0 5px;flex:none}.app.off .dock{flex-direction:row;gap:2px;flex:none}.app.off .dock+.dock{margin-left:4px;padding-left:6px;border-left:1px solid var(--line)}.app.off .dock a{justify-content:center;min-width:42px;padding:8px 10px;gap:0}.app.off .dock a .ntx{display:none}.app.off .molten{display:none}}
`;
