/* =============================================================================
 * stash.js — the "save for later" drawer.  Exposes window.Keys.Stash.
 *
 * A cabinet drawer down the right edge of the preview pane. Its handle is
 * always visible; clicking it slides the drawer out over the canvas.
 *
 * WHY THE STASH IS NOT PART OF THE DOCUMENT
 *
 * It would be the obvious place to put it, and it would be wrong. The whole
 * point of stashing a lunch slip is to use it again in a LATER issue — so the
 * drawer has to outlive the document it was filled from. Kept in `doc`, every
 * Load would overwrite the library with whatever that file happened to
 * contain, and starting next week's issue would empty it. So it lives in its
 * own localStorage key, alongside the theme and the autosaved working copy:
 * per browser, not per newsletter. (Accounts used to be in this list. They are
 * not any more — they live on the server, which is the whole point of them.)
 *
 * The trade-off is real and worth stating: e-mailing someone the .json does
 * NOT send them your saved boxes.
 *
 * ITEM SHAPE
 *
 *   { id, name, kind, savedAt, payload }
 *
 * `kind` exists so this can hold more than lunch slips later; `slip` is the
 * only kind implemented, and anything else is refused rather than half-stored.
 * Adding a kind means teaching describe(), suggestName() and restore() about
 * it — nothing else here cares.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};

  var STORAGE_KEY = 'stpeters.keys.stash.v1';
  var SCHEMA_VERSION = 1;

  /* A drawer, not an archive. Past this it stops being browsable, and
   * localStorage is a shared 5MB budget that the newsletter also lives in. */
  var MAX_ITEMS = 60;
  var MAX_NAME = 60;

  var KINDS = { slip: 1 };

  var openState = false;

  /* -------------------------------------------------------------------------
   * Helpers
   * ---------------------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }

  function escText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escText(s).replace(/"/g, '&quot;'); }

  function uid() {
    return 'st-' + Date.now().toString(36) + '-' +
      Math.floor(Math.random() * 1e6).toString(36);
  }

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
  }

  /** The FIRST LINE of a rich-text value, as plain text.
   *
   *  Slip headings are several lines — "THIS THURSDAY, 5/28<br>FOR LUNCH<br>
   *  HOTDOG..." — and textContent alone runs them together into
   *  "THIS THURSDAY, 5/28FOR LUNCHHOTDOG", which is unreadable and far too
   *  long for a drawer label. Line breaks become real breaks first, then only
   *  the first line is kept: that is the part the author actually calls it. */
  function firstLine(htmlValue) {
    var markup = String(htmlValue == null ? '' : htmlValue)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, '\n');
    // A <template> is inert, so nothing in a stored value can load or run.
    var tpl = document.createElement('template');
    tpl.innerHTML = markup;
    var text = tpl.content.textContent || '';
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+/g, ' ').trim();
      if (line) return line;
    }
    return '';
  }

  function cleanName(name, fallback) {
    if (Keys.App && Keys.App.cleanLabel) {
      return Keys.App.cleanLabel(name, fallback);
    }
    var s = String(name == null ? '' : name)
      .replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
    return s || fallback;
  }

  /* -------------------------------------------------------------------------
   * Store
   * ---------------------------------------------------------------------- */
  function read() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return null;                    // null means "never set up"

    var data;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { version: SCHEMA_VERSION, seeded: true, items: [] };
    }

    /* Anything unusable is dropped rather than trusted. A drawer that throws
     * on open would take the preview pane down with it. */
    var items = (Array.isArray(data.items) ? data.items : [])
      .filter(function (it) {
        return it && typeof it === 'object' && !Array.isArray(it) &&
          KINDS[it.kind] === 1 && it.payload &&
          typeof it.payload === 'object' && !Array.isArray(it.payload);
      })
      .slice(0, MAX_ITEMS)
      .map(function (it) {
        return {
          id: String(it.id || uid()),
          name: cleanName(it.name, 'Saved item'),
          kind: it.kind,
          savedAt: typeof it.savedAt === 'string' ? it.savedAt : null,
          payload: it.payload
        };
      });

    return { version: SCHEMA_VERSION, seeded: data.seeded !== false, items: items };
  }

  function write(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return true;
    } catch (e) {
      return false;                            // quota, or storage disabled
    }
  }

  /** The store, seeding the drawer on the very first run.
   *
   *  Seeding uses whatever is on the slips page at that moment, which on a
   *  fresh install is the seeded issue — so the drawer opens with something in
   *  it and the feature explains itself. `seeded` is recorded so emptying the
   *  drawer does not refill it behind the user's back. */
  function store() {
    var s = read();
    if (s) return s;

    var fresh = { version: SCHEMA_VERSION, seeded: true, items: [] };
    var slips = (Keys.State && Array.isArray(Keys.State.doc.slips))
      ? Keys.State.doc.slips : [];
    slips.forEach(function (slip) {
      var payload = clone(slip);
      if (!payload) return;
      fresh.items.push({
        id: uid(),
        name: suggestName(slip),
        kind: 'slip',
        savedAt: null,                         // seeded, not saved by anyone
        payload: payload
      });
    });
    write(fresh);
    return fresh;
  }

  /* -------------------------------------------------------------------------
   * Describing an item
   * ---------------------------------------------------------------------- */
  function slipTypeMeta(type) {
    var types = Keys.Slips && Keys.Slips.TYPES;
    return (types && types[type]) || { label: 'Box', icon: '▭' };
  }

  /** The name to offer when stashing. The heading if there is one, because
   *  that is what the author already thinks of the box as. */
  function suggestName(slip) {
    var heading = firstLine(slip && (slip.heading || slip.text || slip.title));
    var meta = slipTypeMeta(slip && slip.type);
    // Long enough to be distinctive, short enough to read in a 288px drawer.
    if (heading.length > 42) heading = heading.slice(0, 41).trim() + '…';
    return cleanName(heading || meta.label, 'Saved box');
  }

  function describe(item) {
    if (item.kind === 'slip') {
      var meta = slipTypeMeta(item.payload && item.payload.type);
      return { icon: meta.icon, label: meta.label };
    }
    return { icon: '▭', label: 'Item' };
  }

  function when(item) {
    if (!item.savedAt) return 'from the starting issue';
    var d = new Date(item.savedAt);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /* -------------------------------------------------------------------------
   * Public model
   * ---------------------------------------------------------------------- */
  var Stash = {
    STORAGE_KEY: STORAGE_KEY,
    MAX_ITEMS: MAX_ITEMS,

    items: function () {
      return store().items.map(function (it) {
        return { id: it.id, name: it.name, kind: it.kind, savedAt: it.savedAt };
      });
    },

    count: function () { return store().items.length; },

    /** Stash a copy of `payload` under `name`. Returns {item} or {error}. */
    add: function (name, kind, payload) {
      if (KINDS[kind] !== 1) {
        return { error: 'Only lunch-slip boxes can be saved for later.' };
      }
      var copy = clone(payload);
      if (!copy || typeof copy !== 'object') {
        return { error: 'That item could not be copied.' };
      }
      var s = store();
      if (s.items.length >= MAX_ITEMS) {
        return { error: 'The drawer is full (' + MAX_ITEMS + ' items). ' +
          'Remove something first.' };
      }
      var item = {
        id: uid(),
        name: cleanName(name, 'Saved box'),
        kind: kind,
        savedAt: new Date().toISOString(),
        payload: copy
      };
      // Newest first: the thing just stashed is the thing most likely wanted.
      s.items.unshift(item);
      if (!write(s)) {
        return { error: 'This browser will not let the app save the drawer.' };
      }
      render();
      return { item: { id: item.id, name: item.name, kind: item.kind } };
    },

    remove: function (id) {
      var s = store();
      var before = s.items.length;
      s.items = s.items.filter(function (it) { return it.id !== id; });
      if (s.items.length === before) return false;
      write(s);
      render();
      return true;
    },

    rename: function (id, name) {
      var s = store();
      var item = null;
      s.items.forEach(function (it) { if (it.id === id) item = it; });
      if (!item) return false;
      item.name = cleanName(name, item.name);
      write(s);
      render();
      return true;
    },

    /** Put a copy back on the page. The stashed copy stays in the drawer —
     *  it is a library, not an outbox, so restoring twice gives two boxes. */
    restore: function (id) {
      var s = store();
      var item = null;
      s.items.forEach(function (it) { if (it.id === id) item = it; });
      if (!item) return { error: 'That item is no longer in the drawer.' };
      if (item.kind !== 'slip') {
        return { error: 'That item cannot be added to this page.' };
      }
      if (!Keys.State || !Keys.App) return { error: 'The app is not ready.' };

      var copy = clone(item.payload);
      if (!copy) return { error: 'That item could not be copied.' };
      /* A fresh id, always: the stashed one may still be on the page, and two
       * boxes sharing an id makes every delete and reorder ambiguous. */
      copy.id = Keys.State.uid('slip');

      Keys.App.structuralChange(function () {
        if (!Array.isArray(Keys.State.doc.slips)) Keys.State.doc.slips = [];
        Keys.State.doc.slips.push(copy);
      });

      var ordinal = Keys.Render && Keys.Render.ordinalOf
        ? Keys.Render.ordinalOf('slips') : 0;
      if (ordinal && Keys.Flip) Keys.Flip.go(ordinal);

      return { restored: { id: copy.id, name: item.name } };
    },

    /** Clear everything, and do not re-seed on the next read. */
    clear: function () {
      write({ version: SCHEMA_VERSION, seeded: true, items: [] });
      render();
      return true;
    },

    suggestName: suggestName,

    /* --- drawer ---------------------------------------------------------- */
    isOpen: function () { return openState; },
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!openState); },

    render: function () { render(); },

    /** Stash the slip with this id, asking for a name first. Shared by the
     *  editor button and the drag-to-drawer gesture, so both behave alike. */
    stashSlip: function (slipId) {
      var slips = (Keys.State && Keys.State.doc.slips) || [];
      var slip = null;
      slips.forEach(function (s) { if (s && s.id === slipId) slip = s; });
      if (!slip) {
        toast('That box is no longer on the page.', 'err');
        return Promise.resolve(null);
      }

      var meta = slipTypeMeta(slip.type);
      return Keys.App.askName({
        title: 'Save for later',
        note: 'Keeps a copy of this ' + meta.label.toLowerCase() +
              ' in the drawer, ready to drop into a future issue. ' +
              'The box stays on the page.',
        label: 'Name it',
        okLabel: 'Save to drawer',
        ext: '',
        suggestion: suggestName(slip),
        fallback: 'Saved box',
        clean: cleanName
      }).then(function (name) {
        if (name == null) return null;          // cancelled
        var res = Stash.add(name, 'slip', slip);
        if (res.error) { toast(res.error, 'err'); return null; }
        setOpen(true);
        flashItem(res.item.id);
        toast('Saved “' + res.item.name + '” for later.', 'ok');
        return res.item;
      });
    }
  };

  /* -------------------------------------------------------------------------
   * Drawer UI
   * ---------------------------------------------------------------------- */
  function toast(msg, kind) {
    if (Keys.App && Keys.App.toast) Keys.App.toast(msg, kind);
  }

  function setOpen(next) {
    var el = $('#stash');
    if (!el) return;
    openState = !!next;
    el.classList.toggle('is-open', openState);
    var handle = $('#stash-handle');
    if (handle) handle.setAttribute('aria-expanded', openState ? 'true' : 'false');
    /* Closed, the panel is off-screen but still in the layout — without this
     * its buttons stay in the tab order and focus disappears off the edge. */
    var panel = $('#stash-panel');
    if (panel) {
      if (openState) panel.removeAttribute('inert');
      else panel.setAttribute('inert', '');
    }
  }

  function flashItem(id) {
    var el = $('#stash-list [data-id="' + (global.CSS && CSS.escape
      ? CSS.escape(id) : id) + '"]');
    if (!el) return;
    el.classList.remove('is-new');
    void el.offsetWidth;                       // restart the animation
    el.classList.add('is-new');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    setTimeout(function () { el.classList.remove('is-new'); }, 1400);
  }

  function render() {
    var list = $('#stash-list');
    if (!list) return;
    var s = store();

    list.innerHTML = s.items.map(function (it) {
      var d = describe(it);
      var stamp = when(it);
      return '<li class="stash-item" data-id="' + escAttr(it.id) + '">' +
        '<span class="stash-item-icon" aria-hidden="true">' +
          escText(d.icon) + '</span>' +
        '<span class="stash-item-main">' +
          '<span class="stash-item-name">' + escText(it.name) + '</span>' +
          '<span class="stash-item-meta">' + escText(d.label) +
            (stamp ? ' &middot; ' + escText(stamp) : '') + '</span>' +
        '</span>' +
        '<span class="stash-item-tools">' +
          '<button type="button" class="stash-btn stash-btn--go"' +
            ' data-stash="restore" data-id="' + escAttr(it.id) + '"' +
            ' title="Add a copy to the lunch slips page">Add</button>' +
          '<button type="button" class="stash-btn stash-btn--icon"' +
            ' data-stash="rename" data-id="' + escAttr(it.id) + '"' +
            ' title="Rename" aria-label="Rename ' + escAttr(it.name) +
            '">&#9998;</button>' +
          '<button type="button" class="stash-btn stash-btn--icon stash-btn--danger"' +
            ' data-stash="remove" data-id="' + escAttr(it.id) + '"' +
            ' title="Remove from the drawer" aria-label="Remove ' +
            escAttr(it.name) + '">&#10005;</button>' +
        '</span>' +
      '</li>';
    }).join('');

    var empty = $('#stash-empty');
    if (empty) empty.hidden = s.items.length > 0;

    var count = $('#stash-count');
    if (count) {
      count.textContent = s.items.length;
      count.hidden = s.items.length === 0;
    }

    var handle = $('#stash-handle');
    if (handle) {
      handle.setAttribute('title', s.items.length
        ? 'Saved for later — ' + s.items.length + ' item' +
          (s.items.length === 1 ? '' : 's')
        : 'Saved for later — the drawer is empty');
    }
  }

  function onClick(e) {
    var t = e.target;
    if (!t.closest) return;

    if (t.closest('#stash-handle')) { Stash.toggle(); return; }

    var btn = t.closest('[data-stash]');
    if (!btn) return;
    var act = btn.getAttribute('data-stash');
    var id = btn.getAttribute('data-id');

    if (act === 'close') { Stash.close(); return; }

    if (act === 'restore') {
      var res = Stash.restore(id);
      if (res.error) { toast(res.error, 'err'); return; }
      toast('Added “' + res.restored.name + '” to the lunch slips page.', 'ok');
      return;
    }

    if (act === 'rename') {
      var current = null;
      Stash.items().forEach(function (it) { if (it.id === id) current = it; });
      if (!current) return;
      Keys.App.askName({
        title: 'Rename saved item',
        note: '',
        label: 'Name',
        okLabel: 'Rename',
        ext: '',
        suggestion: current.name,
        fallback: current.name,
        clean: cleanName
      }).then(function (name) {
        if (name == null) return;
        Stash.rename(id, name);
        flashItem(id);
      });
      return;
    }

    if (act === 'remove') {
      var item = null;
      Stash.items().forEach(function (it) { if (it.id === id) item = it; });
      if (!item) return;
      if (!global.confirm('Remove “' + item.name + '” from the drawer?\n\n' +
          'This does not change the newsletter.')) return;
      Stash.remove(id);
      toast('Removed “' + item.name + '” from the drawer.', 'ok');
      return;
    }
  }

  function init() {
    var el = $('#stash');
    if (!el) return;
    setOpen(false);
    render();
    document.addEventListener('click', onClick);

    // Escape closes the drawer, like every other transient surface here.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openState && !$('#name-dialog').open) {
        Stash.close();
      }
    });
  }

  Stash.init = init;
  Keys.Stash = Stash;
})(window);
