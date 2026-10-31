"use client";

import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import { useSession } from "next-auth/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

import AccessDeniedNotice from "@/components/AccessDeniedNotice";
import { landingStyles } from "@/lib/design/landing-styles";

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const TYPEWRITER_PHRASES = [
  "Copy top traders.",
  "Understand each move.",
  "Set your risk limits.",
  "Grow your portfolio.",
];

const COINS = [
  ["BTC", "67,420.50", 2.41],
  ["ETH", "3,512.18", 1.86],
  ["USDT", "1.00", 0.01],
  ["SOL", "172.94", -1.32],
  ["BNB", "598.30", 0.74],
  ["XRP", "0.6231", -0.58],
  ["ADA", "0.4587", 3.12],
  ["DOGE", "0.1624", -2.05],
  ["EMBER", "0.0842", 5.67],
] as const;

const TRADERS = [
  { name: "AlphaWave", color: "#ffb020", risk: "Low", returnPct: 32.4, freq: 0.9, seed: 2.1 },
  { name: "NovaFlow", color: "#ff6b00", risk: "Medium", returnPct: 21.8, freq: 0.7, seed: 3.7 },
  { name: "SteadyEdge", color: "#2fbd83", risk: "Low", returnPct: 12.1, freq: 0.5, seed: 5.3 },
  { name: "PulseX", color: "#ff9e00", risk: "High", returnPct: 48.9, freq: 1.5, seed: 7.9 },
];

function generateSparklinePoints(seed: number, freq: number): string {
  const points: string[] = [];
  for (let i = 0; i < 12; i++) {
    const y = 18 - (i * freq * 1.2 + Math.sin(i * seed) * 2.5 + 1);
    points.push(`${(i * 5.4).toFixed(1)},${Math.max(2, Math.min(20, y)).toFixed(1)}`);
  }
  return points.join(" ");
}

const FAQ_ITEMS = [
  {
    q: "How does copy trading work on Prometheus?",
    a: "Prometheus allows you to connect your wallet, select vetted top-performing traders based on verified on-chain P&L, and automatically mirror their trades in real-time with your own custom risk limits.",
  },
  {
    q: "Are my funds non-custodial and safe?",
    a: "Yes. Prometheus operates on a non-custodial architecture. You maintain full ownership of your assets at all times. Trades are executed via audited smart contracts, and you can withdraw or disconnect at any time.",
  },
  {
    q: "What makes the AI Trading Buddy unique?",
    a: "Our AI Trading Buddy monitors market signals 24/7 and explains complex market movements, price drops, and copied trade rationales in plain, human-friendly terms right inside your chat interface.",
  },
  {
    q: "How does zero explicit brokerage for USDT work?",
    a: "Prometheus aggregates liquidity directly from major DEXs and market makers to route your swaps with transparent pricing, zero added brokerage fee, and no hidden spread markups.",
  },
  {
    q: "What are the tokenomics and burn mechanism of EMBER?",
    a: "A portion of overall protocol revenues is allocated weekly to automated open-market buybacks of EMBER tokens, which are permanently burned to reduce supply and reward long-term stakers.",
  },
];

