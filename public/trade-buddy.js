/**
 * PROMETHEUS AI INTELLIGENCE LAYER — BRIDGE LOADER (ROOT)
 */
(function () {
  'use strict';
  var oldFab = document.getElementById('globalTradeBuddy');
  if (oldFab) oldFab.remove();
  var oldPanel = document.getElementById('globalTbPanel');
  if (oldPanel) oldPanel.remove();

  var scripts = document.getElementsByTagName('script');
  var scriptUrl = '';
  for (var i = scripts.length - 1; i >= 0; i--) {
    if (scripts[i].src && scripts[i].src.indexOf('trade-buddy.js') !== -1) {
      scriptUrl = scripts[i].src;
      break;
    }
  }

  var basePath = scriptUrl ? scriptUrl.substring(0, scriptUrl.lastIndexOf('/') + 1) : '';
  // Pyrus's avatar ships in /assets. It is resolved from the script's own URL
  // rather than the page's, so the same path works at any route depth.
  window.__PrometheusPyrusAvatar = scriptUrl
    ? new URL('assets/pyrus.png', scriptUrl).href
    : '/assets/pyrus.png';

  // Sidebar shortcuts call Pyrus onto the page — the same single assistant that
  // is already mounted here, never a second copy.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest
      ? event.target.closest('[data-open-trading-buddy],a[href="#trading-buddy"],a[href="#chat-modal"]')
      : null;
    if (!link) return;
    event.preventDefault();
    var attempts = 0;
    (function openAssistant() {
      var app = window.PrometheusAIApp;
      if (app && typeof app.summonPyrus === 'function') { app.summonPyrus('manual'); return; }
      var fab = document.getElementById('aiDoubtFab');
      if (fab) { fab.click(); return; }
      if (++attempts < 25) window.setTimeout(openAssistant, 100);
    })();
  });

  if (!document.getElementById('aiDoubtSolverStyles')) {
    var css = document.createElement('link');
    css.id = 'aiDoubtSolverStyles';
    css.rel = 'stylesheet';
    css.href = basePath + 'ai-doubt-solver.css?v=2';
    document.head.appendChild(css);
  }

  if (!window.__PrometheusAIDoubtSolverScriptLoaded) {
    window.__PrometheusAIDoubtSolverScriptLoaded = true;
    var js = document.createElement('script');
    js.src = basePath + 'ai-doubt-solver.js?v=2';
    js.async = true;
    document.body ? document.body.appendChild(js) : document.addEventListener('DOMContentLoaded', function () {
      document.body.appendChild(js);
    });
  }
})();
