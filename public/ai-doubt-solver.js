/**
 * ============================================================================
 * PROMETHEUS INTERACTIVE AI DOUBT SOLVER WITH SMART ELEMENT HIGHLIGHTING
 * Full-featured context-aware assistant for Prometheus Trading & Analytics
 * ============================================================================
 */

(function () {
  'use strict';

  // Prevent multiple initializations
  if (window.__PrometheusAIDoubtSolverInitialized) return;
  window.__PrometheusAIDoubtSolverInitialized = true;

  /* ==========================================================================
     0. ASYNC STYLESHEET LOADER
     ========================================================================== */
  function ensureStyles() {
    if (document.getElementById('aiDoubtSolverStyles')) return;
    var link = document.createElement('link');
    link.id = 'aiDoubtSolverStyles';
    link.rel = 'stylesheet';
    // Determine relative path based on script location or current directory
    var scripts = document.getElementsByTagName('script');
    var currentScript = scripts[scripts.length - 1];
    var src = (currentScript && currentScript.src) ? currentScript.src : '';
    var basePath = src.substring(0, src.lastIndexOf('/') + 1);
    link.href = basePath ? basePath + 'ai-doubt-solver.css' : 'ai-doubt-solver.css';
    document.head.appendChild(link);
  }
  ensureStyles();

  // Pyrus's avatar. The bridge loader publishes it from the script's own URL so
  // this file works at any route depth; the literal is only a last resort.
  var PYRUS_AVATAR = window.__PrometheusPyrusAvatar || '/assets/pyrus.png';

  /* ==========================================================================
     1. DOM CONTEXT EXTRACTOR
     Scans page semantic elements, headings, metric cards, buttons & forms
     ========================================================================== */
  class DOMContextExtractor {
    constructor() {
      this.cachedElements = [];
      this.idCounter = 0;
      this.scanPage();
    }

    scanPage() {
      this.cachedElements = [];
      var self = this;

      // Select meaningful page elements
      var selectors = [
        'h1, h2, h3, h4, h5',
        'main p, main li, main label, article p, section p, pre, code, img[alt]',
        '.role-kpi, .role-panel, .card, .panel, .stat-card, .metric-box',
        'button:not(.ai-fab-btn):not(.ai-ask-point):not(.ai-ask-send):not(.ai-reply-btn):not(.ai-popup-close):not(.ai-inspect-banner-cancel)',
        '.dside .dock a, nav a, .top .crumb',
        'table, thead th, tbody tr',
        'canvas, .chart-container, .chart-wrap, svg.chart',
        '.switch, .theme-toggle, input[type="search"], input[type="text"], input[type="email"]',
        '.tx-ib, .pill, [data-metric], [data-tab], [data-action]'
      ];

      var found = document.querySelectorAll(selectors.join(', '));
      found.forEach(function (el) {
        // Skip AI assistant's own components and hidden elements
        if (el.closest('.ai-fab-container') || el.closest('.ai-pyrus-scene') || el.closest('.ai-doubt-popup') || el.closest('.ai-inspect-banner')) return;
        var computed = window.getComputedStyle(el);
        if ((el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) ||
            computed.display === 'none' || computed.visibility === 'hidden') return;

        // Assign a stable AI ID if not already present
        if (!el.dataset.aiId) {
          self.idCounter++;
          el.dataset.aiId = 'ai-elem-' + self.idCounter;
        }

        var text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        var tag = el.tagName.toLowerCase();
        var label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
        var role = el.getAttribute('role') || tag;

        // Classify element
        var type = 'element';
        if (/h[1-6]/.test(tag)) type = 'heading';
        else if (el.classList.contains('role-kpi') || el.classList.contains('stat-card')) type = 'metric';
        else if (tag === 'button' || tag === 'a') type = 'action';
        else if (tag === 'table' || tag === 'th' || tag === 'tr') type = 'table';
        else if (tag === 'canvas' || el.classList.contains('chart-container')) type = 'chart';
        else if (tag === 'pre' || tag === 'code') type = 'code';
        else if (tag === 'img') type = 'image';
        else if (/p|li|label/.test(tag)) type = 'content';
        else if (tag === 'input' || el.classList.contains('switch')) type = 'control';

        // Extract title or label specifically
        var title = label || (el.querySelector('small, b, h1, h2, h3, h4, th') ? (el.querySelector('small, b, h1, h2, h3, h4, th').innerText || '').trim() : '');
        if (!title && text.length < 50) title = text;
        if (!title) title = tag.toUpperCase() + ' Component';

        self.cachedElements.push({
          id: el.dataset.aiId,
          element: el,
          tag: tag,
          type: type,
          title: title,
          text: text.slice(0, 300), // sanitize & truncate
          role: role
        });
      });
    }

    getVisibleContextSummary() {
      var title = document.title || 'Prometheus Trading System';
      var headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => (h.innerText || '').trim()).filter(Boolean);
      // Send a small, visible, text-only digest. Never include form values, hidden UI,
      // scripts, or the full DOM in a model request.
      var pageContent = this.cachedElements
        .filter(function (item) {
          if (!item.text || !item.element.isConnected || !item.element.getClientRects().length) return false;
          var style = window.getComputedStyle(item.element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .slice(0, 24)
        .map(function (item) { return { title: item.title, type: item.type, text: item.text.slice(0, 180) }; });
      return {
        pageTitle: title,
        url: window.location.pathname,
        headings: headings.slice(0, 6),
        visibleContent: pageContent,
        totalTrackedElements: this.cachedElements.length
      };
    }
  }

  /* ==========================================================================
     2. SEMANTIC MATCHER & DOM REASONING ENGINE
     Connects user doubts to exact DOM elements or detects ambiguity
     ========================================================================== */
  class SemanticMatcher {
    constructor(extractor) {
      this.extractor = extractor;
      this.synonyms = {
        'pnl': ['profit', 'loss', 'net pnl', 'earnings', 'returns', 'unrealized', 'realized'],
        'impermanent loss': ['il', 'pool loss', 'divergence loss', 'liquidity loss'],
        'apr': ['apy', 'annual percentage rate', 'yield', 'interest', 'fee tier', 'fee earnings'],
        'copy trading': ['expert', 'trader', 'strategy', 'follow', 'drawdown', 'sharpe'],
        'liquidity': ['pool', 'desk', 'in range', 'out of range', 'usdt', 'inr', 'swap'],
        'rebalance': ['auto rebalance', 'rebalancing', 'target weight', 'deviation'],
        'gas': ['gas tracker', 'gwei', 'fast', 'base fee', 'network fee', 'priority fee'],
        'execution': ['1-click', 'one-click', 'trades', 'orders', 'tx', 'recent executions', 'hash'],
        'candle': ['chart', 'candlestick', 'timeframe', 'indicator', 'volume', 'ma', 'ema'],
        'theme': ['light mode', 'dark mode', 'theme toggle', 'switch']
      };
    }

    match(query, explicitElement) {
      if (explicitElement) {
        var matchFound = this.extractor.cachedElements.find(c => c.element === explicitElement);
        var aiHolder = explicitElement.closest ? explicitElement.closest('[data-ai-id]') : null;
        // What the user pointed at may be too small to be in the scan cache.
        // Describe it on the spot so the model still receives its context.
        if (!matchFound) {
          var pointedText = (explicitElement.innerText || explicitElement.textContent || '').trim();
          matchFound = {
            id: (explicitElement.dataset && explicitElement.dataset.aiId) || (aiHolder && aiHolder.dataset ? aiHolder.dataset.aiId : undefined),
            element: aiHolder || explicitElement,
            tag: explicitElement.tagName ? explicitElement.tagName.toLowerCase() : 'element',
            type: 'element',
            title: (explicitElement.getAttribute('aria-label') || explicitElement.getAttribute('title') || pointedText.split('\n')[0] || '').slice(0, 60) || 'Selected element',
            text: pointedText.slice(0, 300),
            role: explicitElement.getAttribute('role') || 'element'
          };
        } else if (!matchFound.id && aiHolder && aiHolder.dataset && aiHolder.dataset.aiId) {
          matchFound.id = aiHolder.dataset.aiId;
        }
        return { exactMatch: matchFound, candidates: [matchFound], confidence: 1.0 };
      }

      this.extractor.scanPage(); // Refresh live DOM state
      var q = query.toLowerCase().trim();
      var qTokens = q.split(/\s+/).filter(t => t.length > 2);

      var scored = [];

      for (var i = 0; i < this.extractor.cachedElements.length; i++) {
        var item = this.extractor.cachedElements[i];
        var itemText = (item.title + ' ' + item.text + ' ' + item.role).toLowerCase();
        var score = 0;

        // 1. Direct substring match with title
        if (item.title && q.includes(item.title.toLowerCase())) {
          score += 50;
        }

        // 2. Token overlap
        qTokens.forEach(token => {
          if (itemText.includes(token)) score += 10;
          if (item.title.toLowerCase().includes(token)) score += 18;
        });

        // 3. Synonym matching
        for (var key in this.synonyms) {
          if (q.includes(key)) {
            var syns = this.synonyms[key];
            syns.forEach(s => {
              if (itemText.includes(s)) score += 14;
            });
          }
        }

        // 4. Component type affinities
        if (/button|click|action|press/.test(q) && item.type === 'action') score += 12;
        if (/chart|trend|graph|line|price/.test(q) && item.type === 'chart') score += 16;
        if (/table|row|history|list/.test(q) && item.type === 'table') score += 14;
        if (/metric|number|rate|ratio|percent|value/.test(q) && item.type === 'metric') score += 12;

        if (score > 15) {
          scored.push({ item: item, score: score });
        }
      }

      scored.sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        return { exactMatch: null, candidates: [], confidence: 0 };
      }

      var top = scored[0];
      // Ambiguity check: if top 2 candidates are very close in score
      if (scored.length > 1 && (top.score - scored[1].score) < 5) {
        return {
          exactMatch: null,
          candidates: scored.slice(0, 3).map(s => s.item),
          confidence: 0.5,
          isAmbiguous: true
        };
      }

      return {
        exactMatch: top.item,
        candidates: scored.slice(0, 3).map(s => s.item),
        confidence: Math.min(top.score / 70, 0.98)
      };
    }
  }

  /* ==========================================================================
     3. AI BACKEND SERVICE ABSTRACTION
     ========================================================================== */
  class AIDoubtSolverService {
    constructor() {
      // Configuration can be injected via window.PROMETHEUS_AI_CONFIG
      this.config = Object.assign({
        apiEndpoint: 'http://localhost:3001/api/ai-doubt-solver',
        copyEndpoint: null,
        modelName: 'configured backend'
      }, window.PROMETHEUS_AI_CONFIG || {});
    }

    /**
     * The page's own idea of what is in view.
     *
     * A page that shows a trade publishes it as `window.PROMETHEUS_PAGE_CONTEXT`.
     * The widget reads nothing but a pointer out of it - never a price, never a
     * quantity - so the answer still comes from the ledger on the server.
     */
    getPublishedContext() {
      var published = window.PROMETHEUS_PAGE_CONTEXT;
      if (!published || typeof published !== 'object') return null;
      return published;
    }

    /**
     * The digest of the page, merged with whatever the page published about
     * itself.
     *
     * Always sent, even when no element was clicked: a question about the page
     * ("why is this short?") is still a question about the page, and the
     * reader did not have to point at anything to ask it.
     */
    getPageContext() {
      var app = window.PrometheusAIApp;
      var summary = app && app.extractor ? app.extractor.getVisibleContextSummary() : null;
      var published = this.getPublishedContext();
      if (!published) return summary;
      var merged = Object.assign({}, summary || {});
      if (published.page) merged.page = published.page;
      if (published.symbol) merged.symbol = published.symbol;
      if (published.focusId) merged.focusId = published.focusId;
      return merged;
    }

    /**
     * The pointer to the trade in question: the row the reader inspected, or
     * the market the page published.
     */
    getPointer(elementContext, pageContext) {
      var pointer = { symbol: null, focusId: null };
      var id = elementContext && elementContext.id ? String(elementContext.id) : '';

      if (id.indexOf('copy-event:') === 0) {
        pointer.focusId = id;
        return pointer;
      }
      if (id.indexOf('copy-position:') === 0) {
        pointer.symbol = id.slice('copy-position:'.length).split(':')[0] || null;
        return pointer;
      }
      if (pageContext) {
        if (pageContext.focusId) pointer.focusId = pageContext.focusId;
        if (pageContext.symbol) pointer.symbol = pageContext.symbol;
      }
      return pointer;
    }

    /**
     * Asks the ledger about the reader's own copy trades.
     *
     * Returns null whenever the ledger cannot answer - no session, nothing in
     * the book, the route unreachable - so the caller falls back to the
     * general knowledge base. A ledger answer is preferred because it is about
     * THIS book: the fill that happened, the size it produced, the reason it
     * was refused.
     */
    async askCopyLedger(query, elementContext, pageContext) {
      if (!this.config.copyEndpoint) return null;
      var pointer = this.getPointer(elementContext, pageContext);

      try {
        var response = await fetch(this.config.copyEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: window.AbortSignal && typeof window.AbortSignal.timeout === 'function' ? window.AbortSignal.timeout(20000) : undefined,
          body: JSON.stringify({
            query: query,
            symbol: pointer.symbol,
            focusId: pointer.focusId
          })
        });
        if (!response.ok) return null;
        var data = await response.json().catch(function () { return null; });
        if (!data || typeof data.concept !== 'string' || !data.sections) return null;
        data.source = 'ledger';
        return data;
      } catch (error) {
        // The ledger is an extra source, never a dependency: if it cannot be
        // reached, the general answer is still an answer.
        return null;
      }
    }

    async resolveDoubt(query, elementContext, conversationHistory) {
      if (!this.config.apiEndpoint && !this.config.copyEndpoint) {
        throw new Error('AI is not connected yet. Configure the Prometheus AI backend to get an AI-generated explanation.');
      }
      var pageContext = this.getPageContext();

      var fromLedger = await this.askCopyLedger(query, elementContext, pageContext);
      if (fromLedger) return this.normalise(fromLedger);

      if (!this.config.apiEndpoint) {
        throw new Error('AI is not connected yet. Configure the Prometheus AI backend to get an AI-generated explanation.');
      }
      var response = await fetch(this.config.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: window.AbortSignal && typeof window.AbortSignal.timeout === 'function' ? window.AbortSignal.timeout(30000) : undefined,
        body: JSON.stringify({
          query: query,
          elementContext: elementContext ? {
            id: elementContext.id,
            title: elementContext.title,
            tag: elementContext.tag,
            type: elementContext.type,
            text: elementContext.text
          } : null,
          pageContext: pageContext,
          history: conversationHistory.slice(-8)
        })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || 'The AI service could not answer just now. Please try again.');
      if (!data || typeof data.concept !== 'string' || !data.sections || typeof data.sections.simple !== 'string') {
        throw new Error('The AI service returned an incomplete answer. Please try again.');
      }
      data.source = 'general';
      return this.normalise(data);
    }

    /** Puts an answer inside the widget's own limits. */
    normalise(data) {
      if (!data.sections || typeof data.sections.simple !== 'string') {
        throw new Error('The AI service returned an incomplete answer. Please try again.');
      }
      ['what', 'simple', 'howItWorks', 'example', 'remember'].forEach(function (key) {
        if (typeof data.sections[key] !== 'string') data.sections[key] = '';
        data.sections[key] = data.sections[key].slice(0, 1800);
      });
      data.concept = data.concept.slice(0, 120);
      return data;
    }


  }

  /* ==========================================================================
     4. HIGHLIGHTER, SPOTLIGHT & LASER CONNECTOR
     Manages visual focus, pulsing outlines, SVG laser line, and cleanup
     ========================================================================== */
  class VisualHighlightManager {
    constructor() {
      this.activeElement = null;
      this.anchorElement = null;
      this.dimmer = null;
      this.svgConnector = null;
      this.createOverlays();

      // Keep connector aligned on scroll/resize
      window.addEventListener('scroll', () => {
        this.updateConnector();
        var app = window.PrometheusAIApp;
        if (app && app.popup && app.popup.popupEl.classList.contains('open') && this.activeElement) {
          app.popup.positionPopup(this.activeElement);
        }
      }, { passive: true });
      window.addEventListener('resize', () => this.updateConnector(), { passive: true });
    }

    createOverlays() {
      // 1. Dimmer Backdrop
      this.dimmer = document.createElement('div');
      this.dimmer.className = 'ai-spotlight-dimmer';
      this.dimmer.setAttribute('aria-hidden', 'true');
      this.dimmer.addEventListener('click', () => {
        if (window.PrometheusAIApp) window.PrometheusAIApp.dismissPopup();
      });
      document.body.appendChild(this.dimmer);

      // 2. SVG Laser Beam Connector
      this.svgConnector = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.svgConnector.setAttribute('class', 'ai-connector-svg');
      this.svgConnector.setAttribute('aria-hidden', 'true');
      this.svgConnector.innerHTML = `
        <defs>
          <linearGradient id="aiBeamGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ff9d54" stop-opacity="0.9" />
            <stop offset="50%" stop-color="#ff6a1a" stop-opacity="1" />
            <stop offset="100%" stop-color="#f05a0b" stop-opacity="0.8" />
          </linearGradient>
          <filter id="aiGlow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <path class="ai-connector-path" filter="url(#aiGlow)" d="" />
      `;
      document.body.appendChild(this.svgConnector);
    }

    // The beam points at `element` from whichever surface is speaking to the
    // user — Pyrus's speech cloud, or the detail card when it is open.
    highlight(element, anchorElement) {
      this.clearHighlight();
      if (!element) return;

      this.anchorElement = anchorElement || null;
      this.activeElement = element;
      element.classList.add('ai-highlight-target');

      // Dim backdrop slightly
      this.dimmer.classList.add('active');

      // Scroll smoothly into view if not comfortably visible
      var rect = element.getBoundingClientRect();
      var isOutOfView = (rect.top < 80 || rect.bottom > (window.innerHeight - 80));
      if (isOutOfView) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Draw SVG laser beam connector
      this.updateConnector(anchorElement);
    }

    updateConnector(anchorElement) {
      if (!this.activeElement) {
        this.clearConnector();
        return;
      }

      // Remember the anchor so the beam survives scrolling and page resizes.
      var anchor = anchorElement || this.anchorElement || document.querySelector('.ai-doubt-popup.open');
      if (!anchor || !anchor.isConnected) {
        this.clearConnector();
        return;
      }
      this.anchorElement = anchor;

      var elemRect = this.activeElement.getBoundingClientRect();
      var popRect = anchor.getBoundingClientRect();

      // Find closest anchor points
      var startX = elemRect.left + elemRect.width / 2;
      var startY = (popRect.top > elemRect.bottom) ? elemRect.bottom : (popRect.bottom < elemRect.top ? elemRect.top : (elemRect.top + elemRect.height / 2));

      var endX = (startX < popRect.left) ? popRect.left : (startX > popRect.right ? popRect.right : (popRect.left + popRect.width / 2));
      var endY = (startY < popRect.top) ? popRect.top : (startY > popRect.bottom ? popRect.bottom : (popRect.top + popRect.height / 2));

      // Calculate smooth curved path
      var dx = endX - startX;
      var dy = endY - startY;
      var cx1 = startX + dx * 0.45;
      var cy1 = startY;
      var cx2 = startX + dx * 0.55;
      var cy2 = endY;

      var pathData = `M ${startX} ${startY} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${endX} ${endY}`;
      var path = this.svgConnector.querySelector('.ai-connector-path');
      if (path) path.setAttribute('d', pathData);
    }

    clearConnector() {
      var path = this.svgConnector.querySelector('.ai-connector-path');
      if (path) path.setAttribute('d', '');
    }

    clearHighlight() {
      if (this.activeElement) {
        this.activeElement.classList.remove('ai-highlight-target');
        this.activeElement = null;
      }
      this.anchorElement = null;
      if (this.dimmer) this.dimmer.classList.remove('active');
      this.clearConnector();
    }
  }

  /* ==========================================================================
     5. CONTEXTUAL EXPLANATION POPUP COMPONENT
     Glassmorphism, smart viewport collision detection & interactive follow-up
     ========================================================================== */
  class ExplanationPopup {
    constructor(visualManager, onFollowUp) {
      this.visualManager = visualManager;
      this.onFollowUp = onFollowUp;
      this.popupEl = null;
      this.currentData = null;
      this.createPopupDOM();
    }

    createPopupDOM() {
      this.popupEl = document.createElement('div');
      this.popupEl.className = 'ai-doubt-popup';
      this.popupEl.setAttribute('role', 'dialog');
      this.popupEl.setAttribute('aria-label', 'Explanation from Pyrus');
      this.popupEl.innerHTML = `
        <div class="ai-popup-header">
          <span class="ai-popup-tag">
            <svg viewBox="0 0 24 24"><path d="M12 2L15 8L21 9L17 14L18 20L12 17L6 20L7 14L3 9L9 8L12 2Z"/></svg>
            <span class="ai-popup-concept-tag">WHAT YOU'RE LOOKING AT</span>
          </span>
          <span class="ai-popup-ember-tag" title="Illustrative: 1 EMBER per consultation">
            <span class="ai-ember-flame">🔥</span> <span id="aiPopupEmberBal">100</span> EMBER
          </span>
          <button class="ai-popup-close" type="button" aria-label="Close Explanation">×</button>
        </div>
        <div class="ai-popup-body">
          <div class="ai-popup-title" id="aiPopupTitle">Concept Title</div>
          <div class="ai-popup-section" id="aiPopupWhatSec">
            <span class="ai-popup-section-label">Summary</span>
            <div class="ai-popup-section-content" id="aiPopupWhat"></div>
          </div>
          <div class="ai-popup-section" id="aiPopupSimpleSec">
            <span class="ai-popup-section-label">Simple Explanation</span>
            <div class="ai-popup-section-content" id="aiPopupSimple"></div>
          </div>
          <div class="ai-popup-section" id="aiPopupHowSec">
            <span class="ai-popup-section-label">How It Works</span>
            <div class="ai-popup-section-content" id="aiPopupHow"></div>
          </div>
          <div class="ai-popup-section" id="aiPopupExSec">
            <span class="ai-popup-section-label">Example</span>
            <div class="ai-popup-example-box" id="aiPopupExample"></div>
          </div>
          <div class="ai-popup-section" id="aiPopupRemSec">
            <span class="ai-popup-section-label">Remember</span>
            <div class="ai-popup-remember-box" id="aiPopupRemember"></div>
          </div>
        </div>
        <div class="ai-popup-footer">
          <button class="ai-popup-followup-btn" type="button">
            <span>Ask Pyrus to go deeper</span>
          </button>
          <button class="ai-popup-sub-btn" id="aiPopupSimplifyBtn" type="button">
            Explain simpler
          </button>
        </div>
      `;
      document.body.appendChild(this.popupEl);

      // Event handlers
      this.popupEl.querySelector('.ai-popup-close').addEventListener('click', () => this.close());
      this.popupEl.querySelector('.ai-popup-followup-btn').addEventListener('click', () => {
        if (this.onFollowUp) this.onFollowUp(this.currentData, 'followup');
      });
      this.popupEl.querySelector('#aiPopupSimplifyBtn').addEventListener('click', () => {
        if (this.onFollowUp) this.onFollowUp(this.currentData, 'simplify');
      });
    }

    show(data, targetElement) {
      this.currentData = data;
      var sec = data.sections || {};

      this.popupEl.querySelector('#aiPopupTitle').textContent = data.concept || 'Page Explanation';
      this.popupEl.querySelector('#aiPopupWhat').textContent = sec.what || '';
      this.popupEl.querySelector('#aiPopupSimple').textContent = sec.simple || '';
      this.popupEl.querySelector('#aiPopupHow').textContent = sec.howItWorks || '';
      this.popupEl.querySelector('#aiPopupExample').textContent = sec.example || '';
      var remember = this.popupEl.querySelector('#aiPopupRemember');
      remember.textContent = '';
      if (sec.remember) {
        var rememberLabel = document.createElement('b');
        rememberLabel.textContent = 'Key Takeaway: ';
        remember.appendChild(rememberLabel);
        remember.appendChild(document.createTextNode(sec.remember));
      }

      // Hide empty sections gracefully
      this.popupEl.querySelector('#aiPopupWhatSec').style.display = sec.what ? 'flex' : 'none';
      this.popupEl.querySelector('#aiPopupSimpleSec').style.display = sec.simple ? 'flex' : 'none';
      this.popupEl.querySelector('#aiPopupHowSec').style.display = sec.howItWorks ? 'flex' : 'none';
      this.popupEl.querySelector('#aiPopupExSec').style.display = sec.example ? 'flex' : 'none';
      this.popupEl.querySelector('#aiPopupRemSec').style.display = sec.remember ? 'flex' : 'none';

      // Position popup smartly
      this.positionPopup(targetElement);

      // Pyrus steps out of the way while the card is being read.
      document.body.classList.add('ai-pyrus-card-open');
      this.popupEl.classList.add('open');
      this.visualManager.highlight(targetElement, this.popupEl);
    }

    positionPopup(targetElement) {
      if (window.innerWidth <= 768) {
        // Mobile layout handles placement via CSS bottom sheet
        return;
      }

      var popupWidth = 440;
      var popupHeight = 420; // approximate
      var padding = 24;

      if (!targetElement) {
        // Default floating position
        this.popupEl.style.left = 'auto';
        this.popupEl.style.right = '490px';
        this.popupEl.style.top = '120px';
        this.popupEl.style.bottom = 'auto';
        return;
      }

      var rect = targetElement.getBoundingClientRect();
      // Keep clear of Pyrus: while he is standing on the page the card stays to
      // his left, and is nudged above him if it would land on top of him.
      var scene = document.getElementById('aiPyrusScene');
      var sceneRect = (scene && scene.classList.contains('summoned')) ? scene.getBoundingClientRect() : null;
      var rightBoundary = sceneRect ? Math.min(window.innerWidth - padding, sceneRect.left - 12) : (window.innerWidth - padding);
      var spaceRight = rightBoundary - rect.right;
      var spaceLeft = rect.left;
      var spaceBottom = window.innerHeight - rect.bottom;
      var spaceTop = rect.top;

      var posX = 0;
      var posY = 0;

      // Prefer placing to the right if space exists before chat panel
      if (spaceRight >= popupWidth + padding) {
        posX = rect.right + padding;
        posY = Math.max(padding, Math.min(rect.top - 20, window.innerHeight - popupHeight - padding));
      }
      // Else place to the left
      else if (spaceLeft >= popupWidth + padding) {
        posX = rect.left - popupWidth - padding;
        posY = Math.max(padding, Math.min(rect.top - 20, window.innerHeight - popupHeight - padding));
      }
      // Else place below, clamped within rightBoundary
      else if (spaceBottom >= 320) {
        posX = Math.max(padding, Math.min(rect.left, rightBoundary - popupWidth));
        posY = rect.bottom + padding;
      }
      // Fallback: place above
      else {
        posX = Math.max(padding, Math.min(rect.left, rightBoundary - popupWidth));
        posY = Math.max(padding, rect.top - popupHeight - padding);
      }

      // Nudge the card away if it landed on Pyrus.
      if (sceneRect) {
        var overlapX = Math.min(posX + popupWidth, sceneRect.right) - Math.max(posX, sceneRect.left);
        var overlapY = Math.min(posY + popupHeight, sceneRect.bottom) - Math.max(posY, sceneRect.top);
        if (overlapX > 0 && overlapY > 0) {
          var aboveScene = sceneRect.top - popupHeight - padding;
          if (aboveScene >= padding) posY = aboveScene;
          else posX = Math.max(padding, Math.min(sceneRect.left - popupWidth - padding, window.innerWidth - popupWidth - padding));
        }
      }

      this.popupEl.style.left = `${posX}px`;
      this.popupEl.style.top = `${posY}px`;
      this.popupEl.style.right = 'auto';
      this.popupEl.style.bottom = 'auto';
    }

    close() {
      this.popupEl.classList.remove('open');
      document.body.classList.remove('ai-pyrus-card-open');
      this.visualManager.clearHighlight();
    }
  }

  /* ==========================================================================
     6. MAIN APPLICATION ORCHESTRATOR
     Summons Pyrus onto the page, lets him converse in his speech cloud, walk
     over to what he is talking about and point at it.
     ========================================================================== */
  class PrometheusAIApplication {
    constructor() {
      this.extractor = new DOMContextExtractor();
      this.matcher = new SemanticMatcher(this.extractor);
      this.aiService = new AIDoubtSolverService();
      this.visualManager = new VisualHighlightManager();
      this.popup = new ExplanationPopup(this.visualManager, (data, action) => this.handlePopupAction(data, action));

      this.isSummoned = false;
      this.isBusy = false;
      this.isInspectMode = false;
      this.hasGreeted = false;
      this.currentContextElement = null;
      this.lastAnswer = null;
      this.conversationHistory = [];
      this.isSuggestionsMinimized = false;
      this.isSpeechExpanded = false;

      // --- EMBER economy (illustrative) ---
      // Each answered question costs 1 EMBER.  The balance starts at 100 and
      // is stored in sessionStorage so it persists across page navigations
      // within the same browser session but resets on every fresh visit.
      var _savedEmber = null;
      try { _savedEmber = window.sessionStorage.getItem('pyrusEmberBalance'); } catch (_) {}
      this.emberBalance = (_savedEmber !== null && !isNaN(Number(_savedEmber)))
        ? Number(_savedEmber)
        : 100;

      // Where he is looking. Written to CSS custom properties on the scene so the
      // pose and the light inside him both follow.
      this.gazeX = 0;
      this.gazeY = 0;
      this.gazeHoldUntil = 0;
      this._gazeFrame = 0;

      this.buildUI();
      this.bindEvents();
      this.showQuickReplies(this.openingReplies());
      this.checkServiceStatus();
    }

    async checkServiceStatus() {
      var status = this.scene.querySelector('#aiPyrusStatus');
      if (!status || !this.aiService.config.apiEndpoint) return;
      try {
        var healthUrl = this.aiService.config.apiEndpoint.replace(/\/api\/ai-doubt-solver\/?$/, '/api/health');
        var response = await fetch(healthUrl, { signal: window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined });
        var health = response.ok ? await response.json() : {};
        status.dataset.state = health.providerConfigured ? 'ready' : 'nokey';
        status.textContent = health.providerConfigured ? 'online' : 'no api key';
        status.title = health.providerConfigured ? 'The Prometheus AI service is ready' : 'Add a provider key in ai_backend/.env';
      } catch (_) {
        status.dataset.state = 'offline';
        status.textContent = 'offline';
        status.title = 'Start the Prometheus AI backend so Pyrus can answer';
      }
    }

    buildUI() {
      // 1. Summon button — the small latch that calls Pyrus onto the page.
      this.fabContainer = document.createElement('div');
      this.fabContainer.className = 'ai-fab-container';
      this.fabContainer.innerHTML = `
        <button class="ai-fab-btn" id="aiDoubtFab" type="button" aria-label="Summon Pyrus" aria-expanded="false">
          <div class="ai-fab-pulse-ring"></div>
          <span class="ai-fab-badge"></span>
          <div class="ai-fab-icon">
            <img src="${PYRUS_AVATAR}" alt="" aria-hidden="true">
          </div>
        </button>
        <div class="ai-fab-tooltip" role="tooltip">Summon Pyrus</div>
      `;
      this.fabBtn = this.fabContainer.querySelector('#aiDoubtFab');
      document.body.appendChild(this.fabContainer);

      // 2. Pyrus himself. There is no chat window: the creature is the interface.
      //    He stands on the page, thinks out loud in the cloud above his head,
      //    and walks over to point at whatever he is explaining.
      this.scene = document.createElement('div');
      this.scene.className = 'ai-pyrus-scene';
      this.scene.id = 'aiPyrusScene';
      this.scene.dataset.mood = 'idle';
      this.scene.setAttribute('aria-label', 'Pyrus, your guide on this page');
      this.scene.setAttribute('aria-hidden', 'true');
      this.scene.innerHTML = `
        <div class="ai-pyrus-halo" aria-hidden="true"></div>
        <div class="ai-pyrus-motes" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span>
        </div>

        <div class="ai-pyrus-speech" id="aiPyrusSpeech">
          <div class="ai-speech-topbar">
            <div class="ai-speech-echo" id="aiSpeechEcho" hidden></div>
            <button class="ai-speech-expand-btn" id="aiSpeechExpandBtn" type="button" aria-label="Expand answer view" title="Expand answer view">
              <svg viewBox="0 0 24 24" class="ai-icon-expand" aria-hidden="true">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <svg viewBox="0 0 24 24" class="ai-icon-collapse" aria-hidden="true">
                <path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <div class="ai-speech-body">
            <span class="ai-speech-dots" id="aiSpeechDots" hidden><i></i><i></i><i></i></span>
            <span class="ai-speech-text" id="aiSpeechText" aria-live="polite">Hi — I’m Pyrus, your guide on this page. Ask me anything, or point me at something.</span>
          </div>
          
          <div class="ai-speech-replies-header" id="aiRepliesHeader" hidden>
            <span>Suggestions</span>
            <button class="ai-replies-toggle" id="aiRepliesToggle" type="button" aria-label="Toggle suggestions">
              <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
          </div>
          <div class="ai-speech-replies" id="aiSpeechReplies"></div>

          <form class="ai-pyrus-ask" id="aiPyrusAskForm">
            <button class="ai-ask-point" id="aiAskPointBtn" type="button" aria-label="Point Pyrus at something on the page" title="Point at something on the page">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6 1.6L10.4 19z"/></svg>
            </button>
            <input class="ai-ask-field" id="aiAskField" type="text" autocomplete="off" placeholder="Ask Pyrus…" aria-label="Ask Pyrus about this page">
            <button class="ai-ask-send" id="aiAskSend" type="submit" aria-label="Ask Pyrus">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20.5L21 12 3 3.5 3 10l12 2-12 2z"/></svg>
            </button>
          </form>
        </div>

        <div class="ai-pyrus-body" id="aiPyrusBody">
          <span class="ai-pyrus-shadow" aria-hidden="true"></span>
          <img class="ai-pyrus-image" src="${PYRUS_AVATAR}" alt="Pyrus, the Prometheus trading guide">
          <span class="ai-pyrus-gaze" id="aiPyrusGaze" aria-hidden="true"></span>
        </div>

        <div class="ai-speech-ember-bar" id="aiSpeechEmberBar" title="Illustrative: 1 EMBER per Pyrus question">
          🔥 <span id="aiSpeechEmberBal">100</span> EMBER
        </div>

        <div class="ai-pyrus-nameplate">
          <span class="ai-pyrus-name">Pyrus</span>
          <span class="ai-pyrus-status" id="aiPyrusStatus" data-state="checking" title="Checking the Prometheus AI service…">connecting</span>
        </div>
      `;
      document.body.appendChild(this.scene);
      this.scene.inert = true;

      this.speechEl = this.scene.querySelector('#aiPyrusSpeech');
      this.speechTextEl = this.scene.querySelector('#aiSpeechText');
      this.speechEchoEl = this.scene.querySelector('#aiSpeechEcho');
      this.speechExpandBtn = this.scene.querySelector('#aiSpeechExpandBtn');
      this.speechRepliesEl = this.scene.querySelector('#aiSpeechReplies');
      this.repliesHeaderEl = this.scene.querySelector('#aiRepliesHeader');
      this.repliesToggleBtn = this.scene.querySelector('#aiRepliesToggle');
      this.speechDotsEl = this.scene.querySelector('#aiSpeechDots');
      this.askField = this.scene.querySelector('#aiAskField');
      this.askSendBtn = this.scene.querySelector('#aiAskSend');
      this.speechEmberBarEl = this.scene.querySelector('#aiSpeechEmberBar');
      this.speechEmberBalEl = this.scene.querySelector('#aiSpeechEmberBal');

      // Sync initial display
      this.refreshEmberDisplay();

      // The gaze light is masked by Pyrus's own artwork, so it can only ever
      // appear inside his silhouette. The mask URL has to be resolved here,
      // where the avatar path is known.
      this.bodyEl = this.scene.querySelector('#aiPyrusBody');
      this.gazeEl = this.scene.querySelector('#aiPyrusGaze');
      if (this.gazeEl) {
        var maskUrl = 'url("' + PYRUS_AVATAR + '")';
        this.gazeEl.style.webkitMaskImage = maskUrl;
        this.gazeEl.style.maskImage = maskUrl;
      }
    }

    bindEvents() {
      this.fabBtn.addEventListener('click', () => this.togglePyrus());

      // He watches the cursor. A guide that stares past you is scenery; one that
      // turns to follow you is company.
      document.addEventListener('pointermove', (e) => this.trackPointer(e), { passive: true });

      if (this.speechExpandBtn) {
        this.speechExpandBtn.addEventListener('click', () => this.toggleSpeechExpand());
      }

      if (this.repliesToggleBtn) {
        this.repliesToggleBtn.addEventListener('click', () => this.toggleSuggestions());
      }

      this.scene.querySelector('#aiAskPointBtn').addEventListener('click', () => this.toggleInspectMode());
      this.scene.querySelector('#aiPyrusAskForm').addEventListener('submit', (e) => {
        e.preventDefault();
        var query = this.askField.value.trim();
        if (!query || this.isBusy) return;
        this.askField.value = '';
        this.handleUserQuestion(query);
      });

      // Global keyboard accessibility
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (this.isSpeechExpanded) this.toggleSpeechExpand(false);
        else if (this.isInspectMode) this.toggleInspectMode(false);
        else if (this.popup.popupEl.classList.contains('open')) this.dismissPopup();
        else if (this.isSummoned) this.dismissPyrus();
      });

      // A guide walks up to you; a chat widget waits in a corner. Pyrus introduces
      // himself once per session, then stays quiet until he is needed.
      try {
        if (!window.sessionStorage.getItem('aiPyrusWelcomed')) {
          window.sessionStorage.setItem('aiPyrusWelcomed', '1');
          window.setTimeout(() => { if (!this.isSummoned) this.summonPyrus('intro'); }, 2200);
        }
      } catch (_) { /* storage blocked — stay silent */ }
    }

    toggleSpeechExpand(override) {
      this.isSpeechExpanded = (override !== undefined) ? override : !this.isSpeechExpanded;
      if (this.speechEl) {
        if (this.isSpeechExpanded) {
          this.speechEl.classList.add('is-expanded');
          if (this.speechExpandBtn) this.speechExpandBtn.setAttribute('title', 'Collapse answer view');
        } else {
          this.speechEl.classList.remove('is-expanded');
          if (this.speechExpandBtn) this.speechExpandBtn.setAttribute('title', 'Expand answer view');
        }
      }
    }

    /* Openers are drawn from the page itself, so they always refer to something
       the user can actually see. */
    openingReplies() {
      var published = this.aiService ? this.aiService.getPublishedContext() : null;
      if (published && published.page === 'copy-trading') {
        return [
          'Why was it short at this point?',
          'Why did it sell here?',
          'Why was that trade rejected?'
        ];
      }
      var headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .filter(function (el) { return el.getClientRects().length && !el.closest('.ai-pyrus-scene, .ai-doubt-popup'); })
        .map(function (el) { return (el.innerText || '').trim().replace(/\s+/g, ' '); })
        .filter(Boolean);
      var replies = headings.slice(0, 2).map(function (heading) { return 'Explain “' + heading.slice(0, 40) + '”'; });
      replies.push('What can I do on this page?');
      return replies;
    }

    toggleSuggestions(override) {
      this.isSuggestionsMinimized = (override !== undefined) ? override : !this.isSuggestionsMinimized;
      if (this.speechEl) {
        if (this.isSuggestionsMinimized) this.speechEl.classList.add('replies-minimized');
        else this.speechEl.classList.remove('replies-minimized');
      }
    }

    followUpReplies(concept) {
      var replies = [];
      if (this.lastAnswer && this.lastAnswer.data && this.lastAnswer.data.source === 'ledger') {
        replies.push('Why was my size different from the expert?');
        replies.push('Why was it short at this point?');
      } else {
        replies.push('Explain ' + concept + ' more simply');
        replies.push('Give me an example of ' + concept);
      }
      replies.push({ label: this.isSpeechExpanded ? 'Contract bubble' : 'Expand answer bubble', expand: true });
      replies.push({ label: 'Show me the full breakdown', detail: true });
      return replies;
    }

    // Replies are plain strings, or {label, query, element, detail, expand} objects.
    showQuickReplies(replies) {
      var host = this.speechRepliesEl;
      if (!host) return;
      host.innerHTML = '';
      
      var hasReplies = replies && replies.length > 0;
      if (this.repliesHeaderEl) this.repliesHeaderEl.hidden = !hasReplies;

      var self = this;
      (replies || []).slice(0, 4).forEach(function (reply) {
        var isObject = typeof reply === 'object' && reply !== null;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ai-reply-btn';
        button.textContent = isObject ? reply.label : reply;
        button.addEventListener('click', function () {
          if (isObject && reply.detail) { self.showDetail(); return; }
          if (isObject && reply.expand) { self.toggleSpeechExpand(); return; }
          self.handleUserQuestion(isObject ? (reply.query || reply.label) : reply, isObject ? reply.element : null);
        });
        host.appendChild(button);
      });
    }

    showDetail() {
      if (!this.lastAnswer) return;
      this.walkTo(this.lastAnswer.element);
      this.lookAt(this.lastAnswer.element, 9000);
      this.popup.show(this.lastAnswer.data, this.lastAnswer.element);
    }

    togglePyrus() {
      this.isSummoned ? this.dismissPyrus() : this.summonPyrus('manual');
    }

    summonPyrus(mode) {
      if (this.isSummoned) {
        if (mode === 'manual') this.askField.focus();
        return;
      }
      this.isSummoned = true;
      this.scene.inert = false;
      this.scene.classList.add('summoned');
      this.scene.setAttribute('aria-hidden', 'false');
      this.fabContainer.classList.add('character-visible');
      this.fabBtn.setAttribute('aria-expanded', 'true');

      // Convert the resting corner anchor into explicit coordinates, so his
      // first walk to an element animates instead of snapping (CSS cannot
      // transition from right/bottom to left/top).
      this.scene.style.right = 'auto';
      this.scene.style.bottom = 'auto';
      this.scene.style.left = Math.max(12, window.innerWidth - this.scene.offsetWidth - 26) + 'px';
      this.scene.style.top = Math.max(12, window.innerHeight - this.scene.offsetHeight - 92) + 'px';

      // He arrives facing the middle of the page and picks the cursor up from there.
      this.releaseGaze();

      if (!this.hasGreeted) {
        this.hasGreeted = true;
        this.setMood('greeting');
        this.speak('Hi — I’m Pyrus. I live on this page. Ask me about any chart, metric, button or file you see, or point me at something and I’ll explain it.');
        window.setTimeout(() => this.setMood('idle'), 3000);
      }
      if (mode === 'manual') window.setTimeout(() => this.askField.focus(), 320);
    }

    dismissPyrus() {
      if (!this.isSummoned) return;
      this.isSummoned = false;
      this.scene.classList.remove('summoned');
      this.scene.setAttribute('aria-hidden', 'true');
      this.scene.inert = true;
      this.fabContainer.classList.remove('character-visible');
      // Return him to his resting corner for the next summon.
      this.scene.style.left = '';
      this.scene.style.top = '';
      this.scene.style.right = '';
      this.scene.style.bottom = '';
      this.setMood('idle');
      this.releaseGaze();
      if (this.isSpeechExpanded) this.toggleSpeechExpand(false);
      this.visualManager.clearHighlight();
      this.fabBtn.setAttribute('aria-expanded', 'false');
      this.fabBtn.focus();
    }

    dismissPopup() {
      this.popup.close();
      this.visualManager.clearHighlight();
    }

    toggleInspectMode(override) {
      this.isInspectMode = (override !== undefined) ? override : !this.isInspectMode;
      if (this.isInspectMode) {
        document.body.classList.add('ai-inspect-mode');
        this.showInspectBanner();
        this.setMood('listening');
        this.setupInspectListeners();
      } else {
        document.body.classList.remove('ai-inspect-mode');
        this.hideInspectBanner();
        this.setMood('idle');
        this.teardownInspectListeners();
      }
    }

    showInspectBanner() {
      if (!this.inspectBanner) {
        this.inspectBanner = document.createElement('div');
        this.inspectBanner.className = 'ai-inspect-banner';
        this.inspectBanner.setAttribute('role', 'status');
        this.inspectBanner.innerHTML = '<span>Point at anything and I’ll explain it</span><button class="ai-inspect-banner-cancel" type="button">Cancel</button>';
        this.inspectBanner.querySelector('.ai-inspect-banner-cancel').addEventListener('click', () => this.toggleInspectMode(false));
        document.body.appendChild(this.inspectBanner);
      }
      this.inspectBanner.classList.add('show');
    }

    hideInspectBanner() {
      if (this.inspectBanner) this.inspectBanner.classList.remove('show');
    }

    setupInspectListeners() {
      this._hoverHandler = (e) => {
        var target = e.target.closest('[data-ai-id]') || e.target.closest('button, h1, h2, h3, h4, table, canvas, .role-kpi, .card');
        if (target && !target.closest('.ai-pyrus-scene') && !target.closest('.ai-doubt-popup') && !target.closest('.ai-inspect-banner')) {
          if (this._lastHovered && this._lastHovered !== target) this._lastHovered.classList.remove('ai-inspect-target-hover');
          this._lastHovered = target;
          target.classList.add('ai-inspect-target-hover');
        }
      };

      this._clickHandler = (e) => {
        var target = e.target.closest('[data-ai-id]') || e.target.closest('button, h1, h2, h3, h4, table, canvas, .role-kpi, .card');
        if (target && !target.closest('.ai-pyrus-scene') && !target.closest('.ai-doubt-popup') && !target.closest('.ai-inspect-banner')) {
          e.preventDefault();
          e.stopPropagation();
          if (this._lastHovered) this._lastHovered.classList.remove('ai-inspect-target-hover');
          this.toggleInspectMode(false);
          this.handleElementInspect(target);
        }
      };

      document.addEventListener('mouseover', this._hoverHandler, true);
      document.addEventListener('click', this._clickHandler, true);
    }

    teardownInspectListeners() {
      if (this._lastHovered) {
        this._lastHovered.classList.remove('ai-inspect-target-hover');
        this._lastHovered = null;
      }
      if (this._hoverHandler) document.removeEventListener('mouseover', this._hoverHandler, true);
      if (this._clickHandler) document.removeEventListener('click', this._clickHandler, true);
    }

    async handleElementInspect(targetElement) {
      this.currentContextElement = targetElement;
      var title = (targetElement.innerText || targetElement.getAttribute('aria-label') || 'Selected Component').trim().split('\n')[0].slice(0, 40);
      var query = `Explain this: ${title}`;
      this.handleUserQuestion(query, targetElement);
    }

    isUnrelatedQuery(query, explicitElement) {
      if (explicitElement) return false;
      var q = (query || '').toLowerCase().trim();
      if (!q) return false;

      // Common greetings & assistant identity questions are permitted
      if (/^(hi|hello|hey|greetings|help|who are you|what can you do|what are you)\b/i.test(q)) return false;

      // Trading, crypto, and Prometheus platform terms
      var tradingKeywords = /\b(trade|trading|trader|crypto|bitcoin|btc|eth|sol|usdt|inr|token|ember|order|long|short|pnl|profit|loss|wallet|liquidity|pool|apr|apy|staking|stake|chart|candle|candlestick|sentinel|alert|risk|drawdown|sharpe|margin|leverage|entry|exit|buy|sell|bought|sold|copy|follower|strategy|allocation|fill|reject|refus|slippage|market|balance|deposit|withdraw|portfolio|commission|fee|price|quote|volatility|breakout|stop.?loss|take.?profit|pyrus|prometheus|platform|desk|kpi|metric|row|pot|invest|currency|position|positions)\b/i;

      if (tradingKeywords.test(q)) return false;

      // Check if query matches headings/labels on the live page
      var headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, th, .metric-box, .stat-card'))
        .map(function (el) { return (el.innerText || '').toLowerCase(); });
      var matchesPage = headings.some(function (h) { return h && h.length > 2 && q.includes(h); });
      if (matchesPage) return false;

      // Obvious non-financial / non-platform topics
      var unrelatedPatterns = /\b(joke|recipe|cook|food|song|sing|movie|actor|film|cinema|cricket|football|soccer|basketball|nfl|tennis|capital of|poem|lyrics|code for|python|javascript code|java code|write code|homework|translate|dating|love|relationship|weather|forecast|prime minister|president|who won|who is elon|who is messi|who is ronaldo|celebrity|music|guitar|game|gaming|car|cars|flight|hotel|vacation)\b/i;
      if (unrelatedPatterns.test(q)) return true;

      // Open-ended general trivia with no trading connection
      var generalTrivia = /^(who is|who was|who wrote|what is the capital|where is|when was|how to make|how to cook|tell me about|tell a|sing a|write a)\b/i;
      if (generalTrivia.test(q)) return true;

      return false;
    }

    async handleUserQuestion(query, explicitElement) {
      if (this.isBusy) return;
      this.isBusy = true;
      if (!this.isSummoned) this.summonPyrus('quiet');

      this.echoQuestion(query);

      // Refuse unrelated non-trading/non-platform questions politely
      if (this.isUnrelatedQuery(query, explicitElement)) {
        this.setMood('speaking');
        this.showQuickReplies([]);
        await this.speak(
          'I’m Pyrus, your Prometheus trading buddy! I am dedicated solely to trading, copy strategies, markets, and the Prometheus platform. Please ask me about a trade, metric, chart, or concept on your screen!'
        );
        this.showQuickReplies(this.openingReplies());
        this.finishTurn();
        return;
      }

      this.think('Reading the page…');
      this.askSendBtn.disabled = true;

      // Match the doubt to an exact element in the live DOM
      var isFollowUp = /\b(simpler|more simply|another example|give me an example|tell me more|follow.?up|shorter|fewer words|step by step|that answer|your answer)\b/i.test(query);
  var matchResult = this.matcher.match(
  query,
  explicitElement || (isFollowUp ? this.currentContextElement : null)
);

var isGeneralQuestion =
  /^(who is|what is|what are|when did|when was|where is|where was|why does|why is|how does|how do|define|explain)\b/i.test(query.trim());

if (isGeneralQuestion && !explicitElement && !isFollowUp) {
  matchResult = {
    exactMatch: null,
    candidates: [],
    confidence: 0
  };
}

      // Ambiguity: Pyrus asks instead of guessing.
      if (matchResult.isAmbiguous && matchResult.candidates.length > 1) {
        this.setMood('speaking');
        this.showQuickReplies([]);
        await this.speak('I can see a few things that could match that. Which one do you mean?');
        this.showQuickReplies(matchResult.candidates.map(function (candidate) {
          return { label: candidate.title, query: 'Explain ' + candidate.title, element: candidate.element };
        }));
        this.finishTurn();
        return;
      }

      var targetItem = matchResult.exactMatch;
      var targetElement = targetItem ? targetItem.element : (explicitElement || null);

      // Pronouns without a selected or confidently matched target must not cause a guess.
      var ambiguousSubject =
        !targetElement && !targetItem &&
        /\b(this|that|it|here|part|thing|button)\b/i.test(query) &&
        !/\b(what is|define|meaning of|difference between|explain\s+(apr|pnl|sharpe|impermanent loss|drawdown|copy trading))\b/i.test(query);

      // A page that publishes what is in view has already answered "which
      // part", so the question goes to the ledger before it is refused. The
      // ledger is the only source that can answer "why was it short at this
      // point" - it knows the reader's own book, and the general model does
      // not. Only a ledger that cannot answer leaves the reader without a
      // subject to point at.
      var ledgerAnswer = null;
      if (ambiguousSubject) {
        ledgerAnswer = await this.aiService.askCopyLedger(query, targetItem, this.aiService.getPageContext());
      }

      if (ambiguousSubject && ledgerAnswer === null) {
        this.setMood('speaking');
        this.showQuickReplies([]);
        await this.speak('Which part do you mean? Say its name, or use the pointer and show me on the page.');
        this.showQuickReplies(this.openingReplies());
        this.finishTurn();
        return;
      }

      if (targetElement) {
        this.currentContextElement = targetElement;
      }
      this.walkTo(targetElement);
      // …and he looks straight at it while he answers about it.
      this.lookAt(targetElement, 7000);

      // Resolve the doubt through the AI service, then say it out loud.
      try {
        var aiResponse = ledgerAnswer || await this.aiService.resolveDoubt(query, targetItem, this.conversationHistory);
        this.conversationHistory.push({ role: 'user', content: query });
        this.conversationHistory.push({ role: 'assistant', content: aiResponse.sections.simple, target: aiResponse.concept });
        this.lastAnswer = { data: aiResponse, element: targetElement };

        // Deduct 1 EMBER per answered question (illustrative)
        this.spendEmber(1);

        // Point at the thing being explained, with the laser beam coming out of
        // the speech cloud.
        if (targetElement) this.visualManager.highlight(targetElement, this.speechEl);

        this.setMood('speaking');
        this.showQuickReplies([]);
        // A ledger answer covers the trade facts, why the copy mirrored it, and how
        // the directional mechanics work, so a naive trader gets the full explanation.
        var spoken;
        if (aiResponse.source === 'ledger') {
          var sec = aiResponse.sections || {};
          spoken = [sec.what, sec.simple, sec.howItWorks].filter(Boolean).join('\n\n');
        } else {
          spoken = (aiResponse.sections && aiResponse.sections.simple) || (aiResponse.sections && aiResponse.sections.what);
        }
        await this.speak(spoken || 'Here is what I found.');
        this.showQuickReplies(this.followUpReplies(aiResponse.concept));
      } catch (error) {
        var notice = error && error.message ? error.message : 'Something went wrong on my side. Please try that again.';
        if (error && (error.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(notice))) {
          notice = 'I can’t reach the Prometheus AI service right now, so I can’t explain that yet. The page still works — try me again in a moment.';
        }
        this.setMood('speaking');
        this.showQuickReplies([]);
        await this.speak(notice);
        this.showQuickReplies(this.openingReplies());
      } finally {
        this.finishTurn();
      }
    }

    finishTurn() {
      if (this.speechEl) this.speechEl.classList.remove('typing');
      this.speechDotsEl.hidden = true;
      this.askSendBtn.disabled = false;
      this.isBusy = false;
    }

    // --- EMBER economy helpers ---

    /** Deduct `amount` EMBER from the running balance and refresh all displays. */
    spendEmber(amount) {
      this.emberBalance = Math.max(0, this.emberBalance - amount);
      try { window.sessionStorage.setItem('pyrusEmberBalance', String(this.emberBalance)); } catch (_) {}
      this.refreshEmberDisplay();
    }

    /**
     * Update every EMBER indicator on the page:
     *  • the bar at the bottom of Pyrus's speech cloud
     *  • the pill in the detail card header (#aiPopupEmberBal)
     *  • any externally-rendered indicator (#aiSpeechEmberBal duplicate guard)
     */
    refreshEmberDisplay() {
      var bal = this.emberBalance;
      var balStr = bal.toFixed(0);
      var isLow = bal <= 20;

      // Speech cloud bar
      if (this.speechEmberBalEl) this.speechEmberBalEl.textContent = balStr;
      if (this.speechEmberBarEl) {
        this.speechEmberBarEl.classList.toggle('ember-low', isLow);
      }

      // Detail card popup pill
      var popupBal = document.getElementById('aiPopupEmberBal');
      if (popupBal) popupBal.textContent = balStr;
      var popupTag = popupBal ? popupBal.closest('.ai-popup-ember-tag') : null;
      if (popupTag) {
        popupTag.classList.toggle('ember-low', isLow);
        // Brief flash animation to acknowledge the spend
        popupTag.classList.remove('ember-spent');
        void popupTag.offsetWidth; // reflow
        popupTag.classList.add('ember-spent');
      }
    }

    // --- Pyrus's voice ---------------------------------------------------------

    echoQuestion(question) {
      this.speechEchoEl.textContent = question;
      this.speechEchoEl.hidden = false;
    }

    async speak(text) {
      if (!this.speechTextEl) return;
      this.speechDotsEl.hidden = true;
      if (this.speechEl) this.speechEl.classList.add('typing');
      try {
        await this.typeIntoElement(this.speechTextEl, text, null, 14);
      } finally {
        if (this.speechEl) this.speechEl.classList.remove('typing');
      }
    }

    think(label) {
      this.setMood('thinking');
      this.speechDotsEl.hidden = false;
      this.speechTextEl.textContent = label || 'One moment…';
      if (this.speechEl) this.speechEl.classList.add('typing');
      this.showQuickReplies([]);
    }

    setMood(mood) {
      if (!this.scene) return;
      this.scene.dataset.mood = mood;
      window.clearTimeout(this._moodTimer);
      if (mood === 'speaking' || mood === 'greeting' || mood === 'thinking') {
        this._moodTimer = window.setTimeout(() => { this.scene.dataset.mood = 'idle'; }, mood === 'thinking' ? 8000 : 3400);
      }
    }

    // --- Pyrus's gaze ---------------------------------------------------------
    // He has no drawn eyes to animate, so looking is done with his whole body:
    // he turns and leans toward whatever he is paying attention to, and the warm
    // light inside him travels the same way. The light is masked by his own
    // artwork, so it can never spill onto the page or land in the wrong place.

    trackPointer(event) {
      if (!this.isSummoned) return;
      // While he is answering about something specific he holds that gaze
      // instead of chasing the cursor away from it.
      if (this.gazeHoldUntil && performance.now() < this.gazeHoldUntil) return;
      var x = event.clientX;
      var y = event.clientY;
      if (this._gazeFrame) return;
      var self = this;
      this._gazeFrame = window.requestAnimationFrame(function () {
        self._gazeFrame = 0;
        self.aimGazeAt(x, y);
      });
    }

    aimGazeAt(clientX, clientY) {
      if (!this.bodyEl) return;
      var rect = this.bodyEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // Aim from roughly where his face is, not from his feet.
      var originX = rect.left + rect.width * 0.5;
      var originY = rect.top + rect.height * 0.32;
      var reachX = Math.max(window.innerWidth * 0.45, 420);
      var reachY = Math.max(window.innerHeight * 0.45, 380);
      this.applyGaze(
        Math.max(-1, Math.min(1, (clientX - originX) / reachX)),
        Math.max(-1, Math.min(1, (clientY - originY) / reachY))
      );
    }

    applyGaze(x, y) {
      if (!this.scene) return;
      this.gazeX = x;
      this.gazeY = y;
      this.scene.style.setProperty('--ai-gaze-x', x.toFixed(3));
      this.scene.style.setProperty('--ai-gaze-y', y.toFixed(3));
    }

    /* He turns to face what he is explaining and holds it while the answer plays. */
    lookAt(targetElement, holdMs) {
      if (!this.scene) return;
      var hold = holdMs || 7000;
      window.clearTimeout(this._focusTimer);
      window.clearTimeout(this._walkAimTimer);
      this.gazeHoldUntil = performance.now() + hold;

      var hasTarget = !!(targetElement && targetElement.getBoundingClientRect);
      if (hasTarget) {
        var rect = targetElement.getBoundingClientRect();
        this.aimGazeAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
        this.scene.dataset.focus = 'target';
      } else {
        this.scene.dataset.focus = 'page';
      }

      var self = this;
      this._focusTimer = window.setTimeout(function () {
        self.gazeHoldUntil = 0;
        if (self.scene) delete self.scene.dataset.focus;
      }, hold);

      // Walking moved him, so the angle to the target moved too — re-aim once he
      // has actually settled into his new stance.
      if (hasTarget) {
        var target = targetElement;
        this._walkAimTimer = window.setTimeout(function () {
          if (!target.isConnected) return;
          var settled = target.getBoundingClientRect();
          self.aimGazeAt(settled.left + settled.width / 2, settled.top + settled.height / 2);
        }, 620);
      }
    }

    releaseGaze() {
      window.clearTimeout(this._focusTimer);
      window.clearTimeout(this._walkAimTimer);
      this._focusTimer = 0;
      this._walkAimTimer = 0;
      this.gazeHoldUntil = 0;
      this._gazeFrame = 0;
      if (this.scene) delete this.scene.dataset.focus;
      this.applyGaze(0, 0);
    }

    /* Pyrus walks over to stand beside whatever he is talking about. */
    walkTo(targetElement) {
      var stage = this.scene;
      if (!stage) return;
      if (!targetElement || !targetElement.getBoundingClientRect) {
        stage.style.left = '';
        stage.style.top = '';
        stage.style.right = '';
        stage.style.bottom = '';
        return;
      }

      var target = targetElement.getBoundingClientRect();
      var width = stage.offsetWidth || 380;
      var height = stage.offsetHeight || 556;
      var gap = 18;
      var margin = 12;
      var candidates = [
        { left: target.right + gap, top: target.top - 30 },
        { left: target.left - width - gap, top: target.top - 30 },
        { left: target.left - width / 2, top: target.bottom + gap },
        { left: target.left - width / 2, top: target.top - height - gap }
      ];
      var card = document.querySelector('.ai-doubt-popup.open');
      var cardRect = card ? card.getBoundingClientRect() : null;
      var best = null;
      candidates.forEach(function (candidate) {
        var left = Math.max(margin, Math.min(candidate.left, window.innerWidth - width - margin));
        var top = Math.max(margin, Math.min(candidate.top, window.innerHeight - height - margin));
        var right = left + width;
        var bottom = top + height;
        var targetOverlap = Math.max(0, Math.min(right, target.right) - Math.max(left, target.left)) *
          Math.max(0, Math.min(bottom, target.bottom) - Math.max(top, target.top));
        var cardOverlap = cardRect
          ? Math.max(0, Math.min(right, cardRect.right) - Math.max(left, cardRect.left)) *
            Math.max(0, Math.min(bottom, cardRect.bottom) - Math.max(top, cardRect.top))
          : 0;
        var score = targetOverlap * 8 + cardOverlap * 12;
        if (!best || score < best.score) best = { left: left, top: top, score: score };
      });
      stage.style.right = 'auto';
      stage.style.bottom = 'auto';
      stage.style.left = best.left + 'px';
      stage.style.top = best.top + 'px';
    }

    typeIntoElement(element, text, scrollContainer, speed) {
      if (!element) return Promise.resolve();
      var value = String(text || '');
      var token = (Number(element.dataset.typeToken) || 0) + 1;
      element.dataset.typeToken = String(token);
      element.textContent = '';
      var index = 0;
      var delay = speed || 12;
      var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      
      return new Promise((resolve) => {
        if (reducedMotion || value.length > 1200) {
          element.textContent = value;
          resolve();
          return;
        }
        var typeNext = () => {
          if (element.dataset.typeToken !== String(token)) {
            resolve();
            return;
          }
          index = Math.min(index + 2, value.length);
          element.textContent = value.slice(0, index);
          if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
          if (index < value.length) {
            window.setTimeout(typeNext, delay);
          } else {
            resolve();
          }
        };
        typeNext();
      });
    }

    // The detail card's footer keeps the conversation going — Pyrus answers in
    // his speech cloud, no chat window involved.
    handlePopupAction(data, action) {
      if (!data || !data.concept) return;
      var query = action === 'simplify'
        ? 'Explain ' + data.concept + ' more simply'
        : 'Tell me more about ' + data.concept;
      this.handleUserQuestion(query, this.currentContextElement);
    }
  }

  // Auto-boot once DOM is ready
  function boot() {
    if (document.body) {
      window.PrometheusAIApp = new PrometheusAIApplication();
    } else {
      document.addEventListener('DOMContentLoaded', boot);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