export default function LandingPage() {
  const { status } = useSession();
  const signedIn = status === "authenticated";
  const primaryHref = signedIn ? "/dashboard" : "/login";

  // Canvas refs for animated live candlestick background chart
  const cvRef = useRef<HTMLCanvasElement>(null);
  const cv2Ref = useRef<HTMLCanvasElement>(null);

  // Phone screen ref and step state for scroll story
  const screenRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [prevStep, setPrevStep] = useState<number | null>(null);
  const activeStepRef = useRef(0);
  useEffect(() => {
    activeStepRef.current = activeStep;
  }, [activeStep]);

  // Tablet stage refs for 3D tilt
  const stage1Ref = useRef<HTMLDivElement>(null);
  const stage2Ref = useRef<HTMLDivElement>(null);

  // Hero typewriter
  const [typewriterText, setTypewriterText] = useState(TYPEWRITER_PHRASES[0]);

  // Exchange tablet interactive state
  const [coin, setCoin] = useState<"BTC" | "ETH" | "SOL" | "EMBER">("BTC");
  const [payAmt, setPayAmt] = useState<string>("100");
  const [prices, setPrices] = useState({ BTC: 67420.5, ETH: 3512.18, SOL: 172.94, EMBER: 0.0842 });
  const [rateFlash, setRateFlash] = useState<"fu" | "fd" | "">("");
  const [exchangeStatus, setExchangeStatus] = useState<"idle" | "processing" | "done">("idle");
  const [receivedSummary, setReceivedSummary] = useState<string>("");

  // Copy trading tablet interactive state
  const [copiedMap, setCopiedMap] = useState<Record<number, boolean>>({});
  const [copyRisk, setCopyRisk] = useState<number>(2);
  const [pnl, setPnl] = useState<number>(0);

  // ROI Calculator state
  const [calcAmt, setCalcAmt] = useState<number>(5000);
  const [calcApy, setCalcApy] = useState<number>(28);
  const [calcRiskName, setCalcRiskName] = useState<string>("Balanced");
  const [calcTerm, setCalcTerm] = useState<number>(1);
  const [calcTermName, setCalcTermName] = useState<string>("1 Year");

  // FAQ open item
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // CTA form submitted state
  const [ctaSubmitted, setCtaSubmitted] = useState(false);

  // ─────────────────────────────────────────────────────────────
  // 1. Candlestick Chart Animation on <canvas id="cv"> and <canvas id="cv2">
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = cvRef.current;
    const f = cv2Ref.current;
    if (!c || !f) return;
    const x = c.getContext("2d");
    const y = f.getContext("2d");
    if (!x || !y) return;

    let W = c.clientWidth;
    let H = c.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = 20;
    type Candle = { o: number; c: number; h: number; l: number; v: number };
    let cs: Candle[] = [];
    let lo = 90;
    let hi = 110;
    let prog = 0;
    let cnt = 0;
    let last = 0;
    const T = 1400;
    let xr = W * 0.88;
    let vis = true;
    let run = false;
    let animId = 0;
    const UP = "47,189,131";
    const DN = "255,84,112";
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;

    function tick(d: Candle, m: number) {
      d.c += (Math.random() - 0.47) * m;
      d.h = Math.max(d.h, d.c + Math.random() * 0.15);
      d.l = Math.min(d.l, d.c - Math.random() * 0.15);
      d.v = Math.min(1, d.v + Math.random() * 0.03);
    }
    function mk(o: number): Candle {
      return { o, c: o, h: o, l: o, v: 0.25 };
    }
    function seed() {
      cs = [];
      let o = 100;
      const n = Math.ceil(W / cw) + 5;
      for (let i = 0; i < n; i++) {
        const d = mk(o);
        for (let k = 0; k < 14; k++) tick(d, 0.9);
        cs.push(d);
        o = d.c;
      }
    }
    let top = H * 0.16;
    let bot = H * 0.68;
    function Y(v: number) {
      return top + (bot - top) * (1 - (v - lo) / (hi - lo));
    }
    function size() {
      if (!c || !f) return;
      W = c.clientWidth;
      H = c.clientHeight;
      xr = W * 0.88;
      [c, f].forEach((k) => {
        k.width = W * dpr;
        k.height = H * dpr;
      });
      x?.setTransform(dpr, 0, 0, dpr, 0, 0);
      y?.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      lo = 90;
      hi = 110;
      draw();
    }
    function candles(g: CanvasRenderingContext2D, sc: number, alpha: number, glow: boolean) {
      cs.forEach((d, i) => {
        const px = xr - (cs.length - 1 - i) * cw * sc + cw * sc * (1 - prog);
        if (px < -cw * 3 || px > W + cw * 3) return;
        const col = d.c >= d.o ? UP : DN;
        g.strokeStyle = g.fillStyle = "rgba(" + col + "," + alpha + ")";
        if (glow) {
          g.shadowColor = "rgba(" + col + ",.6)";
          g.shadowBlur = 12;
        }
        g.lineWidth = Math.max(1.5, cw * sc * 0.08);
        g.beginPath();
        g.moveTo(px, Y(d.h));
        g.lineTo(px, Y(d.l));
        g.stroke();
        const bw = cw * sc * 0.58;
        const hh = Math.max(2, Math.abs(Y(d.o) - Y(d.c)));
        g.fillRect(px - bw / 2, Y(Math.max(d.o, d.c)), bw, hh);
      });
      g.shadowBlur = 0;
    }
    function draw() {
      if (!x || !y) return;
      top = H * 0.16;
      bot = H * 0.68;
      const L = cs[cs.length - 1];
      if (!L) return;
      let mn = 1e9;
      let mx = -1e9;
      cs.forEach((d, k) => {
        const px = xr - (cs.length - 1 - k) * cw + cw * (1 - prog);
        if (px > -cw && px < W) {
          mn = Math.min(mn, d.l);
          mx = Math.max(mx, d.h);
        }
      });
      const pad = (mx - mn) * 0.14;
      lo += (mn - pad - lo) * 0.06;
      hi += (mx + pad - hi) * 0.06;
      x.clearRect(0, 0, W, H);
      y.clearRect(0, 0, W, H);
      x.strokeStyle = "rgba(255,180,120,.07)";
      x.lineWidth = 1;
      for (let i = 0; i <= 6; i++) {
        const gy = top + ((bot - top) * i) / 6;
        x.beginPath();
        x.moveTo(0, gy);
        x.lineTo(W, gy);
        x.stroke();
      }
      const gs = 110;
      const go = ((cnt + prog) * cw) % gs;
      for (let gx = -go; gx < W; gx += gs) {
        x.beginPath();
        x.moveTo(gx, top - 24);
        x.lineTo(gx, H * 0.94);
        x.stroke();
      }
      // volume
      cs.forEach((d, k) => {
        const px = xr - (cs.length - 1 - k) * cw + cw * (1 - prog);
        if (px < -cw || px > W + cw) return;
        x.fillStyle = "rgba(" + (d.c >= d.o ? UP : DN) + ",.16)";
        const vh = d.v * H * 0.11;
        x.fillRect(px - cw * 0.29, H * 0.9 - vh, cw * 0.58, vh);
      });
      // line + area
      function X(k: number) {
        return xr - (cs.length - 1 - k) * cw + cw * (1 - prog);
      }
      x.beginPath();
      cs.forEach((d, k) => {
        const px = X(k);
        const py = Y(d.c);
        if (k) x.lineTo(px, py);
        else x.moveTo(px, py);
      });
      x.strokeStyle = "rgba(255,176,32,.85)";
      x.lineWidth = 2;
      x.shadowColor = "rgba(255,107,0,.9)";
      x.shadowBlur = 14;
      x.stroke();
      x.shadowBlur = 0;
      x.lineTo(X(cs.length - 1), bot + 30);
      x.lineTo(X(0), bot + 30);
      const gr = x.createLinearGradient(0, top, 0, bot + 30);
      gr.addColorStop(0, "rgba(255,140,0,.22)");
      gr.addColorStop(1, "rgba(255,140,0,0)");
      x.fillStyle = gr;
      x.fill();
      candles(y, 2.4, 0.9, false);
      candles(x, 1, 0.9, true);

      // live price tag
      const py = Y(L.c);
      const col = L.c >= L.o ? UP : DN;
      x.setLineDash([5, 6]);
      x.strokeStyle = "rgba(" + col + ",.65)";
      x.beginPath();
      x.moveTo(0, py);
      x.lineTo(W, py);
      x.stroke();
      x.setLineDash([]);
      const txt = (67000 + (L.c - 100) * 70).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      x.font = "600 12px Inter,sans-serif";
      const tw = x.measureText(txt).width + 18;
      x.fillStyle = "rgb(" + col + ")";
      if (x.roundRect) {
        x.beginPath();
        x.roundRect(W - tw - 8, py - 11, tw, 22, 6);
        x.fill();
      } else {
        x.fillRect(W - tw - 8, py - 11, tw, 22);
      }
      x.fillStyle = "#0c0602";
      x.textBaseline = "middle";
      x.fillText(txt, W - tw, py + 0.5);
    }
    function frame(t: number) {
      if (!vis || reduce) {
        run = false;
        return;
      }
      const dt = Math.min(t - last, 60);
      last = t;
      prog += dt / T;
      tick(cs[cs.length - 1], 0.3);
      if (prog >= 1) {
        prog -= 1;
        cnt++;
        cs.push(mk(cs[cs.length - 1].c));
        cs.shift();
      }
      draw();
      animId = requestAnimationFrame(frame);
    }
    function start() {
      if (run || reduce) return;
      run = true;
      last = performance.now();
      animId = requestAnimationFrame(frame);
    }

    size();
    window.addEventListener("resize", size);
    start();

    let observer: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window && c.parentElement) {
      observer = new IntersectionObserver((entries) => {
        vis = entries[0].isIntersecting;
        if (vis) start();
      });
      observer.observe(c.parentElement);
    }

    return () => {
      window.removeEventListener("resize", size);
      if (observer) observer.disconnect();
      cancelAnimationFrame(animId);
    };
  }, []);

  // ─────────────────────────────────────────────────────────────
  // 2. Typewriter Effect (Letter-by-letter with blinking caret)
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    let phraseIndex = 0;
    let charIndex = TYPEWRITER_PHRASES[0].length;
    let deleting = false;
    let timer: NodeJS.Timeout;

    function tick() {
      const phrase = TYPEWRITER_PHRASES[phraseIndex];
      if (!deleting) {
        charIndex++;
        setTypewriterText(phrase.slice(0, charIndex));
        if (charIndex >= phrase.length) {
          deleting = true;
          timer = setTimeout(tick, 1750);
          return;
        }
        timer = setTimeout(tick, 82);
        return;
      }
      charIndex--;
      setTypewriterText(phrase.slice(0, charIndex));
      if (charIndex <= 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % TYPEWRITER_PHRASES.length;
        timer = setTimeout(tick, 260);
        return;
      }
      timer = setTimeout(tick, 38);
    }

    timer = setTimeout(tick, 1500);
    return () => clearTimeout(timer);
  }, []);

  // ─────────────────────────────────────────────────────────────
  // 3. Tablet Stages 3D Tilt (Scroll depth tilt + Mousemove tilt)
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const stages = [stage1Ref.current, stage2Ref.current].filter(Boolean) as HTMLDivElement[];

    if (reduce) {
      stages.forEach((st) => st.style.setProperty("--t", "1"));
      return;
    }

    const cleanups: (() => void)[] = [];

    stages.forEach((st) => {
      const onMove = (e: MouseEvent) => {
        const r = st.getBoundingClientRect();
        st.style.setProperty("--mx", String(((e.clientX - r.left) / r.width - 0.5) * 12));
        st.style.setProperty("--my", String(((e.clientY - r.top) / r.height - 0.5) * -10));
      };
      const onLeave = () => {
        st.style.setProperty("--mx", "0");
        st.style.setProperty("--my", "0");
      };
      st.addEventListener("mousemove", onMove);
      st.addEventListener("mouseleave", onLeave);
      cleanups.push(() => {
        st.removeEventListener("mousemove", onMove);
        st.removeEventListener("mouseleave", onLeave);
      });
    });

    let ticking = false;
    function upd() {
      ticking = false;
      const vh = window.innerHeight;
      stages.forEach((st) => {
        const r = st.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - vh / 2) / (vh * 0.55);
        st.style.setProperty("--t", Math.max(0, Math.min(1, 1 - d)).toFixed(3));
      });
    }
    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(upd);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    upd();

    return () => {
      cleanups.forEach((c) => c());
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // ─────────────────────────────────────────────────────────────
  // 4. Story Section IntersectionObserver & Scanline Glitch
  // ─────────────────────────────────────────────────────────────
  const switchStep = (nextIndex: number) => {
    if (nextIndex === activeStepRef.current) return;
    setPrevStep(activeStepRef.current);
    activeStepRef.current = nextIndex;
    if (screenRef.current) {
      screenRef.current.classList.add("glitch");
      setTimeout(() => {
        screenRef.current?.classList.remove("glitch");
      }, 300);
    }
    setActiveStep(nextIndex);
    setTimeout(() => {
      setPrevStep(null);
    }, 380);
  };

  useEffect(() => {
    const stepElements = document.querySelectorAll<HTMLElement>(".story .step");
    if (!stepElements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            const idx = Number(e.target.getAttribute("data-i"));
            if (!isNaN(idx)) {
              switchStep(idx);
            }
          }
        });
      },
      { rootMargin: "-40% 0px -40% 0px" },
    );

    stepElements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // ─────────────────────────────────────────────────────────────
  // 5. Interactive Exchange Tablet Rate & Calculation
  // ─────────────────────────────────────────────────────────────
  const currentPrice = prices[coin];
  const parsedPay = parseFloat(payAmt) || 0;
  const decimals = coin === "BTC" ? 6 : coin === "ETH" ? 5 : coin === "SOL" ? 4 : 2;
  const receiveAmt = (parsedPay / currentPrice).toFixed(decimals);
  const isInsufficient = parsedPay > 1850;

  // Live price fluctuation simulation
  useEffect(() => {
    const timer = setInterval(() => {
      const oldPrice = prices[coin];
      setPrices((prev) => {
        const next = { ...prev };
        for (const k in next) {
          next[k as keyof typeof next] *= 1 + (Math.random() - 0.5) * 0.004;
        }
        return next;
      });
      setRateFlash(prices[coin] >= oldPrice ? "fu" : "fd");
      setTimeout(() => setRateFlash(""), 350);
    }, 1600);
    return () => clearInterval(timer);
  }, [coin, prices]);

  const handleExchange = () => {
    if (exchangeStatus !== "idle" || isInsufficient || parsedPay <= 0) return;
    setExchangeStatus("processing");
    setTimeout(() => {
      setReceivedSummary(`✓ Received ${receiveAmt} ${coin}`);
      setExchangeStatus("done");
      setTimeout(() => {
        setExchangeStatus("idle");
        setReceivedSummary("");
      }, 2400);
    }, 1100);
  };

  // ─────────────────────────────────────────────────────────────
  // 6. Interactive Copy Trading Desk Simulation
  // ─────────────────────────────────────────────────────────────
  const copiedCount = Object.keys(copiedMap).length;
  useEffect(() => {
    if (copiedCount === 0) return;
    const timer = setInterval(() => {
      let delta = 0;
      Object.keys(copiedMap).forEach((idxStr) => {
        const idx = Number(idxStr);
        const trader = TRADERS[idx];
        if (trader) {
          delta += (Math.random() - 0.36) * trader.freq * copyRisk * 1.6;
        }
      });
      setPnl((prev) => prev + delta);
    }, 900);
    return () => clearInterval(timer);
  }, [copiedCount, copiedMap, copyRisk]);

  const toggleCopy = (idx: number) => {
    setCopiedMap((prev) => {
      const next = { ...prev };
      if (next[idx]) delete next[idx];
      else next[idx] = true;
      return next;
    });
  };

  // ─────────────────────────────────────────────────────────────
  // 7. Interactive ROI Calculator Calculations
  // ─────────────────────────────────────────────────────────────
  const calcProfit = calcAmt * (calcApy / 100) * calcTerm;
  const calcTotal = calcAmt + calcProfit;
  const calcMonthly = calcProfit / (calcTerm * 12);
  const calcReturnPct = ((calcProfit / calcAmt) * 100).toFixed(1);

  // ─────────────────────────────────────────────────────────────
  // 8. GSAP ScrollTrigger + Lenis Smooth Scroll Integration
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const IBI_EASE = "cubic-bezier(0.42,0,0.33,1)";

    // Lenis instance
    let lenis: Lenis | null = null;
    if (!reduce) {
      lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smoothWheel: true,
        syncTouch: false,
        touchMultiplier: 1.8,
      });

      gsap.registerPlugin(ScrollTrigger);

      gsap.ticker.add((time) => {
        lenis?.raf(time * 1000);
      });
      gsap.ticker.lagSmoothing(0);
      lenis.on("scroll", ScrollTrigger.update);
    } else {
      gsap.registerPlugin(ScrollTrigger);
    }

    // Scroll progress bar
    const bar = document.getElementById("scroll-progress");
    const progressTrigger = ScrollTrigger.create({
      trigger: document.body,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self) => {
        if (bar) bar.style.width = self.progress * 100 + "%";
      },
    });

    // Hero scroll hint hide
    const hint = document.getElementById("scrollHint");
    let hintTrigger: ScrollTrigger | null = null;
    if (hint && !reduce) {
      hintTrigger = ScrollTrigger.create({
        start: "60px top",
        onEnter: () => hint.classList.add("hidden"),
        onLeaveBack: () => hint.classList.remove("hidden"),
      });
    }

    // Hero parallax (bg + canvases scrub)
    const heroBg = document.querySelector(".hero .bg");
    const cv = cvRef.current;
    const cv2 = cv2Ref.current;
    const hero = document.querySelector(".hero");

    if (!reduce && hero) {
      if (heroBg) {
        gsap.to(heroBg, {
          yPercent: 30,
          ease: "none",
          scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: 1 },
        });
      }
      if (cv) {
        gsap.to(cv, {
          yPercent: 18,
          ease: "none",
          scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: 1.4 },
        });
      }
      if (cv2) {
        gsap.to(cv2, {
          yPercent: 12,
          ease: "none",
          scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: 1.8 },
        });
      }
    }

    // Hero entrance timeline
    let heroTl: gsap.core.Timeline | null = null;
    if (!reduce) {
      heroTl = gsap.timeline({ delay: 0.15, defaults: { ease: IBI_EASE } });
      const nav = document.querySelector("nav");
      const eyebrow = document.querySelector(".hero-in .eyebrow");
      const h1 = document.querySelector(".hero-in h1");
      const sub = document.querySelector(".hero-in .sub");
      const cta = document.querySelector(".hero-in .cta");
      const glass = document.querySelector(".hero .glass");
      const liveTag = document.querySelector(".live");

      if (nav) heroTl.fromTo(nav, { autoAlpha: 0, y: -16 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 0);
      if (eyebrow) heroTl.fromTo(eyebrow, { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.65 }, 0.1);
      if (h1) heroTl.fromTo(h1, { autoAlpha: 0, y: 32 }, { autoAlpha: 1, y: 0, duration: 0.85 }, 0.2);
      if (sub) heroTl.fromTo(sub, { autoAlpha: 0, y: 22 }, { autoAlpha: 1, y: 0, duration: 0.75 }, 0.35);
      if (cta) heroTl.fromTo(cta, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.65 }, 0.46);
      if (glass) heroTl.fromTo(glass, { autoAlpha: 0, x: 36, scale: 0.96 }, { autoAlpha: 1, x: 0, scale: 1, duration: 1 }, 0.1);
      if (liveTag) heroTl.fromTo(liveTag, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 }, 0.6);
      if (hint) heroTl.fromTo(hint, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 0.8);

      const marqEl = document.querySelector(".tick.marq");
      if (marqEl) gsap.fromTo(marqEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8, ease: IBI_EASE, delay: 0.65 });
    }

    // Clean scroll reveal for headings (safe for React without innerHTML mutation)
    if (!reduce) {
      gsap.utils.toArray<HTMLElement>(".sh, .sec-head h2, .cta-banner h2").forEach((el) => {
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: 32 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.85,
            ease: IBI_EASE,
            scrollTrigger: { trigger: el, start: "top 86%", toggleActions: "play none none none" },
          },
        );
      });
    }

    // Scroll reveals
    if (!reduce) {
      gsap.utils.toArray<HTMLElement>(".sec-head").forEach((el) => {
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: 44 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.95,
            ease: IBI_EASE,
            scrollTrigger: { trigger: el, start: "top 86%", toggleActions: "play none none none" },
          },
        );
      });

      gsap.utils.toArray<HTMLElement>(".xch .xtxt").forEach((el) => {
        const isCopy = el.closest(".xch.cp") !== null;
        gsap.fromTo(
          el,
          { autoAlpha: 0, x: isCopy ? 40 : -40 },
          {
            autoAlpha: 1,
            x: 0,
            duration: 1.05,
            ease: IBI_EASE,
            scrollTrigger: { trigger: el, start: "top 82%", toggleActions: "play none none none" },
          },
        );
      });

      gsap.utils.toArray<HTMLElement>(".stage").forEach((el) => {
        const isMir = el.classList.contains("mir");
        gsap.fromTo(
          el,
          { autoAlpha: 0, x: isMir ? -48 : 48 },
          {
            autoAlpha: 1,
            x: 0,
            duration: 1.1,
            ease: IBI_EASE,
            scrollTrigger: { trigger: el, start: "top 84%", toggleActions: "play none none none" },
          },
        );
      });

      const calcCard = document.querySelector(".calc-card");
      if (calcCard) {
        gsap.fromTo(
          calcCard,
          { autoAlpha: 0, y: 56, scale: 0.97 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: 1.05,
            ease: IBI_EASE,
            scrollTrigger: { trigger: calcCard, start: "top 84%", toggleActions: "play none none none" },
          },
        );
      }

      gsap.utils.toArray<HTMLElement>(".faq-item").forEach((el, i) => {
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: 28, x: -16 },
          {
            autoAlpha: 1,
            y: 0,
            x: 0,
            duration: 0.75,
            delay: i * 0.055,
            ease: IBI_EASE,
            scrollTrigger: { trigger: el, start: "top 90%", toggleActions: "play none none none" },
          },
        );
      });

      const ctaBanner = document.querySelector(".cta-banner");
      if (ctaBanner) {
        gsap.fromTo(
          ctaBanner,
          { autoAlpha: 0, scale: 0.95, y: 44 },
          {
            autoAlpha: 1,
            scale: 1,
            y: 0,
            duration: 1.1,
            ease: IBI_EASE,
            scrollTrigger: { trigger: ctaBanner, start: "top 86%", toggleActions: "play none none none" },
          },
        );
      }

      const footerGrid = document.querySelector(".footer-grid");
      if (footerGrid) {
        gsap.utils.toArray<HTMLElement>(".footer-brand, .footer-col").forEach((el, i) => {
          gsap.fromTo(
            el,
            { autoAlpha: 0, y: 28 },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.8,
              delay: i * 0.07,
              ease: IBI_EASE,
              scrollTrigger: { trigger: footerGrid, start: "top 88%", toggleActions: "play none none none" },
            },
          );
        });
      }

      const beam = document.querySelector(".beam");
      const story = document.querySelector(".story");
      if (beam && story) {
        gsap.to(beam, {
          opacity: 0.25,
          scaleY: 1.4,
          ease: "none",
          scrollTrigger: { trigger: story, start: "top bottom", end: "bottom top", scrub: 2 },
        });
      }
    }

    // Marquee velocity speedup
    let velAnimId = 0;
    if (lenis && !reduce) {
      const tracks = document.querySelectorAll<HTMLElement>(".track");
      const baseDurations: number[] = [];
      tracks.forEach((t) => {
        baseDurations.push(parseFloat(getComputedStyle(t).animationDuration) || 45);
      });
      function velLoop() {
        const v = Math.abs(lenis?.velocity || 0);
        const speedup = Math.min(v * 0.018, 0.25);
        tracks.forEach((t, i) => {
          t.style.animationDuration = baseDurations[i] * (1 - speedup) + "s";
        });
        velAnimId = requestAnimationFrame(velLoop);
      }
      velAnimId = requestAnimationFrame(velLoop);
    }

    // Smooth scroll for anchor links
    const handleAnchorClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a[href^="#"]');
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href || href === "#") return;
      const destEl = document.querySelector<HTMLElement>(href);
      if (!destEl) return;
      e.preventDefault();
      const dest = destEl.getBoundingClientRect().top + window.scrollY;
      if (lenis) {
        lenis.scrollTo(dest, { duration: 1.4 });
      } else {
        window.scrollTo({ top: dest, behavior: "smooth" });
      }
    };
    document.addEventListener("click", handleAnchorClick);

    ScrollTrigger.refresh();

    return () => {
      document.removeEventListener("click", handleAnchorClick);
      cancelAnimationFrame(velAnimId);
      progressTrigger.kill();
      hintTrigger?.kill();
      heroTl?.kill();
      ScrollTrigger.getAll().forEach((t) => t.kill());
      lenis?.destroy();
    };
  }, []);

  return (
    <div className={`lp ${instrumentSerif.variable}`}>
      <style dangerouslySetInnerHTML={{ __html: landingStyles }} />
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .lp-nav-links { display: flex; align-items: center; gap: 28px; margin-left: auto; margin-right: 20px; }
            .lp-nav-links a { color: var(--mut); text-decoration: none; font-size: 14px; font-weight: 500; transition: color .2s; }
            .lp-nav-links a:hover { color: var(--fg); }
            .lp-nav-actions { display: flex; align-items: center; gap: 12px; }
            @media (max-width: 860px) { .lp-nav-links { display: none; } }
            .split-word, .word-inner { display: inline !important; transform: none !important; opacity: 1 !important; }
          `,
        }}
      />

      {/* Top scroll progress indicator */}
      <div id="scroll-progress" />

      {/* Refusal notice after a denied elevated sign-in (MODULE 13). It is
          one-shot (sessionStorage) and renders nothing once consumed. */}
      <AccessDeniedNotice />

      {/* HERO SECTION */}
      <header className="hero">
        <div className="bg" />
        <canvas id="cv2" className="cv cvf" ref={cv2Ref} />
        <canvas id="cv" className="cv" ref={cvRef} />

        <div className="wrap" style={{ width: "100%", flex: 1, display: "flex", flexDirection: "column" }}>
          <nav aria-label="Main">
            <Link className="logo" href="/">
              <BrandMark />
              Prometheus
            </Link>
            <div className="lp-nav-links">
              <a href="#features">How it works</a>
              <a href="#exchange">Exchange</a>
              <a href="#copy">Copy trading</a>
              <a href="#calculator">Calculator</a>
              <a href="#faq">FAQ</a>
            </div>
            <div className="lp-nav-actions">
              <Link className="btn sm" href={primaryHref}>
                {signedIn ? "Open dashboard" : "Sign in"}
              </Link>
            </div>
          </nav>

          <div className="hero-in">
            <div>
              <div className="eyebrow">Copy trading · Wallet · EMBER</div>
              <h1>
                Trade smarter.
                <br />
                <em>
                  <span id="hero-typewriter" aria-label={typewriterText}>
                    {typewriterText}
                  </span>
                  <span className="typewriter-caret" aria-hidden="true" />
                </em>
              </h1>
              <p className="sub">
                Your wallet, portfolio and intelligent copy trading in one place — with an AI buddy that
                explains every move.
              </p>
              <div className="cta" id="start">
                <a className="btn" href="#calculator">
                  Launch the prototype
                </a>
                <a className="btn ghost" href="#features">
                  How it works
                </a>
              </div>
            </div>

            <div className="glass">
              <small>Portfolio · 30 days</small>
              <div className="big">
                <span>+18.6%</span>
              </div>
              <p>Following 3 top traders</p>
              <svg viewBox="0 0 300 70" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#2fbd83" stopOpacity=".35" />
                    <stop offset="1" stopColor="#2fbd83" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d="M0 58 L30 52 L55 55 L85 40 L115 44 L145 28 L175 33 L205 20 L240 24 L270 10 L300 6 V70 H0Z"
                  fill="url(#s)"
                />
                <path
                  d="M0 58 L30 52 L55 55 L85 40 L115 44 L145 28 L175 33 L205 20 L240 24 L270 10 L300 6"
                  fill="none"
                  stroke="#2fbd83"
                  strokeWidth="2"
                />
              </svg>
              <div className="row">
                <span>Balance</span>
                <b>$12,480.20</b>
              </div>
            </div>
          </div>
        </div>

        <div className="live">BTC/USDT · Live simulation</div>
      </header>

      {/* MARQUEE TICKER */}
      <div className="tick marq">
        <div className="track" id="coins">
          {[...COINS, ...COINS].map(([name, price, change], i) => {
            const isUp = change >= 0;
            return (
              <div className="t" key={`${name}-${i}`}>
                <em>{name}</em>
                <span>${price}</span>
                <span className={isUp ? "up" : "dn"}>
                  {isUp ? "▲ +" : "▼ "}
                  {change.toFixed(2)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="wrap">
        {/* STORY / FEATURES SECTION WITH STICKY PHONE AND CONICAL BEAM */}
        <section className="story" id="features">
          <div className="eyebrow">How Prometheus works</div>
          <h2 className="sh">
            One app. <em>Four ideas.</em>
          </h2>

          <div className="story-grid">
            <div className="steps">
              <div className={`step ${activeStep === 0 ? "on" : ""}`} data-i="0" onClick={() => switchStep(0)}>
                <i>01</i>
                <h3>One wallet for everything</h3>
                <p>
                  Hold your assets, swap USDT with zero explicit brokerage and watch your whole portfolio in one clear
                  view.
                </p>
              </div>

              <div className={`step ${activeStep === 1 ? "on" : ""}`} data-i="1" onClick={() => switchStep(1)}>
                <i>02</i>
                <h3>Copy the best, your way</h3>
                <p>
                  Pick top traders and let adaptive copy trading follow them — with risk limits and treasury
                  guardrails you control.
                </p>
              </div>

              <div className={`step ${activeStep === 2 ? "on" : ""}`} data-i="2" onClick={() => switchStep(2)}>
                <i>03</i>
                <h3>An AI buddy that explains</h3>
                <p>
                  Ask why the market moved. Your Trading Buddy answers in plain language, so every trade teaches you
                  something.
                </p>
              </div>

              <div className={`step ${activeStep === 3 ? "on" : ""}`} data-i="3" onClick={() => switchStep(3)}>
                <i>04</i>
                <h3>EMBER, in the open</h3>
                <p>Follow tokenomics, buybacks and burns live. Nothing hidden — the whole ecosystem is trackable.</p>
              </div>
            </div>

            <div className="phone-col">
              <div className="beam" />
              <div className="phone" data-s={activeStep}>
                <div className="isl" />
                <div className="screen" ref={screenRef}>
                  {/* Pane 0 */}
                  <div className={`pane ${activeStep === 0 ? "on" : prevStep === 0 ? "out" : ""}`}>
                    <small>Total balance</small>
                    <div className="amt">$12,480.20</div>
                    <span className="up sm">▲ +2.4% today</span>
                    <div className="pills">
                      <b>Deposit</b>
                      <b>Swap</b>
                      <b>Send</b>
                    </div>
                    <div className="li">
                      <u style={{ background: "#f7931a" }}>₿</u>
                      <div>
                        Bitcoin<small>0.084 BTC</small>
                      </div>
                      <span>$5,663</span>
                    </div>
                    <div className="li">
                      <u style={{ background: "#627eea" }}>Ξ</u>
                      <div>
                        Ethereum<small>1.2 ETH</small>
                      </div>
                      <span>$4,214</span>
                    </div>
                    <div className="li">
                      <u style={{ background: "#26a17b" }}>₮</u>
                      <div>
                        Tether<small>1,850 USDT</small>
                      </div>
                      <span>$1,850</span>
                    </div>
                    <div className="li">
                      <u style={{ background: "#ff6b00" }}>🔥</u>
                      <div>
                        Ember<small>8,900 EMBER</small>
                      </div>
                      <span>$749</span>
                    </div>
                  </div>

                  {/* Pane 1 */}
                  <div className={`pane ${activeStep === 1 ? "on" : prevStep === 1 ? "out" : ""}`}>
                    <small>Top traders</small>
                    <div className="amt" style={{ fontSize: 22 }}>
                      Copy trading
                    </div>
                    <div className="tr">
                      <u style={{ background: "#ffb020" }}>A</u>
                      <div>
                        AlphaWave<small>Risk · Low</small>
                      </div>
                      <span className="up">+32.4%</span>
                      <b className="cp">Copy</b>
                    </div>
                    <div className="tr">
                      <u style={{ background: "#ff6b00" }}>N</u>
                      <div>
                        NovaFlow<small>Risk · Medium</small>
                      </div>
                      <span className="up">+21.8%</span>
                      <b className="cp">Copy</b>
                    </div>
                    <div className="tr">
                      <u style={{ background: "#2fbd83" }}>S</u>
                      <div>
                        SteadyEdge<small>Risk · Low</small>
                      </div>
                      <span className="up">+12.1%</span>
                      <b className="cp on2">Copying ✓</b>
                    </div>
                    <div className="opt">
                      Adaptive mode<span className="tg" />
                    </div>
                    <div className="opt">
                      Max risk per trade<b>2%</b>
                    </div>
                  </div>

                  {/* Pane 2 */}
                  <div className={`pane ${activeStep === 2 ? "on" : prevStep === 2 ? "out" : ""}`}>
                    <small>AI Trading Buddy</small>
                    <div className="bub me">Why is SOL down today?</div>
                    <div className="bub ai">
                      SOL is down 1.3% as traders take profit after a 3-day run. That&apos;s normal — no major news behind
                      it.
                    </div>
                    <div className="bub ai">Want to see how this affects the trader you copy?</div>
                    <div className="chips">
                      <b>Explain simply</b>
                      <b>Show my risk</b>
                    </div>
                  </div>

                  {/* Pane 3 */}
                  <div className={`pane ${activeStep === 3 ? "on" : prevStep === 3 ? "out" : ""}`}>
                    <small>EMBER</small>
                    <div className="amt">$0.0842</div>
                    <span className="up sm">▲ +5.67%</span>
                    <div className="kv">
                      <span>Total burned</span>
                      <b>12.4M</b>
                    </div>
                    <div className="bars">
                      <i style={{ height: "35%" }} />
                      <i style={{ height: "55%" }} />
                      <i style={{ height: "42%" }} />
                      <i style={{ height: "70%" }} />
                      <i style={{ height: "60%" }} />
                      <i style={{ height: "90%" }} />
                    </div>
                    <small style={{ textAlign: "center", display: "block" }}>Weekly burn</small>
                    <div className="kv">
                      <span>Next buyback</span>
                      <b>3 days</b>
                    </div>
                    <div className="kv">
                      <span>Treasury guardrails</span>
                      <b className="up">Healthy</b>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* INTERACTIVE EXCHANGE 3D TABLET */}
        <section className="xch" id="exchange">
          <div className="xtxt">
            <div className="tag">
              <u>$</u>USDT Exchange
            </div>
            <h2 className="sh">
              Swap USDT with <em>zero</em> explicit brokerage
            </h2>
            <p className="xp">
              Move in and out of USDT in a few taps. See the rate, the amount you receive and every cost before you
              confirm — no explicit brokerage fee, ever.
            </p>
            <Link className="btn" href={signedIn ? "/usdt-exchange" : "/login"}>
              Open exchange &nbsp;→
            </Link>
          </div>

          <div className="stage" id="stage" ref={stage1Ref}>
            <div className="tablet">
              <div className="tscreen">
                <div className="tbar">
                  <span>‹</span>
                  <b className="tab">Exchange</b>
                  <span>Buy</span>
                  <span>History</span>
                  <i />
                </div>
                <div className="swap">
                  <div className="coins" id="coins2">
                    {(["BTC", "ETH", "SOL", "EMBER"] as const).map((c) => (
                      <b key={c} className={coin === c ? "on" : ""} onClick={() => setCoin(c)}>
                        {c}
                      </b>
                    ))}
                  </div>

                  <div className="box">
                    <small>You pay · Balance 1,850 USDT</small>
                    <div className="line">
                      <span className="cur">
                        <u style={{ background: "#26a17b" }}>₮</u>USDT
                      </span>
                      <input
                        id="pay"
                        value={payAmt}
                        inputMode="decimal"
                        aria-label="Amount in USDT"
                        onChange={(e) => setPayAmt(e.target.value.replace(/[^0-9.]/g, ""))}
                      />
                    </div>
                  </div>

                  <div className="mid">⇅</div>

                  <div className="box">
                    <small>You receive</small>
                    <div className="line">
                      <span className="cur" id="rcur">
                        {coin === "BTC" && <u style={{ background: "#f7931a" }}>₿</u>}
                        {coin === "ETH" && <u style={{ background: "#627eea" }}>Ξ</u>}
                        {coin === "SOL" && <u style={{ background: "#9945ff" }}>S</u>}
                        {coin === "EMBER" && <u style={{ background: "#ff6b00" }}>🔥</u>}
                        {coin}
                      </span>
                      <b id="rcv">{receiveAmt}</b>
                    </div>
                  </div>

                  <div className="meta">
                    <span id="rate" className={rateFlash}>
                      1 {coin} ≈ {currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: currentPrice < 1 ? 4 : 2 })} USDT
                    </span>
                    <span>
                      Brokerage <b className="up">0 USDT</b>
                    </span>
                  </div>

                  <div className="amts" id="amts">
                    <b className={payAmt === "100" ? "sel" : ""} onClick={() => setPayAmt("100")}>
                      $100
                    </b>
                    <b className={payAmt === "500" ? "sel" : ""} onClick={() => setPayAmt("500")}>
                      $500
                    </b>
                    <b className={payAmt === "1850" ? "sel" : ""} onClick={() => setPayAmt("1850")}>
                      MAX
                    </b>
                  </div>

                  <div
                    className={`go ${isInsufficient || parsedPay <= 0 ? "dis" : ""} ${exchangeStatus === "done" ? "ok" : ""}`}
                    id="go"
                    role="button"
                    tabIndex={0}
                    onClick={handleExchange}
                  >
                    {exchangeStatus === "processing"
                      ? "Processing…"
                      : exchangeStatus === "done"
                      ? receivedSummary
                      : "Exchange"}
                  </div>

                  <div className="err" id="err">
                    {isInsufficient ? "Insufficient balance" : ""}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* INTERACTIVE COPY TRADING 3D TABLET */}
        <section className="xch cp" id="copy">
          <div className="stage mir" id="stage2" ref={stage2Ref}>
            <div className="tablet">
              <div className="tscreen">
                <div className="tbar">
                  <span>‹</span>
                  <b className="tab">Traders</b>
                  <span>Portfolio</span>
                  <span>History</span>
                  <i />
                </div>
                <div className="cpb">
                  <div className="pl">
                    <small>Copy P&amp;L · live</small>
                    <div className={`plv ${pnl >= 0 ? "up" : "dn"}`} id="pl">
                      {pnl < 0 ? "-$" : "$"}
                      {Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <span id="cn">
                      {copiedCount > 0
                        ? `Copying ${copiedCount} ${copiedCount > 1 ? "traders" : "trader"} · risk ${copyRisk}%`
                        : "Pick a trader to start"}
                    </span>
                  </div>

                  <div id="tl">
                    {TRADERS.map((t, idx) => {
                      const isCopying = Boolean(copiedMap[idx]);
                      return (
                        <div className="trw" key={t.name}>
                          <u style={{ background: t.color }}>{t.name[0]}</u>
                          <div>
                            {t.name}
                            <small>Risk · {t.risk}</small>
                          </div>
                          <svg viewBox="0 0 60 22">
                            <polyline
                              points={generateSparklinePoints(t.seed, t.freq)}
                              fill="none"
                              stroke="#2fbd83"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                            />
                          </svg>
                          <span className="pc up">+{t.returnPct}%</span>
                          <b
                            className={`cb ${isCopying ? "on" : ""}`}
                            data-i={idx}
                            onClick={() => toggleCopy(idx)}
                          >
                            {isCopying ? "Copying ✓" : "Copy"}
                          </b>
                        </div>
                      );
                    })}
                  </div>

                  <div className="rk">
                    <span id="rkl">Max risk per trade · {copyRisk}%</span>
                    <input
                      type="range"
                      id="rk"
                      min="1"
                      max="5"
                      value={copyRisk}
                      aria-label="Max risk per trade"
                      onChange={(e) => setCopyRisk(Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="xtxt">
            <div className="tag">
              <u>◎</u>Copy Trading
            </div>
            <h2 className="sh">
              Follow the best. <em>Stay in control.</em>
            </h2>
            <p className="xp">
              Pick a trader, set your risk, and Prometheus mirrors their moves — adapting as the market changes. Try it
              on the screen.
            </p>
            <Link className="btn" href={signedIn ? "/copy-trading" : "/login"}>
              Explore traders &nbsp;→
            </Link>
          </div>
        </section>

        {/* 1. INTERACTIVE ROI PROFIT CALCULATOR */}
        <section className="calc-sec" id="calculator">
          <div className="sec-head">
            <div className="eyebrow">Interactive Simulator</div>
            <h2>
              Calculate your potential <em>returns</em>
            </h2>
            <p>
              Estimate your portfolio growth based on historical strategy data and automated copy trading risk profiles.
            </p>
          </div>

          <div className="calc-card">
            <div className="calc-inputs">
              <div className="calc-input-grp">
                <div className="calc-label">
                  <span>Initial Capital</span>
                  <b id="calc-amt-val">${calcAmt.toLocaleString()}</b>
                </div>
                <input
                  type="range"
                  className="calc-slider"
                  id="calc-amt-slider"
                  min="500"
                  max="50000"
                  step="500"
                  value={calcAmt}
                  onChange={(e) => setCalcAmt(Number(e.target.value))}
                />
                <div className="calc-pills">
                  {[1000, 5000, 10000, 25000].map((v) => (
                    <div
                      key={v}
                      className={`calc-pill ${calcAmt === v ? "on" : ""}`}
                      onClick={() => setCalcAmt(v)}
                    >
                      ${v / 1000}k
                    </div>
                  ))}
                </div>
              </div>

              <div className="calc-input-grp">
                <div className="calc-label">
                  <span>Risk Strategy</span>
                  <b id="calc-risk-val">
                    {calcRiskName} ({calcApy}% APY)
                  </b>
                </div>
                <div className="calc-pills" id="calc-risk-pills">
                  {[
                    { name: "Conservative", apy: 12 },
                    { name: "Balanced", apy: 28 },
                    { name: "Aggressive", apy: 64 },
                  ].map((r) => (
                    <div
                      key={r.name}
                      className={`calc-pill ${calcApy === r.apy ? "on" : ""}`}
                      onClick={() => {
                        setCalcApy(r.apy);
                        setCalcRiskName(r.name);
                      }}
                    >
                      {r.name} ({r.apy}%)
                    </div>
                  ))}
                </div>
              </div>

              <div className="calc-input-grp" style={{ marginBottom: 0 }}>
                <div className="calc-label">
                  <span>Time Horizon</span>
                  <b id="calc-term-val">{calcTermName}</b>
                </div>
                <div className="calc-pills" id="calc-term-pills">
                  {[
                    { label: "3 Months", val: 0.25 },
                    { label: "6 Months", val: 0.5 },
                    { label: "1 Year", val: 1 },
                    { label: "2 Years", val: 2 },
                  ].map((t) => (
                    <div
                      key={t.label}
                      className={`calc-pill ${calcTerm === t.val ? "on" : ""}`}
                      onClick={() => {
                        setCalcTerm(t.val);
                        setCalcTermName(t.label);
                      }}
                    >
                      {t.label}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="calc-result">
              <div>
                <div className="calc-res-title">Estimated Total Balance</div>
                <div className="calc-res-big" id="calc-total-res">
                  ${Math.round(calcTotal).toLocaleString()}
                </div>
                <div className="calc-res-badge" id="calc-profit-badge">
                  + ${Math.round(calcProfit).toLocaleString()} Profit (+{calcReturnPct}%)
                </div>
              </div>
              <div className="calc-grid">
                <div className="calc-meta">
                  <small>Est. Monthly Gain</small>
                  <b id="calc-m-res">+${calcMonthly.toFixed(2)}</b>
                </div>
                <div className="calc-meta">
                  <small>Copy Fee Saved</small>
                  <b className="up" id="calc-fee-res">
                    $0.00
                  </b>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FREQUENTLY ASKED QUESTIONS ACCORDION */}
        <section className="faq-sec" id="faq">
          <div className="sec-head">
            <div className="eyebrow">Got Questions?</div>
            <h2>
              Frequently <em>asked</em> questions
            </h2>
            <p>Everything you need to know about copy trading, security, and the Prometheus ecosystem.</p>
          </div>

          <div className="faq-wrap">
            {FAQ_ITEMS.map((item, idx) => {
              const isOpen = openFaq === idx;
              return (
                <div className={`faq-item ${isOpen ? "open" : ""}`} key={item.q}>
                  <div
                    className="faq-q"
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenFaq(isOpen ? null : idx)}
                  >
                    <span>{item.q}</span>
                    <div className="faq-icon">+</div>
                  </div>
                  <div className="faq-a">{item.a}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* PRE-FOOTER CONVERSION CTA BANNER */}
        <div className="cta-banner">
          <h2>
            Ready to trade <em>smarter?</em>
          </h2>
          <p>Get early access to automated copy trading, zero-brokerage swaps, and AI market intelligence.</p>
          {ctaSubmitted ? (
            <div style={{ color: "var(--up)", fontWeight: 600, fontSize: 16 }}>
              ✓ Thank you! Your early access slot has been reserved.
            </div>
          ) : (
            <form
              className="cta-form"
              id="cta-form"
              onSubmit={(e) => {
                e.preventDefault();
                setCtaSubmitted(true);
              }}
            >
              <input type="email" className="cta-input" placeholder="Enter your email address" required />
              <button type="submit" className="btn">
                Get Early Access
              </button>
            </form>
          )}
        </div>
      </div>

      {/* MULTI-COLUMN EXPANDED FOOTER */}
      <footer>
        <div className="wrap">
          <div className="footer-grid">
            <div className="footer-brand">
              <div className="logo">
                <BrandMark />
                Prometheus
              </div>
              <p>
                Your intelligent crypto hub for non-custodial copy trading, instant USDT swaps, and AI-powered market
                guidance.
              </p>
              <div className="social-links">
                <a className="social-icon" href="#" aria-label="X / Twitter">
                  𝕏
                </a>
                <a className="social-icon" href="#" aria-label="Discord">
                  💬
                </a>
                <a className="social-icon" href="#" aria-label="Telegram">
                  ✈️
                </a>
                <a className="social-icon" href="#" aria-label="GitHub">
                  🐙
                </a>
              </div>
            </div>

            <div className="footer-col">
              <h4>Product</h4>
              <ul>
                <li>
                  <Link href={signedIn ? "/copy-trading" : "/login"}>Copy Trading</Link>
                </li>
                <li>
                  <Link href={signedIn ? "/wallet" : "/login"}>Smart Wallet</Link>
                </li>
                <li>
                  <a href="#features">AI Trading Buddy</a>
                </li>
                <li>
                  <Link href={signedIn ? "/usdt-exchange" : "/login"}>USDT Exchange</Link>
                </li>
                <li>
                  <a href="#calculator">ROI Calculator</a>
                </li>
              </ul>
            </div>

            <div className="footer-col">
              <h4>Resources</h4>
              <ul>
                <li>
                  <a href="#calculator">ROI Calculator</a>
                </li>
                <li>
                  <a href="#faq">Security &amp; FAQs</a>
                </li>
                <li>
                  <a href="#faq">FAQ &amp; Docs</a>
                </li>
                <li>
                  <Link href={signedIn ? "/tokenomics" : "/login"}>Audit Reports</Link>
                </li>
                <li>
                  <Link href={signedIn ? "/dashboard" : "/login"}>System Status</Link>
                </li>
              </ul>
            </div>

            <div className="footer-col">
              <h4>Company &amp; Legal</h4>
              <ul>
                <li>
                  <a href="#">About Us</a>
                </li>
                <li>
                  <a href="#">
                    Careers{" "}
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--b)",
                        background: "rgba(255,176,32,.15)",
                        padding: "2px 6px",
                        borderRadius: 4,
                        marginLeft: 4,
                      }}
                    >
                      WE&apos;RE HIRING
                    </span>
                  </a>
                </li>
                <li>
                  <a href="#">Privacy Policy</a>
                </li>
                <li>
                  <a href="#">Terms of Service</a>
                </li>
                <li>
                  <a href="#">Risk Disclosure</a>
                </li>
              </ul>
            </div>
          </div>

          <div className="footer-bottom">
            <div>© 2026 Prometheus Inc. All rights reserved. Prototype for demonstration purposes.</div>
            <div>Cryptocurrency trading involves substantial risk of loss. Always manage your risk responsibly.</div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function BrandMark() {
  return (
    <Image
      src="/assets/prometheus-logo.png"
      alt=""
      width={30}
      height={30}
      className="brand-mark"
    />
  );
}
