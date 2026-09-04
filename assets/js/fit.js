/* =============================================================================
 * fit.js — overflow prevention.  Exposes window.Keys.Fit.
 *
 * Hard requirement (SPEC §4): no content may ever overflow a page. Two tiers,
 * both implemented as *binary searches over a quantised size ladder* — never a
 * linear walk — so a full refit costs a bounded number of forced reflows.
 *
 *   TIER 1  [data-fit] box  ->  scales its single `.fit-inner` child's
 *           font-size within [data-fit-min .. data-fit-max] (default 6..16px)
 *           at 0.25px resolution until the inner neither scrolls vertically
 *           nor horizontally inside the box.
 *
 *   TIER 2  .paper[data-fit-page]  ->  multiplies the `.paper-flow` CSS
 *           default font-size by a factor in [PAGE_SCALE_MIN .. 1.0] until the
 *           flow no longer overflows the fixed-size `.paper`.
 *
 * Three traps this file is deliberately careful about:
 *
 *   1. RATCHETING.  Tier 2 must always compute from the *CSS default* size of
 *      `.paper-flow`, never from whatever inline size a previous pass left
 *      behind. Otherwise every refit multiplies the previous result and the
 *      page shrinks away to nothing. The natural size is therefore read once
 *      (with our inline value stripped first) and cached both in a WeakMap and
 *      in a `data-fit-natural` attribute (survives WeakMap loss / re-render).
 *
 *   2. TIER ORDER.  A tier-1 box's available height can depend on the page
 *      scale, so the order is: tier 2 -> tier 1 -> tier 2 re-measure (one
 *      extra round, then stop; no unbounded iteration).
 *
 *   3. OBSERVER FEEDBACK.  Writing font-size from inside a ResizeObserver
 *      callback can retrigger that observer. A re-entrancy flag plus a
 *      "did the observed box actually change size?" check break the loop.
 *
 * Pages that are not the active page still measure correctly because flip.js
 * hides them with `visibility`, never `display:none`. Defensively, anything
 * measuring zero height is skipped and queued for a bounded retry rather than
 * being fitted against nonsense geometry.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  /* --- tier 1 ------------------------------------------------------------- */
  var BOX_MIN_DEFAULT = 6;      // px, when [data-fit-min] is absent
  var BOX_MAX_DEFAULT = 16;     // px, when [data-fit-max] is absent
  var BOX_STEP = 0.25;          // px resolution of the ladder

  /* --- tier 2 ------------------------------------------------------------- */
  /* Floor multiplier of the CSS default size. This is a last-resort legibility
   * guard, not a target — the binary search always prefers the largest scale
   * that fits, so a normal issue never gets near it.
   *
   * 0.5 of the 10.5pt base is ~5.25pt. That is small, but the alternative at
   * this point is CLIPPING the author's text, which is strictly worse: they
   * lose content instead of getting tight content plus the on-screen
   * .is-overflowing warning. Raising this back to 0.6 makes page 3 clip on a
   * genuinely busy week, because its lunch slips are auto-height and the
   * page-level pass is the only thing that can shrink them. */
  var PAGE_SCALE_MIN = 0.5;
  var PAGE_SCALE_MAX = 1.0;     // natural size
  var PAGE_SCALE_STEP = 0.005;  // 80 rungs -> 7 probes

  /* --- misc --------------------------------------------------------------- */
  var OVERFLOW_EPS = 0.5;       // sub-pixel slack for rect-based measurement
  var MAX_ZERO_RETRIES = 5;     // give up eventually on zero-height elements
  var RETRY_DELAY = 120;        // ms, fallback retry when rAF isn't enough
  var OVERFLOW_CLASS = 'is-overflowing';

  /* Caches. WeakMaps so detached DOM is collectable. */
  var naturalSize = new WeakMap();   // .paper-flow -> px number (CSS default)
  var boxCache = new WeakMap();      // [data-fit]  -> { sig, size, overflowing }
  var lastFit = new WeakMap();       // any fitted el -> { size, overflowing }
  var zeroTries = new WeakMap();     // el -> retry count
  var observedSize = new WeakMap();  // observed el -> 'wxh' string

  var running = false;      // re-entrancy guard: a fit pass is in flight
  var rafHandle = 0;        // coalescing handle for observer-driven refits
  var retryHandle = 0;      // timeout handle for the zero-geometry retry
  var retryQueue = [];      // elements skipped this pass for zero geometry
  var observer = null;      // the single ResizeObserver
  var installed = false;    // init() ran at least once
  var fontsHooked = false;  // document.fonts.ready hook installed

  /* ---------------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------------ */

  function num(value, fallback) {
    var n = parseFloat(value);
    return isFinite(n) ? n : fallback;
  }

  function attrNum(el, name, fallback) {
    return el.hasAttribute(name) ? num(el.getAttribute(name), fallback) : fallback;
  }

  function round(value, places) {
    var f = Math.pow(10, places || 0);
    return Math.round(value * f) / f;
  }

  function classList(el) {
    var raw = el.getAttribute && el.getAttribute('class');
    return raw ? String(raw).split(/\s+/) : [];
  }

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  /** The one `.fit-inner` element child of a [data-fit] box (no deep search —
   *  nested fit boxes must keep their own inners). */
  function fitInnerOf(box) {
    var kids = box.children;
    for (var i = 0; i < kids.length; i++) {
      if (classList(kids[i]).indexOf('fit-inner') !== -1) return kids[i];
    }
    return null;
  }

  function flowOf(pageEl) {
    var kids = pageEl.children;
    for (var i = 0; i < kids.length; i++) {
      if (classList(kids[i]).indexOf('paper-flow') !== -1) return kids[i];
    }
    return pageEl.querySelector ? pageEl.querySelector('.paper-flow') : null;
  }

  function isPaper(el) {
    return !!el && el.nodeType === 1 && classList(el).indexOf('paper') !== -1;
  }

  function pageOf(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el) {
      if (isPaper(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function pages() {
    return toArray(global.document.querySelectorAll('.paper[data-fit-page]'));
  }

  function allBoxes(root) {
    return toArray((root || global.document).querySelectorAll('[data-fit]'));
  }

  function setOverflowing(el, on) {
    if (!el || !el.classList) return;
    if (on) el.classList.add(OVERFLOW_CLASS);
    else el.classList.remove(OVERFLOW_CLASS);
  }

  function computedFontPx(el) {
    var cs = global.getComputedStyle ? global.getComputedStyle(el) : null;
    return cs ? num(cs.fontSize, 0) : 0;
  }

  /* ---------------------------------------------------------------------------
   * Zero-geometry retry queue
   *
   * Inactive pages are `visibility:hidden` so they always have layout, but a
   * page can still measure 0 while its stylesheet is loading or while it sits
   * in a detached fragment. Fitting against 0 would produce a bogus minimum
   * size, so skip and try again shortly (bounded, so a permanently collapsed
   * element can never spin forever).
   * ------------------------------------------------------------------------ */

  function queueRetry(el) {
    var tries = zeroTries.get(el) || 0;
    if (tries >= MAX_ZERO_RETRIES) return;
    zeroTries.set(el, tries + 1);
    if (retryQueue.indexOf(el) === -1) retryQueue.push(el);
  }

  function clearRetry(el) {
    if (zeroTries.get(el)) zeroTries.set(el, 0);
  }

  function flushRetryQueue() {
    if (!retryQueue.length || retryHandle) return;
    retryQueue = [];
    retryHandle = global.setTimeout(function () {
      retryHandle = 0;
      if (!running) refitAll();
    }, RETRY_DELAY);
  }

  /* ---------------------------------------------------------------------------
   * TIER 2 — natural (CSS default) font size of a .paper-flow
   *
   * THE RATCHET TRAP. `getComputedStyle(flow).fontSize` returns whatever we
   * last wrote inline. So: consult the caches first; only when there is no
   * cached value do we blank our inline value and read the real CSS default.
   * ------------------------------------------------------------------------ */
  function naturalFontSizeOf(flow) {
    var cached = naturalSize.get(flow);
    if (cached > 0) return cached;

    // Attribute cache: survives a WeakMap miss and innerHTML re-renders.
    var fromAttr = num(flow.getAttribute('data-fit-natural'), 0);
    if (fromAttr > 0) {
      naturalSize.set(flow, fromAttr);
      return fromAttr;
    }

    var previousInline = flow.style.fontSize;
    flow.style.fontSize = '';            // strip any scale we applied before
    var px = computedFontPx(flow);
    if (!(px > 0)) {
      flow.style.fontSize = previousInline;  // unmeasurable — leave as found
      return 0;
    }
    naturalSize.set(flow, px);
    flow.setAttribute('data-fit-natural', String(round(px, 4)));
    return px;
  }

  function applyFlowScale(flow, natural, scale) {
    flow.style.fontSize = round(natural * scale, 4) + 'px';
  }

  /* ---------------------------------------------------------------------------
   * measure(pageEl) -> { overflow, px }
   *
   * `px` is how far content exceeds the page's clip box (0 when it fits).
   * Two independent signals are combined:
   *   a) scroll vs client size on `.paper` and `.paper-flow` (integer px), and
   *   b) the rects of `.paper-flow`'s direct children against the paper's clip
   *      box — catches content that visually escapes even when the scroll
   *      metrics round down.
   * Rect deltas are divided by the stage's transform scale so both signals are
   * in CSS pixels. Descendants *inside* [data-fit] boxes are deliberately not
   * inspected: their overflow is tier 1's business, not the page's.
   * ------------------------------------------------------------------------ */
  function measure(pageEl) {
    var page = isPaper(pageEl) ? pageEl : pageOf(pageEl);
    if (!page) return { overflow: false, px: 0 };

    var clientH = page.clientHeight;
    var clientW = page.clientWidth;
    if (!clientH || !clientW) return { overflow: false, px: 0 };

    var worst = 0;
    function note(delta) { if (delta > worst) worst = delta; }

    note(page.scrollHeight - clientH);
    note(page.scrollWidth - clientW);

    var flow = flowOf(page);
    if (flow && flow.clientHeight) {
      note(flow.scrollHeight - flow.clientHeight);
      note(flow.scrollWidth - flow.clientWidth);
    }

    if (flow && page.getBoundingClientRect) {
      var pRect = page.getBoundingClientRect();
      // #page-stage is transform:scale()d — normalise rect deltas back to CSS px.
      var scale = page.offsetHeight ? pRect.height / page.offsetHeight : 1;
      if (!(scale > 0.01)) scale = 1;
      var clipTop = pRect.top + page.clientTop * scale;
      var clipLeft = pRect.left + page.clientLeft * scale;
      var clipBottom = clipTop + clientH * scale;
      var clipRight = clipLeft + clientW * scale;

      var kids = flow.children;
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i].getBoundingClientRect();
        if (!r.width && !r.height) continue;   // collapsed / hidden child
        var over = Math.max(r.bottom - clipBottom, r.right - clipRight) / scale;
        if (over > OVERFLOW_EPS) note(over);
      }
    }

    if (worst < 0) worst = 0;
    return { overflow: worst > 0, px: round(worst, 2) };
  }

  function pageFits(pageEl) {
    return !measure(pageEl).overflow;
  }

  /* ---------------------------------------------------------------------------
   * TIER 1 — one [data-fit] box
   * ------------------------------------------------------------------------ */

  /** Cheap change-detector so per-keystroke refits don't re-probe every box on
   *  the page. Covers content, box geometry and the tier-2 page scale (which is
   *  what makes a re-fit necessary after tier 2 changes). */
  function boxSignature(box, inner, min, max) {
    var flow = flowOf(pageOf(box) || box) || null;
    return [
      box.clientWidth, box.clientHeight,
      min, max,
      flow ? flow.style.fontSize : '',
      inner.innerHTML.length,
      inner.innerHTML
    ].join('');
  }

  /**
   * Binary-search the largest laddered font-size at which `.fit-inner` fits.
   * @param {Element} box   the [data-fit] element
   * @param {boolean} force ignore the change-detector cache
   * @returns {{size:number, overflowing:boolean}|null} null when skipped
   */
  function fitBox(box, force) {
    var inner = fitInnerOf(box);
    if (!inner) return null;

    var min = attrNum(box, 'data-fit-min', BOX_MIN_DEFAULT);
    var max = attrNum(box, 'data-fit-max', BOX_MAX_DEFAULT);
    if (!(min > 0)) min = BOX_MIN_DEFAULT;
    if (!(max > 0)) max = BOX_MAX_DEFAULT;
    if (max < min) { var swap = max; max = min; min = swap; }

    // Defensive: never fit against zero geometry (see retry queue above).
    if (!box.clientHeight || !box.clientWidth) {
      queueRetry(box);
      return null;
    }
    clearRetry(box);

    var sig = boxSignature(box, inner, min, max);
    var cached = boxCache.get(box);
    if (!force && cached && cached.sig === sig) {
      // Nothing that affects the outcome changed; the inline size is still on
      // the inner, so the previous result stands.
      var kept = { size: cached.size, overflowing: cached.overflowing };
      lastFit.set(box, kept);
      return kept;
    }

    var rungs = Math.max(0, Math.round((max - min) / BOX_STEP));
    function sizeAt(i) { return round(min + i * BOX_STEP, 4); }
    function fitsAt(i) {
      inner.style.fontSize = sizeAt(i) + 'px';
      // Ask the [data-fit] BOX whether its content overflows, because the box
      // is the element that actually clips (`.fit { overflow:hidden }`).
      //
      // Do NOT compare inner.scrollHeight against box.clientHeight: on a
      // padded box that is wrong in a way that silently clips. clientHeight
      // includes the box's padding, but `inner` is laid out inside it, so the
      // comparison hands out (padding-top + padding-bottom) of free slack.
      // `.cal-cell` carries 0.03in of vertical padding and clipped the densest
      // calendar day by ~2px for exactly this reason.
      //
      // box.scrollHeight reports the full content extent even under
      // overflow:hidden, so this is the exact clipping condition and it
      // accounts for padding, borders and margins automatically. Re-read every
      // probe: an auto-height box can move as the text reflows.
      return box.scrollHeight <= box.clientHeight &&
             box.scrollWidth <= box.clientWidth;
    }

    var chosen;
    var overflowing = false;

    if (fitsAt(rungs)) {
      chosen = rungs;                        // common case: max size is fine
    } else if (!fitsAt(0)) {
      chosen = 0;                            // even the floor overflows
      overflowing = true;
    } else {
      // Invariant: lo fits, hi does not. ~6 probes across a 40-rung ladder.
      var lo = 0;
      var hi = rungs;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (fitsAt(mid)) lo = mid; else hi = mid;
      }
      chosen = lo;
    }

    var size = sizeAt(chosen);
    inner.style.fontSize = size + 'px';
    setOverflowing(box, overflowing);

    var result = { size: size, overflowing: overflowing };
    boxCache.set(box, { sig: boxSignature(box, inner, min, max), size: size, overflowing: overflowing });
    lastFit.set(box, result);
    return result;
  }

  /* ---------------------------------------------------------------------------
   * TIER 2 — one page's .paper-flow
   * ------------------------------------------------------------------------ */

  /**
   * Binary-search the largest scale factor in [PAGE_SCALE_MIN..1] at which the
   * flow no longer overflows the paper. Always computed from the cached natural
   * size, so repeated calls are idempotent (never ratcheting).
   * @returns {{size:number, scale:number, overflowing:boolean}|null}
   */
  function fitPageFlow(pageEl) {
    var flow = flowOf(pageEl);
    if (!flow) return null;

    if (!pageEl.clientHeight || !pageEl.clientWidth) {
      queueRetry(pageEl);
      return null;
    }
    clearRetry(pageEl);

    var natural = naturalFontSizeOf(flow);
    if (!(natural > 0)) {
      queueRetry(pageEl);
      return null;
    }

    var rungs = Math.max(0, Math.round((PAGE_SCALE_MAX - PAGE_SCALE_MIN) / PAGE_SCALE_STEP));
    function scaleAt(i) { return round(PAGE_SCALE_MIN + i * PAGE_SCALE_STEP, 5); }
    function fitsAt(i) {
      applyFlowScale(flow, natural, scaleAt(i));
      return pageFits(pageEl);
    }

    var chosen;
    var overflowing = false;

    if (fitsAt(rungs)) {
      chosen = rungs;                        // fits at its natural size
    } else if (!fitsAt(0)) {
      chosen = 0;                            // still overflows at the floor
      overflowing = true;
    } else {
      var lo = 0;
      var hi = rungs;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (fitsAt(mid)) lo = mid; else hi = mid;
      }
      chosen = lo;
    }

    var scale = scaleAt(chosen);
    applyFlowScale(flow, natural, scale);
    setOverflowing(pageEl, overflowing);

    var result = {
      size: round(natural * scale, 4),
      scale: scale,
      overflowing: overflowing
    };
    lastFit.set(flow, { size: result.size, overflowing: overflowing });
    lastFit.set(pageEl, { size: result.size, overflowing: overflowing });
    return result;
  }

  /* ---------------------------------------------------------------------------
   * refitPage — tier 2, then tier 1, then one tier-2 re-measure
   * ------------------------------------------------------------------------ */
  function refitPageInternal(pageEl, force) {
    if (!pageEl) return null;
    var page = isPaper(pageEl) ? pageEl : pageOf(pageEl);
    if (!page) return null;

    var boxes = allBoxes(page);

    // 1. Page scale first — tier-1 boxes' available height can depend on it.
    var tier2 = fitPageFlow(page);

    // 2. Boxes, now measured against the (possibly changed) page scale. The box
    //    signature includes the flow's font-size, so a scale change invalidates
    //    every box cache on this page automatically.
    for (var i = 0; i < boxes.length; i++) fitBox(boxes[i], force);

    // 3. One re-measure of tier 2: fitting the boxes may have changed the flow
    //    height. Bounded to a single extra round — no iterate-to-convergence.
    if (tier2) {
      var after = measure(page);
      if (after.overflow) {
        var second = fitPageFlow(page);
        if (second && tier2 && second.scale !== tier2.scale) {
          // The scale moved, so the boxes' geometry moved with it: one more
          // (cache-invalidated) box pass, then stop.
          for (var j = 0; j < boxes.length; j++) fitBox(boxes[j], force);
          after = measure(page);
        }
        tier2 = second || tier2;
      }
      if (tier2) {
        tier2.overflowing = after.overflow;
        setOverflowing(page, after.overflow);
        lastFit.set(page, { size: tier2.size, overflowing: after.overflow });
      }
    }

    return tier2;
  }

  /* ---------------------------------------------------------------------------
   * Public entry points. These do their work SYNCHRONOUSLY — a caller (or a
   * Playwright assertion) may inspect the DOM the instant they return. Only the
   * observer-driven path is rAF-coalesced.
   * ------------------------------------------------------------------------ */

  function refitAll(opts) {
    var force = !!(opts && opts.force);
    if (rafHandle) {                 // a coalesced pass is pending; we're it now
      if (global.cancelAnimationFrame) global.cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    var wasRunning = running;
    running = true;
    try {
      var list = pages();
      for (var i = 0; i < list.length; i++) refitPageInternal(list[i], force);

      // [data-fit] boxes that live outside any fitted page (thumbnails, etc.).
      var boxes = allBoxes(global.document);
      for (var j = 0; j < boxes.length; j++) {
        var page = pageOf(boxes[j]);
        if (!page || !page.hasAttribute('data-fit-page')) fitBox(boxes[j], force);
      }
    } finally {
      running = wasRunning;
    }
    flushRetryQueue();
    return true;
  }

  function refitPage(pageEl) {
    var wasRunning = running;
    running = true;
    var out;
    try {
      out = refitPageInternal(pageEl, false);
    } finally {
      running = wasRunning;
    }
    flushRetryQueue();
    return out;
  }

  /** Editor hook: refit the nearest [data-fit] ancestor of a just-edited
   *  preview node, then its whole page (tier 2 may now be free to grow again,
   *  or may need to shrink). */
  function refitFor(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!el) return null;

    var wasRunning = running;
    running = true;
    try {
      var box = el.closest ? el.closest('[data-fit]') : null;
      if (box) fitBox(box, true);

      var page = pageOf(el);
      if (page && page.hasAttribute('data-fit-page')) {
        return refitPageInternal(page, false);
      }
      return box ? lastFit.get(box) || null : null;
    } finally {
      running = wasRunning;
      flushRetryQueue();
    }
  }

  /** Drop every cached measurement. Needed when glyph metrics change (web font
   *  swap) since neither the content nor the geometry signature moves. */
  function invalidate() {
    boxCache = new WeakMap();
    zeroTries = new WeakMap();
    observedSize = new WeakMap();
    retryQueue = [];
    // NOTE: naturalSize is *not* cleared — the CSS default font-size does not
    // change when a font finishes loading, and re-reading it while our inline
    // scale is applied is exactly the ratchet bug.
  }

  /* ---------------------------------------------------------------------------
   * Observers
   * ------------------------------------------------------------------------ */

  /** rAF-coalesced, re-entrancy-safe wrapper used only by observers. */
  function scheduleRefitAll() {
    if (running || rafHandle) return;
    if (!global.requestAnimationFrame) { refitAll(); return; }
    rafHandle = global.requestAnimationFrame(function () {
      rafHandle = 0;
      if (running) return;
      refitAll();
    });
  }

  function onResize(entries) {
    // Loop breaker: setting font-size can make a ResizeObserver fire again.
    // Ignore callbacks that arrive during a pass, and callbacks where no
    // observed box actually changed size.
    if (running) return;
    var changed = false;
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].target;
      var w = el.clientWidth;
      var h = el.clientHeight;
      var key = w + 'x' + h;
      if (observedSize.get(el) !== key) {
        observedSize.set(el, key);
        changed = true;
      }
    }
    if (changed) scheduleRefitAll();
  }

  /** Idempotent: safe to call again after render.js rebuilds the pages. */
  function init() {
    var doc = global.document;

    if (global.ResizeObserver) {
      if (!observer) observer = new global.ResizeObserver(onResize);
      var targets = pages();
      var viewport = doc.getElementById('stage-viewport');
      if (viewport) targets.push(viewport);
      for (var i = 0; i < targets.length; i++) {
        // observe() on an already-observed element is a no-op.
        observedSize.set(targets[i], targets[i].clientWidth + 'x' + targets[i].clientHeight);
        observer.observe(targets[i]);
      }
    }

    if (!fontsHooked && doc.fonts && doc.fonts.ready && doc.fonts.ready.then) {
      fontsHooked = true;
      doc.fonts.ready.then(function () {
        // Glyph metrics may have changed under us: forget the change-detector
        // caches and re-probe everything.
        invalidate();
        refitAll({ force: true });
      })['catch'](function () { /* fonts API rejected — nothing to do */ });
    }

    installed = true;
    scheduleRefitAll();
    return true;
  }

  /* ---------------------------------------------------------------------------
   * debugReport — verification aid for the integrator.
   * ------------------------------------------------------------------------ */

  function describe(el) {
    if (el.id) return '#' + el.id;
    var out = el.tagName ? el.tagName.toLowerCase() : '?';
    var cls = classList(el);
    for (var i = 0; i < cls.length; i++) {
      if (cls[i] && cls[i] !== OVERFLOW_CLASS) out += '.' + cls[i];
    }
    var id = el.getAttribute && (el.getAttribute('data-slip-id') || el.getAttribute('data-bind'));
    if (id) out += '[' + id + ']';
    if (el.parentElement) {
      var sibs = el.parentElement.children;
      var n = 0;
      for (var j = 0; j < sibs.length; j++) {
        if (sibs[j].tagName === el.tagName) {
          n++;
          if (sibs[j] === el) { out += ':nth-of-type(' + n + ')'; break; }
        }
      }
    }
    return out;
  }

  /** @returns {Array<{page:(number|null), selector:string, size:number,
   *                   overflowing:boolean}>} one row per fitted element. */
  function debugReport() {
    var rows = [];

    function pageNumber(el) {
      var page = pageOf(el);
      var raw = page ? page.getAttribute('data-page') : null;
      var n = num(raw, NaN);
      return isFinite(n) ? n : (raw || null);
    }

    function push(el, sizeEl) {
      var recorded = lastFit.get(el);
      var size = sizeEl ? computedFontPx(sizeEl) : 0;
      if (!(size > 0) && recorded) size = recorded.size;
      rows.push({
        page: pageNumber(el),
        selector: describe(el),
        size: round(size, 4),
        overflowing: el.classList ? el.classList.contains(OVERFLOW_CLASS) : false
      });
    }

    var list = pages();
    for (var i = 0; i < list.length; i++) {
      var flow = flowOf(list[i]);
      push(list[i], flow || list[i]);
    }

    var boxes = allBoxes(global.document);
    for (var j = 0; j < boxes.length; j++) {
      push(boxes[j], fitInnerOf(boxes[j]) || boxes[j]);
    }

    return rows;
  }

  Keys.Fit = {
    init: init,
    refitAll: refitAll,
    refitPage: refitPage,
    refitFor: refitFor,
    measure: measure,
    debugReport: debugReport,

    /* --- extras (not required by SPEC §4, useful to integrators) --- */
    invalidate: invalidate,
    isRunning: function () { return running; },
    isInstalled: function () { return installed; },
    OVERFLOW_CLASS: OVERFLOW_CLASS,
    BOX_MIN_DEFAULT: BOX_MIN_DEFAULT,
    BOX_MAX_DEFAULT: BOX_MAX_DEFAULT,
    BOX_STEP: BOX_STEP,
    PAGE_SCALE_MIN: PAGE_SCALE_MIN,
    PAGE_SCALE_MAX: PAGE_SCALE_MAX
  };
})(window);
