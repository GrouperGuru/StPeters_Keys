/* =============================================================================
 * flip.js — page navigation: fit-to-view zoom + the book page-turn animation.
 *
 * Exposes window.Keys.Flip. Depends on nothing at load time (it only touches
 * the DOM inside functions that run after DOMContentLoaded).
 *
 * Markup contract (index.html):
 *
 *   #stage-viewport            scroll / centering container (CSS owns padding)
 *     #stage-sizer             JS sets px width/height = scaled page size
 *       #page-stage            CSS sets `perspective`; JS sets width/height and
 *                              `transform: scale(k)` with origin top-left
 *         .paper[data-page]    absolutely stacked at inset 0, one per page
 *
 * Two responsibilities:
 *
 *   (A) ZOOM — the whole active page must be visible at once with no scrolling
 *       in 'fit' mode. The page's real pixel size is *measured* from the
 *       `.paper` element (it is sized in inches by paper.css, and page 4 is
 *       landscape) — never hard-coded — using offsetWidth/offsetHeight, which
 *       are transform-independent, so the stage's own scale can't skew it.
 *
 *   (B) PAGE TURN — a book with the spine on the LEFT. Forward turns sweep
 *       right-to-left: the outgoing leaf rotates rotateY(0) -> rotateY(-180deg)
 *       above the incoming page. Backward turns bring the incoming leaf in from
 *       rotateY(-180deg) -> rotateY(0). Every turn ends on whichever comes
 *       first — `transitionend` (filtered) or a timeout guard — so a page can
 *       never be left mid-flight, and a re-entrant go() snaps the in-flight
 *       turn to its settled state before starting the new one.
 *
 * Visibility model (load-bearing — fit.js measures inactive pages):
 * inactive pages stay in layout. They are hidden with `visibility: hidden` +
 * `pointer-events: none`, NEVER `display: none`. See applyVisibility() and the
 * class/inline-style table in showPage()/hidePage().
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  /* ---------------------------------------------------------------------------
   * Tunables
   * ------------------------------------------------------------------------ */
  var DURATION = 620;                                  /* ms, per spec */
  var EASING = 'cubic-bezier(.36,.06,.2,1)';           /* per spec */
  var FALLBACK_SLACK = 140;                            /* timeout guard margin */

  var MAX_FIT_SCALE = 2;        /* never blow a page up past 200% in fit mode */
  var MIN_SCALE = 0.05;
  var MAX_MANUAL_SCALE = 4;
  var ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

  var SHADE_PEAK = 0.55;        /* .paper-shade opacity at mid-turn */
  var SHADOW_MID = '0 26px 60px rgba(0, 0, 0, 0.45)';
  var SHADOW_FLAT = '0 0 0 rgba(0, 0, 0, 0)';

  var Z_TURN = 30;              /* the leaf being turned */
  var Z_ACTIVE = 2;             /* the settled, visible page */
  var Z_IDLE = 1;               /* everything else */

  /* Classes this module owns. paper.css / app.css may style them but must not
   * depend on them being present at any particular moment. */
  var CLS_PAPER = 'paper';
  var CLS_HIDDEN = 'is-hidden';
  var CLS_ACTIVE = 'is-active';
  var CLS_TURNING = 'is-turning';
  var CLS_SHADE = 'paper-shade';

  /* Used only if the stylesheet supplies no gradient for .paper-shade. */
  var SHADE_FALLBACK_BG =
    'linear-gradient(to right,' +
    ' rgba(0,0,0,0.40) 0%,' +
    ' rgba(0,0,0,0.10) 28%,' +
    ' rgba(255,255,255,0.18) 64%,' +
    ' rgba(0,0,0,0.06) 100%)';

  /* Used only if the stylesheet supplies no perspective for #page-stage. */
  var PERSPECTIVE_FALLBACK = '2200px';

  /* ---------------------------------------------------------------------------
   * Module state
   * ------------------------------------------------------------------------ */
  var viewport = null;   /* #stage-viewport */
  var sizer = null;      /* #stage-sizer   */
  var stage = null;      /* #page-stage    */
  var pages = [];        /* live NodeList snapshot, DOM order == page order */

  var inited = false;
  var current = 1;       /* 1-based */
  var onChange = null;

  var zoomMode = 'fit';  /* 'fit' | 'manual' */
  var manualScale = 1;
  var appliedScale = 1;  /* the scale actually written to #page-stage */

  var turn = null;       /* in-flight turn record, or null */
  var generation = 0;    /* bumped per turn; stale callbacks become no-ops */

  var rafId = 0;
  var observer = null;
  var globalsBound = false;

  /* ---------------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------------ */
  function clamp(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function toNum(v, dflt) {
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  function reducedMotion() {
    /* Queried live, not cached, so an OS/emulation change takes effect at once. */
    try {
      return !!(global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function notify() {
    if (typeof onChange !== 'function') return;
    onChange(current, pages.length);
  }

  /* ---------------------------------------------------------------------------
   * Binding — discover the stage elements and the .paper nodes.
   *
   * Called by init() and re-called by relayout(): render.js rebuilds the preview
   * on structural changes, so the .paper nodes we hold are thrown away and we
   * must re-bind to the new ones.
   * ------------------------------------------------------------------------ */
  function readPages() {
    if (!stage) return [];
    var list = stage.querySelectorAll('.' + CLS_PAPER);
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  /* Direct-child scan rather than querySelector, so a `.paper-shade` that
   * somehow ends up nested in page content is never mistaken for ours. */
  function findShade(page) {
    if (!page) return null;
    var kids = page.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains(CLS_SHADE)) {
        return kids[i];
      }
    }
    return null;
  }

  /** Ensure a `.paper-shade` overlay exists inside a page and is inert. */
  function ensureShade(page) {
    var shade = findShade(page);
    if (!shade) {
      shade = document.createElement('div');
      shade.className = CLS_SHADE;
      shade.setAttribute('aria-hidden', 'true');
      page.appendChild(shade);
    }
    /* Geometry + inertness are ours; the gradient itself belongs to paper.css. */
    shade.style.position = 'absolute';
    shade.style.left = '0';
    shade.style.top = '0';
    shade.style.right = '0';
    shade.style.bottom = '0';
    shade.style.pointerEvents = 'none';
    shade.style.opacity = '0';
    if (!shade.style.backgroundImage) {
      var bg = '';
      try {
        bg = global.getComputedStyle(shade).backgroundImage;
      } catch (e) { /* ignore */ }
      if (!bg || bg === 'none') shade.style.backgroundImage = SHADE_FALLBACK_BG;
    }
    return shade;
  }

  function shadeOf(page) {
    return page ? ensureShade(page) : null;
  }

  /** Per-page setup that must survive a preview re-render. */
  function bindPage(page) {
    var cs = null;
    try {
      cs = global.getComputedStyle(page);
    } catch (e) { /* ignore */ }

    /* The hinge is the spine on the left; the backface must not show through
     * once the leaf passes 90deg. paper.css should declare both — we set them
     * inline so the turn is correct even if it doesn't. */
    page.style.transformOrigin = 'left center';
    page.style.backfaceVisibility = 'hidden';
    page.style.webkitBackfaceVisibility = 'hidden';

    /* Stacking fallback only: if the stylesheet forgot `position:absolute`,
     * the pages would flow vertically and the turn would be nonsense. */
    if (cs && cs.position === 'static') {
      page.style.position = 'absolute';
      page.style.left = '0';
      page.style.top = '0';
    }

    ensureShade(page);
  }

  function bind() {
    viewport = document.getElementById('stage-viewport');
    sizer = document.getElementById('stage-sizer');
    stage = document.getElementById('page-stage');
    if (!viewport || !sizer || !stage) {
      pages = [];
      return false;
    }

    pages = readPages();
    for (var i = 0; i < pages.length; i++) bindPage(pages[i]);

    stage.style.transformOrigin = 'top left';
    var sc = null;
    try {
      sc = global.getComputedStyle(stage);
    } catch (e) { /* ignore */ }
    if (sc && (!sc.perspective || sc.perspective === 'none')) {
      stage.style.perspective = PERSPECTIVE_FALLBACK;
    }

    return pages.length > 0;
  }

  /* ---------------------------------------------------------------------------
   * Visibility — exactly one visible page once anything settles.
   *
   * Inactive pages keep their box in layout so Keys.Fit can measure them.
   * ------------------------------------------------------------------------ */
  function showPage(page, z) {
    if (!page) return;
    page.style.visibility = 'visible';
    page.style.pointerEvents = '';
    page.style.zIndex = String(z);
    page.classList.remove(CLS_HIDDEN);
  }

  function hidePage(page) {
    if (!page) return;
    page.style.visibility = 'hidden';      /* never display:none — see spec §4 */
    page.style.pointerEvents = 'none';
    page.style.zIndex = String(Z_IDLE);
    page.classList.add(CLS_HIDDEN);
    page.classList.remove(CLS_ACTIVE);
  }

  /** Settled state: page `current` visible and active, all others hidden. */
  function applyVisibility() {
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      if (i === current - 1) {
        showPage(page, Z_ACTIVE);
        page.classList.add(CLS_ACTIVE);
      } else {
        hidePage(page);
      }
    }
  }

  /* ---------------------------------------------------------------------------
   * (A) Zoom / fit-to-view
   * ------------------------------------------------------------------------ */

  /** Real, unscaled pixel size of the active page. Measured, never assumed. */
  function pageSize() {
    var page = pages[current - 1] || pages[0];
    if (!page) return null;

    /* offsetWidth/Height ignore ancestor transforms, so the scale we already
     * applied to #page-stage cannot feed back into the measurement. */
    var w = page.offsetWidth;
    var h = page.offsetHeight;

    if (!w || !h) {
      /* Last resort: un-apply the known scale from the painted box. */
      var rect = page.getBoundingClientRect();
      var k = appliedScale || 1;
      w = rect.width / k;
      h = rect.height / k;
    }
    if (!w || !h) return null;   /* unmeasurable (detached / display:none) */
    return { w: w, h: h };
  }

  /** Inner content box of #stage-viewport, padding removed. */
  function availableBox() {
    if (!viewport) return null;
    var cs;
    try {
      cs = global.getComputedStyle(viewport);
    } catch (e) {
      cs = null;
    }
    var padX = cs
      ? toNum(cs.paddingLeft, 0) + toNum(cs.paddingRight, 0)
      : 0;
    var padY = cs
      ? toNum(cs.paddingTop, 0) + toNum(cs.paddingBottom, 0)
      : 0;

    /* clientWidth/Height already exclude borders and any scrollbar. */
    return {
      w: viewport.clientWidth - padX,
      h: viewport.clientHeight - padY
    };
  }

  function fitScaleFor(size) {
    var box = availableBox();
    if (!box || box.w <= 0 || box.h <= 0) return 0;
    var k = Math.min(box.w / size.w, box.h / size.h);
    if (!isFinite(k) || k <= 0) return 0;
    return clamp(k, MIN_SCALE, MAX_FIT_SCALE);
  }

  /** Effective scale for the current mode, or 0 if it can't be determined. */
  function effectiveScale(size) {
    if (zoomMode === 'manual') {
      return clamp(manualScale, MIN_SCALE, MAX_MANUAL_SCALE);
    }
    return fitScaleFor(size);
  }

  /**
   * Size the stage to the ACTIVE page (page 4 is landscape, so this changes as
   * you navigate), scale it, and size #stage-sizer to the scaled footprint so
   * centering and scrollbars behave.
   */
  function applyZoom() {
    if (!inited || !stage || !sizer) return appliedScale;

    var size = pageSize();
    if (!size) return appliedScale;      /* nothing sane to compute from */

    var k = effectiveScale(size);
    if (!k) return appliedScale;         /* viewport not laid out yet */

    appliedScale = k;

    /* The stage box is the *unscaled* page; the transform does the shrinking. */
    stage.style.width = size.w + 'px';
    stage.style.height = size.h + 'px';
    stage.style.transformOrigin = 'top left';
    stage.style.transform = 'scale(' + k + ')';

    sizer.style.width = (size.w * k) + 'px';
    sizer.style.height = (size.h * k) + 'px';

    return k;
  }

  /** rAF-coalesced applyZoom, for bursty resize/observer traffic. */
  function scheduleZoom() {
    if (rafId) return;
    rafId = global.requestAnimationFrame(function () {
      rafId = 0;
      applyZoom();
    });
  }

  function nearestStep(scale, dir) {
    var i;
    if (dir > 0) {
      for (i = 0; i < ZOOM_STEPS.length; i++) {
        if (ZOOM_STEPS[i] > scale + 0.001) return ZOOM_STEPS[i];
      }
      return ZOOM_STEPS[ZOOM_STEPS.length - 1];
    }
    for (i = ZOOM_STEPS.length - 1; i >= 0; i--) {
      if (ZOOM_STEPS[i] < scale - 0.001) return ZOOM_STEPS[i];
    }
    return ZOOM_STEPS[0];
  }

  /* ---------------------------------------------------------------------------
   * (B) The page turn
   * ------------------------------------------------------------------------ */

  /** Strip every transform/transition artefact a turn leaves behind. */
  function clearTurnStyles(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var page = nodes[i];
      if (!page) continue;
      page.style.transition = '';
      page.style.transform = '';
      page.style.boxShadow = '';
      page.classList.remove(CLS_TURNING);
      var shade = findShade(page);
      if (shade) {
        shade.style.transition = '';
        shade.style.opacity = '0';
      }
    }
  }

  /**
   * Settle a turn. Idempotent and generation-guarded: whichever of
   * `transitionend` / the timeout fallback / a re-entrant go() gets here first
   * wins, and every later caller is a no-op.
   */
  function finishTurn(record) {
    if (!record || record.done) return;
    record.done = true;

    if (record.timer) { global.clearTimeout(record.timer); record.timer = 0; }
    if (record.midTimer) { global.clearTimeout(record.midTimer); record.midTimer = 0; }
    if (record.handler && record.animPage) {
      record.animPage.removeEventListener('transitionend', record.handler);
    }
    for (var i = 0; i < record.anims.length; i++) {
      try { record.anims[i].cancel(); } catch (e) { /* ignore */ }
    }
    record.anims.length = 0;

    if (turn === record) turn = null;

    clearTurnStyles(record.nodes);
    /* `current` was committed when the turn started, so this lands on the
     * turn's destination — including when we are being cancelled mid-flight. */
    applyVisibility();
  }

  /** Ramp .paper-shade up through mid-turn and back down, plus a tracking shadow. */
  function rampShading(record) {
    var page = record.animPage;
    var shade = shadeOf(page);

    if (typeof page.animate === 'function') {
      /* Web Animations: one self-terminating keyframe run, and — unlike a
       * transition — it never fires transitionend, so the settle filter below
       * stays clean. */
      try {
        record.anims.push(shade.animate(
          [
            { opacity: 0 },
            { opacity: SHADE_PEAK, offset: 0.5 },
            { opacity: 0 }
          ],
          { duration: DURATION, easing: 'linear', fill: 'none' }
        ));
        record.anims.push(page.animate(
          [
            { boxShadow: SHADOW_FLAT },
            { boxShadow: SHADOW_MID, offset: 0.5 },
            { boxShadow: SHADOW_FLAT }
          ],
          { duration: DURATION, easing: 'linear', fill: 'none' }
        ));
        return;
      } catch (e) { /* fall through to the transition-based ramp */ }
    }

    /* Fallback: two transition phases on the overlay only. Guarded by the same
     * record, so a cancelled turn never gets its second phase. */
    var half = Math.round(DURATION * 0.45);
    shade.style.transition = 'opacity ' + half + 'ms linear';
    shade.style.opacity = String(SHADE_PEAK);
    record.midTimer = global.setTimeout(function () {
      if (record.done) return;
      shade.style.transition = 'opacity ' + (DURATION - half) + 'ms linear';
      shade.style.opacity = '0';
    }, half);
  }

  /**
   * Animate exactly ONE leaf from page `from` to page `to`, whatever the
   * distance (1 -> 4 is a single forward turn, never a chain of three).
   */
  function startTurn(from, to) {
    var forward = to > from;
    var outgoing = pages[from - 1];
    var incoming = pages[to - 1];
    if (!outgoing || !incoming || outgoing === incoming) {
      applyVisibility();
      return;
    }

    /* Forward: the OUTGOING leaf turns away over the incoming page.
     * Backward: the INCOMING leaf turns in on top of the outgoing page. */
    var animPage = forward ? outgoing : incoming;
    var restPage = forward ? incoming : outgoing;

    var record = {
      token: ++generation,
      from: from,
      to: to,
      forward: forward,
      animPage: animPage,
      restPage: restPage,
      nodes: [animPage, restPage],
      handler: null,
      timer: 0,
      midTimer: 0,
      anims: [],
      done: false
    };
    turn = record;

    /* Only the two participating pages are visible during the turn. */
    for (var i = 0; i < pages.length; i++) {
      if (pages[i] !== animPage && pages[i] !== restPage) hidePage(pages[i]);
    }

    restPage.style.transition = 'none';
    restPage.style.transform = 'none';
    showPage(restPage, Z_IDLE);

    animPage.classList.add(CLS_TURNING);
    animPage.style.transition = 'none';
    animPage.style.transform = forward ? 'rotateY(0deg)' : 'rotateY(-180deg)';
    showPage(animPage, Z_TURN);
    animPage.style.pointerEvents = 'none';   /* inert while it moves */

    /* The destination page is the active one from now on. */
    incoming.classList.add(CLS_ACTIVE);
    outgoing.classList.remove(CLS_ACTIVE);

    /* Flush the start state so the transition actually has somewhere to go. */
    void stage.offsetWidth;

    animPage.style.transition = 'transform ' + DURATION + 'ms ' + EASING;
    animPage.style.transform = forward ? 'rotateY(-180deg)' : 'rotateY(0deg)';

    rampShading(record);

    /* Guard 1: the real event, filtered to this page and this property. */
    record.handler = function (ev) {
      if (ev.target !== animPage) return;          /* ignore descendants */
      if (ev.propertyName !== 'transform') return; /* ignore shade/shadow */
      if (record.token !== generation) return;     /* stale turn */
      finishTurn(record);
    };
    animPage.addEventListener('transitionend', record.handler);

    /* Guard 2: fires slightly after the duration in case the event is dropped
     * (background tab, interrupted compositing, no transition support).
     * Whichever guard arrives first settles the turn; the other is a no-op. */
    record.timer = global.setTimeout(function () {
      if (record.token !== generation) return;     /* stale turn */
      finishTurn(record);
    }, DURATION + FALLBACK_SLACK);
  }

  /* ---------------------------------------------------------------------------
   * Navigation
   * ------------------------------------------------------------------------ */
  function go(n, opts) {
    if (!inited || !pages.length) return current;

    var wanted = parseInt(n, 10);
    if (!isFinite(wanted)) return current;
    var target = clamp(wanted, 1, pages.length);

    /* Re-entrancy: snap the in-flight turn to its settled state first. It has
     * already reported its own destination, so no extra onChange here. */
    if (turn) finishTurn(turn);

    var from = current;
    var animate = !(opts && opts.animate === false);

    if (target === from) {
      /* No-op navigation, but still re-assert a clean settled state and report,
       * because app.js relies on onChange to refresh its chrome. */
      applyVisibility();
      applyZoom();
      notify();
      return current;
    }

    current = target;

    /* Size the stage for the destination up front: page 4 is landscape, so the
     * incoming page needs its own footprint the moment it is revealed. */
    applyZoom();

    if (animate && !reducedMotion()) {
      startTurn(from, target);
    } else {
      generation++;                /* invalidate anything still holding a token */
      applyVisibility();
    }

    notify();
    return current;
  }

  /* ---------------------------------------------------------------------------
   * Resize plumbing
   * ------------------------------------------------------------------------ */
  function bindGlobals() {
    if (globalsBound) return;
    globalsBound = true;

    global.addEventListener('resize', scheduleZoom);
    global.addEventListener('orientationchange', scheduleZoom);

    if (typeof global.ResizeObserver === 'function') {
      observer = new global.ResizeObserver(scheduleZoom);
    }

    /* A late-loading font can change the fitted page font size; the paper's own
     * box is in inches, but re-measure anyway — it is nearly free. */
    if (document.fonts && document.fonts.ready &&
        typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(scheduleZoom, function () {});
    }
  }

  function observeViewport() {
    if (!observer || !viewport) return;
    try { observer.disconnect(); } catch (e) { /* ignore */ }
    try { observer.observe(viewport); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------------ */
  var Flip = {
    /**
     * @param {{onChange:function(number, number)}} [opts]
     * No-ops gracefully (returns false) if the stage markup or the pages are
     * missing — the app must still boot.
     */
    init: function (opts) {
      if (opts && typeof opts.onChange === 'function') onChange = opts.onChange;

      var ok = bind();
      if (!ok) {
        inited = false;
        return false;
      }

      inited = true;
      current = clamp(current, 1, pages.length);

      bindGlobals();
      observeViewport();

      applyVisibility();
      applyZoom();
      notify();                    /* requirement: fires on init too */
      return true;
    },

    /** Navigate. `n` is 1-based and is clamped to [1, totalPages]. */
    go: function (n, opts) {
      return go(n, opts);
    },

    next: function () {
      return go(current + 1, { animate: true });
    },

    prev: function () {
      return go(current - 1, { animate: true });
    },

    current: function () {
      return current;
    },

    /** 'fit' returns to automatic fit-to-view; a number sets manual zoom. */
    setZoom: function (v) {
      if (v === 'fit' || v === 'auto' || v == null) {
        zoomMode = 'fit';
      } else {
        var k = parseFloat(v);
        if (!isFinite(k) || k <= 0) return this.getZoom();
        zoomMode = 'manual';
        manualScale = clamp(k, MIN_SCALE, MAX_MANUAL_SCALE);
      }
      applyZoom();
      return this.getZoom();
    },

    getZoom: function () {
      return { mode: zoomMode, scale: appliedScale };
    },

    zoomIn: function () {
      return this.setZoom(nearestStep(appliedScale, 1));
    },

    zoomOut: function () {
      return this.setZoom(nearestStep(appliedScale, -1));
    },

    /**
     * Re-read the stage and the `.paper` nodes, then re-apply the current
     * page's visibility and the current zoom. MUST be called after render.js
     * rebuilds the preview, because the old `.paper` nodes are gone.
     * Reports through onChange when the page count or the current page moved.
     */
    relayout: function () {
      if (turn) finishTurn(turn);        /* nodes may be about to vanish */
      if (rafId) {
        global.cancelAnimationFrame(rafId);
        rafId = 0;
      }

      var prevTotal = pages.length;
      var prevCurrent = current;

      var ok = bind();
      inited = !!(viewport && sizer && stage);
      if (!ok) return false;

      observeViewport();
      current = clamp(current, 1, pages.length);
      applyVisibility();
      applyZoom();

      if (current !== prevCurrent || pages.length !== prevTotal) notify();
      return true;
    },

    /** Verification hook — see tools/verify.js. */
    debugState: function () {
      var visible = [];
      for (var i = 0; i < pages.length; i++) {
        var v = 'visible';
        try {
          v = global.getComputedStyle(pages[i]).visibility;
        } catch (e) { /* ignore */ }
        if (v !== 'hidden' && v !== 'collapse') visible.push(i + 1);
      }
      return {
        current: current,
        total: pages.length,
        zoom: { mode: zoomMode, scale: appliedScale },
        visiblePages: visible,
        animating: !!turn
      };
    },

    /* Exposed for app.css/paper.css authors and the verifier. */
    DURATION: DURATION,
    EASING: EASING,
    ZOOM_STEPS: ZOOM_STEPS
  };

  Keys.Flip = Flip;
})(window);
