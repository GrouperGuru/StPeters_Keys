/* =============================================================================
 * arrange.js — Drag sections around the preview.
 *
 * Exposes window.Keys.Arrange. See docs/SPEC.md §11.
 *
 * WHY REORDER RATHER THAN FREE POSITIONING
 * ----------------------------------------
 * The requirement is that sections never overlap and never spill off the page.
 * Dragging to arbitrary x/y coordinates guarantees both failures on a fixed
 * print sheet, and "push things out of the way" collision solvers produce
 * layouts nobody would sign off on. So a drag moves a block to a new SLOT in
 * the page flow: blocks reflow around each other, which makes overlap
 * impossible by construction and keeps the print layout honest.
 *
 * Two safeguards on top of that:
 *   1. Every drop is GUARDED. The move is applied, the page re-measured, and
 *      if the destination now overflows (or pushed a shrink-to-fit box down to
 *      its floor) the move is rolled back and the user is told. This is what
 *      stops "spilling off the page" when, say, a long announcement is dragged
 *      from page 2 onto an already-full page 1.
 *   2. The handle lives in the app chrome, NOT inside the paper. Injecting
 *      anything into `.paper-flow` would be measured by the fit engine and
 *      would have to be stripped for print; a single floating handle that
 *      tracks the hovered block avoids both problems entirely.
 *
 * MARKUP CONTRACT (emitted by render.js / slips.js)
 *   Draggable block:  data-move="article|slip|rail"
 *                     data-move-key="<identifier within that kind>"
 *                     data-move-label="<human name, for the handle>"
 *   Drop container:   data-drop="article"  data-drop-list="articles.page1"
 *                     data-drop="slip"     data-drop-col="left|right"
 *                     data-drop="rail"
 * A block may only be dropped into a container of the same kind.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  var DRAG_THRESHOLD = 4;      /* px of movement before a press becomes a drag */

  var layer = null;            /* chrome overlay holding the handle+indicator  */
  var handle = null;
  var indicator = null;

  var hovered = null;          /* block the handle is currently attached to    */
  var drag = null;             /* live drag state, or null                     */
  var installed = false;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function isPaperVisible(el) {
    var paper = el && el.closest ? el.closest('.paper') : null;
    if (!paper) return false;
    return getComputedStyle(paper).visibility !== 'hidden' &&
           !paper.classList.contains('is-turning');
  }

  /* ---------------------------------------------------------------------------
   * Overlay
   * ------------------------------------------------------------------------ */
  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    var host = $('#preview-pane');
    if (!host) return null;

    layer = document.createElement('div');
    layer.id = 'arrange-layer';
    layer.setAttribute('aria-hidden', 'false');

    handle = document.createElement('button');
    handle.type = 'button';
    handle.id = 'arrange-handle';
    handle.className = 'arrange-handle';
    handle.setAttribute('hidden', '');
    handle.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<g fill="currentColor">' +
      '<circle cx="6" cy="3" r="1.35"/><circle cx="10" cy="3" r="1.35"/>' +
      '<circle cx="6" cy="8" r="1.35"/><circle cx="10" cy="8" r="1.35"/>' +
      '<circle cx="6" cy="13" r="1.35"/><circle cx="10" cy="13" r="1.35"/>' +
      '</g></svg>';

    indicator = document.createElement('div');
    indicator.id = 'arrange-indicator';
    indicator.className = 'arrange-indicator';
    indicator.setAttribute('hidden', '');

    layer.appendChild(indicator);
    layer.appendChild(handle);
    host.appendChild(layer);

    handle.addEventListener('pointerdown', onHandleDown);
    handle.addEventListener('keydown', onHandleKey);
    handle.addEventListener('blur', function () {
      if (!drag) hideHandle();
    });
    return layer;
  }

  function layerRect() {
    return layer ? layer.getBoundingClientRect() : { left: 0, top: 0 };
  }

  function showHandleFor(block) {
    if (!ensureLayer() || !block) return;
    hovered = block;
    var r = block.getBoundingClientRect();
    var lr = layerRect();
    handle.hidden = false;
    handle.style.left = Math.round(r.left - lr.left) + 'px';
    handle.style.top = Math.round(r.top - lr.top) + 'px';
    var label = block.getAttribute('data-move-label') || 'section';
    handle.setAttribute('aria-label',
      'Move ' + label + '. Press the arrow keys, or drag.');
    handle.setAttribute('title', 'Drag to move &ldquo;' + label + '&rdquo;'
      .replace(/&ldquo;|&rdquo;/g, '"'));
  }

  function hideHandle() {
    if (!handle) return;
    handle.hidden = true;
    hovered = null;
  }

  function showIndicator(rect) {
    if (!indicator) return;
    var lr = layerRect();
    indicator.hidden = false;
    indicator.style.left = Math.round(rect.left - lr.left) + 'px';
    indicator.style.top = Math.round(rect.top - lr.top) + 'px';
    indicator.style.width = Math.round(rect.width) + 'px';
  }

  function hideIndicator() {
    if (indicator) indicator.hidden = true;
  }

  /* ---------------------------------------------------------------------------
   * Drop-slot geometry
   * ------------------------------------------------------------------------ */

  /** Every container on the visible page that accepts `kind`. */
  function containersFor(kind) {
    var out = [];
    var all = document.querySelectorAll('#page-stage [data-drop="' + kind + '"]');
    for (var i = 0; i < all.length; i++) {
      if (isPaperVisible(all[i])) out.push(all[i]);
    }
    return out;
  }

  /** Blocks of this kind that are direct members of `container`. */
  function blocksIn(container, kind) {
    var out = [];
    var all = container.querySelectorAll('[data-move="' + kind + '"]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].closest('[data-drop="' + kind + '"]') === container) {
        out.push(all[i]);
      }
    }
    return out;
  }

  /**
   * Where would a drop at (x, y) land?
   * Returns { container, index, rect } or null. `index` is the slot among the
   * container's blocks EXCLUDING the one being dragged, so it can be used
   * directly as an insertion point.
   */
  function slotAt(x, y, kind, dragged) {
    var containers = containersFor(kind);
    var best = null;
    var bestDist = Infinity;

    for (var c = 0; c < containers.length; c++) {
      var cont = containers[c];
      var cr = cont.getBoundingClientRect();
      if (!cr.width || !cr.height) continue;

      /* Distance from the pointer to this container's box; 0 when inside. */
      var dx = x < cr.left ? cr.left - x : (x > cr.right ? x - cr.right : 0);
      var dy = y < cr.top ? cr.top - y : (y > cr.bottom ? y - cr.bottom : 0);
      var dist = Math.sqrt(dx * dx + dy * dy);
      /* Only consider containers the pointer is in or very near, so a drag
       * hovering over page 1's rail doesn't silently target the article list. */
      if (dist > 90 || dist >= bestDist) continue;

      var blocks = blocksIn(cont, kind).filter(function (b) { return b !== dragged; });
      var index = blocks.length;
      var rect = null;

      /* Find the block NEAREST the pointer in two dimensions, then insert
       * before or after it depending on which half of it the pointer is in.
       *
       * Scanning top-down for the first block whose midpoint is below the
       * pointer — the obvious one-dimensional version — gives the same answer
       * in a single column, but the wrong one as soon as a container lays its
       * blocks out in more than one. The Modern template flows one
       * announcement list into two CSS columns, where the right-hand column
       * restarts at the top of the sheet: a y-only scan would resolve a drop
       * high in the RIGHT column to a slot in the left. */
      var nearest = -1;
      var nearestDist = Infinity;
      var after = false;
      for (var i = 0; i < blocks.length; i++) {
        var br = blocks[i].getBoundingClientRect();
        var bx = x < br.left ? br.left - x : (x > br.right ? x - br.right : 0);
        var by = y < br.top ? br.top - y : (y > br.bottom ? y - br.bottom : 0);
        var bd = bx * bx + by * by;          // squared: only compared, never used
        if (bd < nearestDist) {
          nearestDist = bd;
          nearest = i;
          after = y > br.top + br.height / 2;
        }
      }
      if (nearest !== -1 && !after) {
        var hit = blocks[nearest].getBoundingClientRect();
        index = nearest;
        rect = { left: hit.left, top: hit.top - 3, width: hit.width };
      } else if (nearest !== -1 && nearest < blocks.length - 1) {
        // Landing after this block means landing on the leading edge of the
        // next one, which is where the indicator has to be drawn — the two
        // are not adjacent on screen once the list is in columns.
        var next = blocks[nearest + 1].getBoundingClientRect();
        index = nearest + 1;
        rect = { left: next.left, top: next.top - 3, width: next.width };
      }

      if (!rect) {
        if (blocks.length) {
          var last = blocks[blocks.length - 1].getBoundingClientRect();
          rect = { left: last.left, top: last.bottom + 1, width: last.width };
        } else {
          /* Empty container: draw the marker just inside its top edge. */
          rect = { left: cr.left + 2, top: cr.top + 2, width: Math.max(cr.width - 4, 8) };
        }
      }

      bestDist = dist;
      best = { container: cont, index: index, rect: rect };
    }
    return best;
  }

  /* ---------------------------------------------------------------------------
   * Applying a move
   *
   * Each kind maps its (container, index) slot onto a mutation of
   * Keys.State.doc. All of them are plain array reorders — nothing is
   * positioned absolutely, which is what keeps overlap impossible.
   * ------------------------------------------------------------------------ */

  function applyArticle(block, target) {
    var State = Keys.State;
    var key = block.getAttribute('data-move-key') || '';
    var parts = key.split(':');
    var fromList = parts[0];
    var fromIndex = parseInt(parts[1], 10);
    var toList = target.container.getAttribute('data-drop-list');
    var toIndex = target.index;

    var from = State.get(fromList);
    var to = State.get(toList);
    if (!Array.isArray(from) || !Array.isArray(to)) return false;
    if (isNaN(fromIndex) || fromIndex < 0 || fromIndex >= from.length) return false;

    /* `toIndex` is a slot among the container's blocks with the dragged one
     * ALREADY EXCLUDED (see slotAt). In those coordinates the slot that
     * reproduces the current arrangement is exactly `fromIndex`, and no
     * shift correction is needed after the splice — both of which differ from
     * the inclusive-index arithmetic this looks like at a glance. */
    if (fromList === toList && toIndex === fromIndex) return false;

    var item = from.splice(fromIndex, 1)[0];
    to.splice(Math.max(0, Math.min(toIndex, to.length)), 0, item);
    return true;
  }

  function applySlip(block, target) {
    var State = Keys.State;
    var slips = State.doc.slips;
    if (!Array.isArray(slips)) return false;

    var id = block.getAttribute('data-move-key');
    var col = target.container.getAttribute('data-drop-col') === 'right'
      ? 'right' : 'left';

    var fromIndex = -1;
    for (var i = 0; i < slips.length; i++) {
      if (slips[i] && String(slips[i].id) === String(id)) { fromIndex = i; break; }
    }
    if (fromIndex === -1) return false;

    /* Which slip should end up AFTER the dragged one? Read it off the DOM,
     * which already excludes the dragged block from the slot calculation. */
    var siblings = blocksIn(target.container, 'slip')
      .filter(function (b) { return b !== block; })
      .map(function (b) { return b.getAttribute('data-move-key'); });
    var nextId = target.index < siblings.length ? siblings[target.index] : null;

    var moved = slips.splice(fromIndex, 1)[0];
    var insertAt;
    if (nextId != null) {
      insertAt = slips.length;
      for (var j = 0; j < slips.length; j++) {
        if (slips[j] && String(slips[j].id) === String(nextId)) { insertAt = j; break; }
      }
    } else {
      /* End of that column: sit just after the column's last remaining slip so
       * array order and column order stay consistent. */
      insertAt = slips.length;
      for (var k = slips.length - 1; k >= 0; k--) {
        var c = slips[k] && String(slips[k].column) === 'right' ? 'right' : 'left';
        if (c === col) { insertAt = k + 1; break; }
      }
    }

    var sameSpot = insertAt === fromIndex &&
      (String(moved.column) === col ||
        (col === 'left' && moved.column == null));
    moved.column = col;
    slips.splice(insertAt, 0, moved);
    return !sameSpot;
  }

  function applyRail(block, target) {
    var State = Keys.State;
    var order = State.doc.railOrder;
    if (!Array.isArray(order)) return false;
    var key = block.getAttribute('data-move-key');
    var from = order.indexOf(key);
    if (from === -1) return false;

    /* Exclusion-coordinate slot, exactly as in applyArticle. */
    var toIndex = target.index;
    if (toIndex === from) return false;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, key);
    return true;
  }

  var APPLY = { article: applyArticle, slip: applySlip, rail: applyRail };

  /* ---------------------------------------------------------------------------
   * The overflow guard
   *
   * A reorder cannot cause an overlap, but it CAN make a page too full — the
   * whole point of being able to drag an announcement between pages. So every
   * move is provisional until the page has been re-measured.
   * ------------------------------------------------------------------------ */

  /* How far the page-level shrink is allowed to go before a move counts as
   * making things worse. The fit engine can legally scale a page down to 0.5
   * to make anything "fit", so overflow alone is far too lenient a test: a
   * dropped block could squash a whole page to unreadable type and still
   * report success. Small accommodations are fine and expected; anything
   * below this is a layout the office manager would not accept. */
  var MIN_COMFORTABLE_SCALE = 0.8;

  /** Everything about the current fit that a move could degrade. */
  function overflowSignature() {
    var sig = { pages: {}, scales: {}, pinned: 0 };
    var papers = document.querySelectorAll('#page-stage .paper');
    for (var i = 0; i < papers.length; i++) {
      var paper = papers[i];
      var n = paper.getAttribute('data-page');
      var m = Keys.Fit && Keys.Fit.measure
        ? Keys.Fit.measure(paper) : { overflow: false };
      sig.pages[n] = !!(m && m.overflow);
      sig.scales[n] = pageScale(paper);
    }
    sig.pinned = document.querySelectorAll('#page-stage .is-overflowing').length;
    return sig;
  }

  /** Tier-2 scale: the flow's current size over its unshrunk CSS size. */
  function pageScale(paper) {
    var flow = paper.querySelector('.paper-flow');
    if (!flow) return 1;
    var natural = parseFloat(flow.getAttribute('data-fit-natural'));
    var now = parseFloat(getComputedStyle(flow).fontSize);
    if (!isFinite(natural) || !natural || !isFinite(now)) return 1;
    return now / natural;
  }

  function gotWorse(before, after) {
    for (var n in after.pages) {
      if (after.pages[n] && !before.pages[n]) return 'page ' + n;
    }
    if (after.pinned > before.pinned) return 'shrunk';
    /* Newly squashed below the legibility floor. */
    for (var p in after.scales) {
      if (after.scales[p] < MIN_COMFORTABLE_SCALE &&
          after.scales[p] < before.scales[p] - 0.005) {
        return 'shrunk';
      }
    }
    return null;
  }

  /**
   * Run `mutate`, re-render, and keep the result only if nothing overflowed.
   * Returns true when the move stuck.
   */
  function commit(mutate, describe) {
    var State = Keys.State;
    var before = overflowSignature();
    var snapshot = JSON.stringify(State.doc);

    if (!mutate()) return false;

    Keys.App.structuralChange(null);
    if (Keys.Fit) Keys.Fit.refitAll({ force: true });

    var worse = gotWorse(before, overflowSignature());
    if (worse) {
      /* Roll back. The snapshot is our own already-normalised document, so it
       * can be restored directly without another sanitise pass. */
      try {
        State.doc = JSON.parse(snapshot);
      } catch (e) { /* cannot happen: we serialised it a moment ago */ }
      Keys.App.structuralChange(null);
      if (Keys.Fit) Keys.Fit.refitAll({ force: true });
      Keys.App.toast(
        worse === 'shrunk'
          ? 'That move would not fit — the text would have to shrink too far, ' +
            'so it was put back.'
          : 'That move would not fit on ' + worse + ', so it was put back.',
        'err');
      return false;
    }

    if (describe) Keys.App.toast(describe, 'ok');
    return true;
  }

  /* ---------------------------------------------------------------------------
   * Pointer drag
   * ------------------------------------------------------------------------ */
  function onHandleDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (!hovered) return;
    e.preventDefault();

    drag = {
      block: hovered,
      kind: hovered.getAttribute('data-move'),
      label: hovered.getAttribute('data-move-label') || 'section',
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      target: null,
      pointerId: e.pointerId
    };
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    global.addEventListener('pointermove', onDragMove);
    global.addEventListener('pointerup', onDragUp);
    global.addEventListener('pointercancel', onDragUp);
  }

  /* Only one page is ever visible, so a block cannot be dragged onto a sheet
   * that is not on screen. The page thumbnails stand in for the other pages:
   * drop an announcement on "Notices" to send it there. */
  function thumbAt(x, y, kind) {
    if (kind !== 'article') return null;
    var thumbs = document.querySelectorAll('#thumb-rail .thumb');
    for (var i = 0; i < thumbs.length; i++) {
      var r = thumbs[i].getBoundingClientRect();
      if (x >= r.left - 6 && x <= r.right + 6 &&
          y >= r.top - 6 && y <= r.bottom + 6) {
        var n = Number(thumbs[i].getAttribute('data-page'));
        var list = document.querySelector(
          '#page-stage .paper[data-page="' + n + '"] [data-drop="article"]');
        if (!list) return null;
        return { thumb: thumbs[i], page: n, container: list };
      }
    }
    return null;
  }

  function clearThumbHighlight() {
    var t = document.querySelectorAll('#thumb-rail .thumb.is-drop-target');
    for (var i = 0; i < t.length; i++) t[i].classList.remove('is-drop-target');
  }

  function onDragMove(e) {
    if (!drag) return;
    if (!drag.active) {
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      drag.active = true;
      document.body.classList.add('is-arranging');
      drag.block.classList.add('is-dragging');
    }

    clearThumbHighlight();
    var onThumb = thumbAt(e.clientX, e.clientY, drag.kind);
    if (onThumb && onThumb.container !== drag.block.closest('[data-drop]')) {
      onThumb.thumb.classList.add('is-drop-target');
      drag.target = {
        container: onThumb.container,
        index: blocksIn(onThumb.container, drag.kind).length,
        rect: null,
        viaThumb: onThumb.page
      };
      hideIndicator();
    } else {
      drag.target = slotAt(e.clientX, e.clientY, drag.kind, drag.block);
      if (drag.target) showIndicator(drag.target.rect);
      else hideIndicator();
    }
    /* Keep the handle under the pointer so it reads as carrying the block. */
    var lr = layerRect();
    handle.style.left = Math.round(e.clientX - lr.left - 10) + 'px';
    handle.style.top = Math.round(e.clientY - lr.top - 10) + 'px';
  }

  function onDragUp() {
    if (!drag) return;
    var d = drag;
    drag = null;
    global.removeEventListener('pointermove', onDragMove);
    global.removeEventListener('pointerup', onDragUp);
    global.removeEventListener('pointercancel', onDragUp);
    try { handle.releasePointerCapture(d.pointerId); } catch (e) {}

    document.body.classList.remove('is-arranging');
    if (d.block) d.block.classList.remove('is-dragging');
    hideIndicator();
    clearThumbHighlight();
    hideHandle();

    if (!d.active || !d.target) return;
    var fn = APPLY[d.kind];
    if (!fn) return;
    var where = d.target.viaThumb ? ' to page ' + d.target.viaThumb : '';
    var landed = commit(function () { return fn(d.block, d.target); },
                        'Moved ' + d.label + where + '.');
    /* Follow a cross-page move so the user sees where it went. */
    if (landed && d.target.viaThumb && Keys.Flip) {
      Keys.Flip.go(d.target.viaThumb);
    }
  }

  /* ---------------------------------------------------------------------------
   * Keyboard
   *
   * The handle is a real button, so a drag is never the only way to move a
   * block. Arrows step it one slot; left/right cross columns (slips) or pages
   * (announcements).
   * ------------------------------------------------------------------------ */
  function onHandleKey(e) {
    if (!hovered) return;
    var block = hovered;
    var kind = block.getAttribute('data-move');
    var dir = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    var lateral = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (dir == null && lateral == null) return;
    e.preventDefault();

    var container = block.closest('[data-drop="' + kind + '"]');
    if (!container) return;
    var siblings = blocksIn(container, kind);
    var pos = siblings.indexOf(block);
    var label = block.getAttribute('data-move-label') || 'section';
    var target = null;

    if (dir != null) {
      var to = pos + dir;
      if (to < 0 || to >= siblings.length) return;
      /* Slot index is measured with the dragged block removed. */
      target = { container: container, index: dir < 0 ? to : to + 1, rect: null };
    } else {
      var others = containersFor(kind).filter(function (c) { return c !== container; });
      if (!others.length) return;
      var next = others[0];
      target = { container: next, index: blocksIn(next, kind).length, rect: null };
    }

    var fn = APPLY[kind];
    if (!fn) return;
    var key = block.getAttribute('data-move-key');
    var moved = commit(function () { return fn(block, target); }, 'Moved ' + label + '.');

    /* The rail was rebuilt; re-attach the handle to the block's new node so
     * the user can keep pressing arrows. */
    if (moved) {
      requestAnimationFrame(function () {
        var again = kind === 'article'
          ? findArticleByLabel(label)
          : $('#page-stage [data-move="' + kind + '"][data-move-key="' +
              (global.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
        if (again) { showHandleFor(again); handle.focus(); }
      });
    }
  }

  /** Article keys embed an index, so they change when the list is reordered;
   *  the label is the stable thing to find it by. */
  function findArticleByLabel(label) {
    var all = document.querySelectorAll('#page-stage [data-move="article"]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-move-label') === label) return all[i];
    }
    return null;
  }

  /* ---------------------------------------------------------------------------
   * Hover tracking
   * ------------------------------------------------------------------------ */
  function onStageMove(e) {
    if (drag) return;
    var block = e.target.closest ? e.target.closest('[data-move]') : null;
    if (block && !isPaperVisible(block)) block = null;
    if (block === hovered) return;
    if (block) showHandleFor(block);
    else if (e.target !== handle && !handle.contains(e.target)) hideHandle();
  }

  function onStageLeave(e) {
    if (drag) return;
    var to = e.relatedTarget;
    if (to && handle && (to === handle || handle.contains(to))) return;
    hideHandle();
  }

  /* ---------------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------------ */
  var Arrange = {
    init: function () {
      if (!ensureLayer()) return false;
      if (installed) return true;
      var stage = $('#page-stage');
      if (!stage) return false;
      stage.addEventListener('pointermove', onStageMove);
      stage.addEventListener('pointerleave', onStageLeave);
      installed = true;
      return true;
    },

    /** Called after a re-render: the old nodes are gone. */
    refresh: function () {
      if (drag) return;
      hideHandle();
      hideIndicator();
    },

    /** Exposed for tools/verify.js. */
    slotAt: slotAt,
    apply: function (block, target) {
      var fn = APPLY[block.getAttribute('data-move')];
      return fn ? fn(block, target) : false;
    },
    commit: commit,
    overflowSignature: overflowSignature,
    debugState: function () {
      return {
        installed: installed,
        dragging: !!(drag && drag.active),
        hovered: hovered ? hovered.getAttribute('data-move-key') : null,
        handleVisible: !!(handle && !handle.hidden)
      };
    }
  };

  Keys.Arrange = Arrange;
})(window);
