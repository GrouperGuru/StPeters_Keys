/* =============================================================================
 * app.js — Bootstrap and event wiring.
 *
 * Exposes window.Keys.App. Owns:
 *   - boot sequence (restore -> render -> init flip/fit -> wire)
 *   - the editor <-> preview binding loop
 *   - toolbar actions, rich-text formatting, keyboard shortcuts
 *   - structural changes (add/remove rows, slips, calendar month)
 *   - save / load / print
 *   - rail resizing, accordions, thumbnails, toasts
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};
  var State = Keys.State;

  /* The issue is Front + N announcement pages + Slips + Calendar, so the page
   * count is derived from the document, never assumed. Keys.Render.pages() is
   * the single source of truth; everything here reads it. */
  function pageList() {
    return (Keys.Render && Keys.Render.pages) ? Keys.Render.pages() : [];
  }
  function totalPages() {
    var n = pageList().length;
    return n || 1;
  }

  /* Selection tracking so the toolbar can format the last-focused field even
   * after focus moves to a toolbar <select>. */
  var lastEditable = null;
  var lastRange = null;

  var autosaveTimer = null;
  var booted = false;

  /* -------------------------------------------------------------------------
   * Small helpers
   * ---------------------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function toast(msg, kind) {
    var host = $('#toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-leaving');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
    }, 3200);
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () { State.autosave(); }, 700);
  }

  /** Post-pass over the rebuilt rail:
   *   - tag genuinely-empty fields so the CSS placeholder shows even in
   *     browsers that leave a stray <br> in an emptied contenteditable;
   *   - guarantee every single-line field carries `.rt--single`. Enter
   *     suppression keys off `data-single`, but the compact single-line
   *     styling keys off the class, and two of the module-supplied builders
   *     emit only `rt`. Normalising here keeps the two in step wherever the
   *     markup came from. */
  function markEmpties() {
    $$('#editor-scroll .rt').forEach(function (el) {
      el.classList.toggle('is-empty', el.textContent.trim() === '');
      if (el.getAttribute('data-single') === 'true') {
        el.classList.add('rt--single');
      }
    });
  }

  /* -------------------------------------------------------------------------
   * Binding loop
   * ---------------------------------------------------------------------- */

  /** Push an editor field's value into state + preview, then refit. */
  function commitField(el) {
    var path = el.getAttribute('data-path');
    if (!path) return;
    var value = el.innerHTML;

    // Firefox leaves a stray <br> behind in an emptied contenteditable, which
    // defeats the :empty placeholder rule. Mirror true emptiness in a class.
    el.classList.toggle('is-empty', el.textContent.trim() === '');

    State.set(path, value);
    var nodes = Keys.Render.push(path, value);
    for (var i = 0; i < nodes.length; i++) {
      if (Keys.Fit) Keys.Fit.refitFor(nodes[i]);
    }
    scheduleAutosave();
  }

  /* -------------------------------------------------------------------------
   * Click-to-edit: clicking a region on the paper jumps to the field that
   * feeds it. The exact inverse of the focus -> preview link below.
   * ---------------------------------------------------------------------- */

  /* Blocks that should be clickable in their entirety, not just where their
   * text happens to sit. A calendar day is mostly empty space under a short
   * event line, and a slip has generous padding — requiring a hit on the glyphs
   * themselves would make the feature feel broken. */
  /* `closest()` returns the NEAREST ancestor matching any of these, and
   * bindTargetFromClick then widens outwards only if that one holds no bound
   * region. So listing both an inner and an outer block is deliberate and
   * order-independent: a click on a Modern agenda entry lands on `.nl-m-line`
   * (that exact entry), and a click on the blank space beside it falls out to
   * `.nl-m-block` and then the column, picking the nearest region in each. */
  var CLICK_BLOCKS = '.cal-cell, .slip, .nl-article, .nl-box, .nl-agenda tr,' +
    ' .nl-m-line, .nl-m-block, .nl-m-aside, .nl-m-main, .nl-m-foot,' +
    ' .nl-rail, .nl-top-main, .cal-titlebox, .paper-flow';

  /* Two kinds of click target:
   *   [data-bind]  — a bound output; clicking it edits the value it displays.
   *   [data-edits] — a DERIVED region that displays no single stored value, so
   *                  it names the field to jump to instead. The calendar's
   *                  "JUNE 2026" title is computed from the month and year
   *                  dropdowns, so it points at `calendar.month`. */
  var EDIT_SEL = '[data-bind], [data-edits]';

  /** The path a preview node should send you to. `data-edits` wins so a bound
   *  output can still redirect elsewhere if it ever needs to. */
  function editPathOf(node) {
    if (!node || !node.getAttribute) return null;
    return node.getAttribute('data-edits') ||
           node.getAttribute('data-bind') || null;
  }

  /** Resolve a click inside the paper to the preview node it should edit. */
  function bindTargetFromClick(target, clientY) {
    if (!target || !target.closest) return null;

    // Direct hit wins.
    var direct = target.closest(EDIT_SEL);
    if (direct) return direct;

    // Otherwise fall back to the enclosing block and pick the bound region
    // vertically nearest the pointer, so clicking the blank lower half of a
    // calendar cell still lands on that day's events.
    var block = target.closest(CLICK_BLOCKS);
    while (block) {
      var cands = block.querySelectorAll(EDIT_SEL);
      if (cands.length) {
        var best = null;
        var bestDist = Infinity;
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect();
          if (!r.height && !r.width) continue;
          var dist = clientY < r.top ? r.top - clientY
            : (clientY > r.bottom ? clientY - r.bottom : 0);
          if (dist < bestDist) { bestDist = dist; best = cands[i]; }
        }
        if (best) return best;
      }
      block = block.parentElement && block.parentElement.closest
        ? block.parentElement.closest(CLICK_BLOCKS) : null;
    }
    return null;
  }

  function onPreviewClick(e) {
    // Don't hijack a drag-selection: the user may be copying text off the page.
    var sel = global.getSelection && global.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;

    var node = bindTargetFromClick(e.target, e.clientY);
    if (!node) return;
    var path = editPathOf(node);
    if (!path) return;

    var field = Keys.Editor.focusPath(path);
    if (!field) {
      // Every [data-bind]/[data-edits] should have a matching [data-path]; if
      // one ever doesn't, say so rather than silently doing nothing.
      toast('That part of the page is not editable.', 'err');
    }
  }

  /** Highlight the preview regions bound to `path`. */
  function highlight(path, on) {
    var nodes = Keys.Render.nodesFor(path);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('is-target', !!on);
    }
  }

  /* -------------------------------------------------------------------------
   * Structural changes
   *
   * Anything that changes the SHAPE of the document (row/slip/article count,
   * calendar month) rebuilds both panes. Typing never does this, so the caret
   * is never disturbed by it.
   * ---------------------------------------------------------------------- */
  function structuralChange(mutate) {
    var focusPath = null;
    var active = document.activeElement;
    if (active && active.getAttribute) focusPath = active.getAttribute('data-path');

    if (typeof mutate === 'function') mutate();

    // Both panes are about to be discarded — invalidate the cached selection
    // before any DOM is replaced.
    forgetSelection();

    Keys.Editor.all();
    Keys.Render.all();
    markEmpties();
    if (Keys.Flip) Keys.Flip.relayout();
    // Re-observe: Render.all() replaced every .paper node, so the previous
    // ResizeObserver targets are detached. init() is idempotent and re-binds.
    if (Keys.Fit) { Keys.Fit.init(); Keys.Fit.refitAll(); }
    // The blocks the drag handle was attached to have just been replaced.
    if (Keys.Arrange) Keys.Arrange.refresh();
    buildThumbs();
    // A loaded file can carry a different template than the one on screen.
    syncTemplateSelect();

    if (focusPath) {
      var el = $('#editor-scroll [data-path="' +
        (global.CSS && CSS.escape ? CSS.escape(focusPath) : focusPath) + '"]');
      if (el) {
        el.focus();
        if (el.setSelectionRange && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
          try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
        }
      }
    }
    State.dirty = true;
    scheduleAutosave();
  }

  /* -------------------------------------------------------------------------
   * Generic list mutations (This Week rows, Looking Ahead rows, articles)
   * ---------------------------------------------------------------------- */
  function blankListItem(kind) {
    if (kind === 'article') return { title: 'NEW SECTION', body: '<p>Write the announcement here…</p>' };
    return { date: '', event: '' };
  }

  function listAction(act, listPath, index, kind) {
    var list = State.get(listPath);
    if (!Array.isArray(list)) return;
    index = Number(index);

    if (act === 'list-add') {
      list.push(blankListItem(kind));
    } else if (act === 'list-del') {
      if (index < 0 || index >= list.length) return;
      list.splice(index, 1);
    } else if (act === 'list-up') {
      if (index <= 0) return;
      list.splice(index - 1, 0, list.splice(index, 1)[0]);
    } else if (act === 'list-down') {
      if (index >= list.length - 1) return;
      list.splice(index + 1, 0, list.splice(index, 1)[0]);
    }
  }

  /* -------------------------------------------------------------------------
   * Slip mutations — delegated to Keys.Slips per docs/SPEC.md §7
   * ---------------------------------------------------------------------- */
  function slipAction(act, btn) {
    var Slips = Keys.Slips;
    if (!Slips) return false;
    var slips = State.doc.slips;
    if (!Array.isArray(slips)) slips = State.doc.slips = [];

    var id = btn.getAttribute('data-id');
    var idx = btn.getAttribute('data-index');

    /* Return what the mutation ACTUALLY did. Reporting success unconditionally
     * meant the UI re-rendered and looked like it had acted even when nothing
     * changed — most damagingly, a user could confirm "Delete this box and
     * everything in it?" and have the box silently survive. */
    var changed;
    switch (act) {
      case 'slip-add':
        changed = Slips.add(slips, btn.getAttribute('data-type') || 'lunch',
                            btn.getAttribute('data-value') || 'left');
        break;
      case 'slip-del':
        if (!global.confirm('Delete this box and everything in it?')) return false;
        changed = Slips.remove(slips, id);
        if (!changed) toast('Could not delete that box.', 'err');
        break;
      case 'slip-up':   changed = Slips.move(slips, id, -1); break;
      case 'slip-down': changed = Slips.move(slips, id, 1);  break;
      case 'slip-dup':  changed = Slips.duplicate(slips, id); break;
      case 'slip-col':
        changed = Slips.setColumn(slips, id, btn.getAttribute('data-value'));
        break;
      case 'field-add': changed = Slips.addField(slips, id); break;
      case 'field-del': changed = Slips.removeField(slips, id, Number(idx)); break;
      /* After School Sign Up */
      case 'term-add':    changed = Slips.addTerm(slips, id); break;
      case 'term-del':    changed = Slips.removeTerm(slips, id, Number(idx)); break;
      case 'student-add': changed = Slips.addStudent(slips, id); break;
      case 'student-del': changed = Slips.removeStudent(slips, id); break;
      default: return false;
    }
    return changed !== false;
  }

  /* -------------------------------------------------------------------------
   * Rich-text formatting
   * ---------------------------------------------------------------------- */
  function rememberSelection() {
    var sel = global.getSelection && global.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var node = sel.anchorNode;
    if (!node) return;
    var host = (node.nodeType === 1 ? node : node.parentNode);
    host = host && host.closest ? host.closest('.rt') : null;
    if (host) {
      lastEditable = host;
      lastRange = sel.getRangeAt(0).cloneRange();
      syncFormatButtons();
    }
  }

  /** Drop the cached selection. MUST be called whenever the editor rail is
   *  rebuilt: `lastEditable` would otherwise point at a detached node whose
   *  `data-path` no longer describes where its text belongs. Formatting after
   *  a delete then wrote the removed item's HTML back to the path now occupied
   *  by a different item — corrupting it in state, in the preview and in the
   *  autosave, while the rail still showed the correct text. */
  function forgetSelection() {
    lastEditable = null;
    lastRange = null;
  }

  function restoreSelection() {
    // A node detached by a re-render is unusable even though the reference
    // survives, so verify it is still in the live document.
    if (!lastEditable || !document.contains(lastEditable)) {
      forgetSelection();
      return false;
    }
    lastEditable.focus();
    if (lastRange) {
      var sel = global.getSelection();
      try {
        sel.removeAllRanges();
        sel.addRange(lastRange);
      } catch (e) {
        // Range no longer maps into the document; fall back to a plain focus
        // so the command applies at the caret rather than to stale content.
        lastRange = null;
      }
    }
    return true;
  }

  /* execCommand('fontSize') emits <font size="1..7">, which the browser maps to
   * an ABSOLUTE px size. Both shrink-to-fit tiers work by scaling a base
   * font-size and relying on descendants being sized in `em`, so an absolute
   * size is immune to them: the page-level pass would drive itself to its floor
   * and the oversized text still got clipped — losing whole paragraphs from the
   * printed page. Re-expressing the size as `em` keeps it inside the cascade,
   * so it scales with everything else and can always be made to fit. */
  var FONT_SIZE_EM = {
    '1': 0.65, '2': 0.8, '3': 1, '4': 1.2, '5': 1.5, '6': 1.85, '7': 2.3
  };

  function emitEmFontSizes(root) {
    if (!root) return;
    var fonts = root.querySelectorAll('font[size]');
    for (var i = 0; i < fonts.length; i++) {
      var f = fonts[i];
      var em = FONT_SIZE_EM[String(f.getAttribute('size')).trim()];
      var span = document.createElement('span');
      if (em && em !== 1) span.style.fontSize = em + 'em';
      // Carry over anything else execCommand put on the <font>.
      if (f.getAttribute('face')) span.style.fontFamily = f.getAttribute('face');
      if (f.getAttribute('color')) span.style.color = f.getAttribute('color');
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
    }
  }

  /* Commands that introduce block structure. On a single-line field (the
   * masthead title, a slip option label) they replace the text with a list
   * item or a heading, which collapses the layout and, for pipe-delimited
   * inline labels, produces unbalanced fragments. */
  var BLOCK_CMDS = {
    insertUnorderedList: 1, insertOrderedList: 1, formatBlock: 1,
    indent: 1, outdent: 1
  };

  function applyFormat(cmd, value) {
    if (!restoreSelection()) {
      toast('Click into a text box first, then apply formatting.', 'err');
      return;
    }
    if (BLOCK_CMDS[cmd] && lastEditable.getAttribute('data-single') === 'true') {
      toast('Lists and indents cannot be used in a single-line field.', 'err');
      return;
    }
    try {
      document.execCommand('styleWithCSS', false, false);
    } catch (e) {}
    try {
      document.execCommand(cmd, false, value == null ? null : value);
    } catch (e) {
      toast('That formatting is not supported here.', 'err');
      return;
    }
    if (cmd === 'fontSize' || cmd === 'fontName') emitEmFontSizes(lastEditable);
    // Selection has changed shape; recapture it before committing.
    var sel = global.getSelection();
    if (sel && sel.rangeCount) lastRange = sel.getRangeAt(0).cloneRange();
    commitField(lastEditable);
    syncFormatButtons();
  }

  var STATEFUL_CMDS = ['bold', 'italic', 'underline', 'justifyLeft',
    'justifyCenter', 'justifyRight', 'justifyFull', 'insertUnorderedList'];

  function syncFormatButtons() {
    $$('#format-group .tb-btn[data-fmt]').forEach(function (btn) {
      var cmd = btn.getAttribute('data-fmt');
      if (STATEFUL_CMDS.indexOf(cmd) === -1) return;
      var on = false;
      try { on = document.queryCommandState(cmd); } catch (e) {}
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /* -------------------------------------------------------------------------
   * Templates
   *
   * The template changes only how the front and announcement sheets are laid
   * out — same document, same slips, same calendar. Switching is therefore a
   * plain structural re-render: no content is copied, converted or discarded,
   * which is what makes it safe to flip back and forth while deciding.
   * ---------------------------------------------------------------------- */

  /** Fill the toolbar dropdown from State.templates() and select the active
   *  one. Called on boot and after every structural change, because loading a
   *  file can bring a different template with it. */
  function syncTemplateSelect() {
    var sel = $('#template-select');
    if (!sel) return;
    var list = State.templates();
    var active = State.template();

    // Rebuild only when the option set is actually missing/stale — replacing
    // the <option>s on every keystroke-driven re-render would close the
    // dropdown while the user is in it.
    if (sel.options.length !== list.length) {
      sel.innerHTML = list.map(function (t) {
        return '<option value="' + Keys.Render.escAttr(t.id) + '">' +
          String(t.name).replace(/&/g, '&amp;').replace(/</g, '&lt;') +
          '</option>';
      }).join('');
    }
    if (sel.value !== active) sel.value = active;

    var current = null;
    list.forEach(function (t) { if (t.id === active) current = t; });
    var label = 'Page template: ' + (current ? current.name : active) +
      (current && current.note ? ' — ' + current.note : '');
    sel.setAttribute('title', label);
    sel.setAttribute('aria-label', label);
  }

  function chooseTemplate(id) {
    if (id === State.template()) return;

    var applied;
    structuralChange(function () { applied = State.setTemplate(id); });
    syncTemplateSelect();
    State.dirty = true;
    scheduleAutosave();

    if (applied !== id) {
      // setTemplate rejected it, so the select is now out of step with the
      // document; syncTemplateSelect above has already put it back.
      toast('That template is not available.', 'err');
      return;
    }
    var name = applied;
    State.templates().forEach(function (t) { if (t.id === applied) name = t.name; });
    toast(name + ' template applied to the front and announcement pages.', 'ok');
  }

  /* -------------------------------------------------------------------------
   * File names
   *
   * Both Save and PDF export ask for a name first, suggesting one built from
   * the issue date on page 1: "May 26, 2026" -> "SP_Keys-May26_2026".
   * ---------------------------------------------------------------------- */

  /** The page-1 date as a filename fragment. The field is rich text the user
   *  types freely, so this reads what is actually there rather than assuming
   *  a format, and degrades in steps instead of failing. */
  function issueDateSlug() {
    var raw = String(State.doc.masthead && State.doc.masthead.date || '');
    /* Parse rather than regex the tags off, so entities (&mdash;, &nbsp;)
     * become characters instead of surviving as literal "&mdash;". A <template>
     * rather than a <div>: its contents are inert, so nothing in the field can
     * fetch a resource just from being read. Same approach as
     * State.sanitizeHTML. */
    var tpl = document.createElement('template');
    tpl.innerHTML = raw;
    var text = (tpl.content.textContent || '').replace(/\s+/g, ' ').trim();

    /* Preferred shape: a month name, a day and a four-digit year, wherever
     * they sit in the line. Also matches "Week of May 26, 2026" and a range
     * like "May 26-30, 2026" (which takes the first day). */
    var m = text.match(
      /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*[-–—]\s*\d{1,2})?(?:st|nd|rd|th)?\s*,?\s*(\d{4})/);
    if (m) return m[1] + m[2] + '_' + m[3];

    // Anything else: use the line as written, punctuation folded to "_".
    var slug = text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (slug) return slug.slice(0, 60);

    // Empty date field: today, so the name is still unique and sortable.
    var now = new Date();
    return now.getFullYear() + '-' +
      ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
      ('0' + now.getDate()).slice(-2);
  }

  function suggestedName() { return 'SP_Keys-' + issueDateSlug(); }

  /** Make anything the user typed safe to hand to a download or a print
   *  dialog. Path separators and the Windows-reserved set would otherwise
   *  produce a silently renamed — or nested — file. */
  function cleanFilename(name, fallback) {
    var s = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f\u007f]/g, '')   // control characters
      .replace(/[\/\\:*?"<>|]/g, '-')          // path + Windows-reserved
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')         // no leading dot: not a hidden file
      .slice(0, 120)
      .trim();
    return s || fallback;
  }

  /** Ask for a file name.
   *
   *  Resolves with the cleaned name, or null if the user cancelled — callers
   *  must treat null as "do nothing", not as "use the default".
   *
   *  opts: { title, note, ext, okLabel, suggestion } */
  var nameDialogDone = null;

  function askFilename(opts) {
    var suggestion = cleanFilename(opts.suggestion, 'newsletter');
    var ext = opts.ext || '';

    return new Promise(function (resolve) {
      var dlg = $('#name-dialog');

      // No <dialog> support: fall back to the platform prompt. Here the
      // suggestion has to be the value, since there is no placeholder.
      if (!dlg || typeof dlg.showModal !== 'function') {
        var typed = global.prompt(opts.title + ' — file name', suggestion);
        resolve(typed === null ? null : cleanFilename(typed, suggestion));
        return;
      }

      // A second request while one is open would strand the first promise.
      if (dlg.open) { resolve(null); return; }

      /* The `close` event is queued, not synchronous, so a request made in the
       * gap after close() would overwrite the pending settler and hand the
       * previous caller this dialog's answer. Settle the old one first. */
      if (nameDialogDone) nameDialogDone(null);

      var input = $('#name-dialog-input');
      $('#name-dialog-title').textContent = opts.title;
      $('#name-dialog-note').textContent = opts.note || '';
      $('#name-dialog-ext').textContent = ext;
      $('#name-dialog-ok').textContent = opts.okLabel || 'Save';
      input.value = '';                     // empty: the suggestion is the
      input.placeholder = suggestion;       // placeholder, so Enter accepts it

      /* One resolve, whichever way the dialog closes — submit, Cancel, Esc or
       * a click on the backdrop. `close` always fires last, so it is the
       * settle point; the others just record the answer. */
      nameDialogDone = function (value) {
        nameDialogDone = null;
        resolve(value);
      };
      dlg.returnValue = '';
      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  function wireNameDialog() {
    var dlg = $('#name-dialog');
    if (!dlg || typeof dlg.showModal !== 'function') return;
    var input = $('#name-dialog-input');
    var form = $('#name-dialog-form');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      // Blank means "accept the suggestion", which is the placeholder.
      dlg.returnValue = cleanFilename(input.value, input.placeholder);
      dlg.close();
    });

    dlg.addEventListener('click', function (e) {
      if (e.target.getAttribute &&
          e.target.getAttribute('data-dlg') === 'cancel') {
        dlg.returnValue = '';
        dlg.close();
        return;
      }
      // Clicks land on the <dialog> itself only when they hit the backdrop.
      if (e.target === dlg) { dlg.returnValue = ''; dlg.close(); }
    });

    // Esc closes without firing submit, leaving returnValue as we set it.
    dlg.addEventListener('close', function () {
      var done = nameDialogDone;
      if (!done) return;
      done(dlg.returnValue ? dlg.returnValue : null);
    });
  }

  /* -------------------------------------------------------------------------
   * Save / load / print
   * ---------------------------------------------------------------------- */
  function saveFile() {
    askFilename({
      title: 'Save newsletter',
      note: 'Saved to your downloads as a .json file, which Load can re-open.',
      ext: '.json',
      okLabel: 'Save',
      suggestion: suggestedName()
    }).then(function (name) {
      if (name == null) return;              // cancelled
      writeSaveFile(name);
    });
  }

  function writeSaveFile(name) {
    // Don't end up with "issue.json.json" if the name already carries it.
    var base = String(name).replace(/\.json$/i, '') || suggestedName();
    var json = State.toJSON();
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = base + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    State.dirty = false;
    State.autosave();
    toast('Saved ' + base + '.json to your downloads.', 'ok');
  }

  function loadFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { toast('Could not read that file.', 'err'); };
    reader.onload = function (e) {
      var data;
      try {
        data = JSON.parse(e.target.result);
      } catch (err) {
        toast('That file is not a valid newsletter (.json).', 'err');
        return;
      }
      // `typeof [] === 'object'`, so an array root passes a naive check and
      // then becomes State.doc itself — after which JSON.stringify drops every
      // named property and Save writes "[]".
      if (!State.isUsableDoc(data)) {
        toast('That file is not a valid newsletter.', 'err');
        return;
      }

      // Swap into the new document only if it renders. Keeping a snapshot means
      // a file that still fails leaves the user's current work on screen
      // instead of a half-applied mix of old DOM and new state.
      var snapshot = State.toJSON();
      try {
        if (!State.replace(data)) throw new Error('unusable document');
        structuralChange(null);
      } catch (err) {
        try {
          State.replace(JSON.parse(snapshot));
          structuralChange(null);
        } catch (e2) {
          State.reset();
          structuralChange(null);
        }
        toast('That newsletter could not be opened, so nothing was changed.', 'err');
        return;
      }
      if (Keys.Flip) Keys.Flip.go(1, { animate: false });
      toast('Loaded ' + file.name, 'ok');
    };
    reader.readAsText(file);
  }

  /** Strip the inline styles Flip owns so every page prints. Belt-and-braces
   *  alongside print.css — inline styles otherwise win over the stylesheet. */
  function prepareForPrint() {
    document.body.classList.add('is-printing');
    var stage = $('#page-stage');
    var sizer = $('#stage-sizer');
    if (stage) stage.style.transform = 'none';
    if (sizer) { sizer.style.width = ''; sizer.style.height = ''; }
    $$('#page-stage .paper').forEach(function (p) {
      p.style.visibility = '';
      p.style.transform = '';
      p.style.zIndex = '';
      p.style.opacity = '';
      p.classList.remove('is-hidden');
    });
    if (Keys.Fit) Keys.Fit.refitAll();
  }

  function restoreAfterPrint() {
    document.body.classList.remove('is-printing');
    restorePrintTitle();
    if (Keys.Flip) {
      Keys.Flip.relayout();
      Keys.Flip.go(Keys.Flip.current(), { animate: false });
    }
    if (Keys.Fit) Keys.Fit.refitAll();
  }

  /* There is no web API for setting the PDF file name: "Save as PDF" is the
   * browser's own dialog and it seeds the name from document.title. So the
   * name the user picked is parked in the title for the duration of the print
   * and taken back afterwards. The user can still overtype it in that dialog —
   * this only decides what it suggests. */
  var savedDocTitle = null;

  function setPrintTitle(name) {
    if (savedDocTitle === null) savedDocTitle = document.title;
    document.title = name;
  }

  function restorePrintTitle() {
    if (savedDocTitle === null) return;
    document.title = savedDocTitle;
    savedDocTitle = null;
  }

  function printDoc() {
    askFilename({
      title: 'Export PDF',
      note: 'Choose "Save as PDF" as the destination in the print dialog. ' +
            'This is the file name it will suggest.',
      ext: '.pdf',
      okLabel: 'Continue',
      suggestion: suggestedName()
    }).then(function (name) {
      if (name == null) return;              // cancelled
      printWithName(String(name).replace(/\.pdf$/i, '') || suggestedName());
    });
  }

  function printWithName(base) {
    setPrintTitle(base);
    prepareForPrint();
    /* The title must survive until the print dialog has read it, so it is NOT
     * put back here: `afterprint` is the restore path. Browsers differ on
     * whether print() blocks, so restoring on the next line would be a race
     * the feature loses silently. Regaining window focus is the backstop for
     * anything that never fires afterprint — by then the dialog is gone. */
    var backstop = function () {
      global.removeEventListener('focus', backstop);
      restorePrintTitle();
    };
    global.addEventListener('focus', backstop);

    // Let layout settle before handing off to the print engine.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { global.print(); });
    });
  }

  /* -------------------------------------------------------------------------
   * Thumbnails / pager
   * ---------------------------------------------------------------------- */
  function buildThumbs() {
    var rail = $('#thumb-rail');
    if (!rail) return;
    var current = Keys.Flip ? Keys.Flip.current() : 1;
    var list = pageList();
    var html = '';

    list.forEach(function (p) {
      var esc = function (t) {
        return String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
          .replace(/</g, '&lt;');
      };
      html += '<button type="button" class="thumb' +
        (p.n === current ? ' is-active' : '') +
        '" data-page="' + p.n + '" data-kind="' + esc(p.kind) + '"' +
        ' data-orientation="' + esc(p.orientation) + '"' +
        ' title="' + esc(p.name) + '"' +
        ' aria-label="Page ' + p.n + ': ' + esc(p.name) + '"' +
        (p.n === current ? ' aria-current="true"' : '') + '>' +
        '<span class="thumb-sheet"><span class="thumb-num">' + p.n +
          '</span></span>' +
        '<span class="thumb-label">' + esc(p.short) + '</span>' +
        '</button>';
    });

    /* The shortcut: add another announcement page straight from the preview,
     * without opening the editor rail. */
    var apages = (State.doc.articles && Array.isArray(State.doc.articles.pages))
      ? State.doc.articles.pages.length : 1;
    var atMax = apages >= (State.MAX_ANNOUNCEMENT_PAGES || 20);
    html += '<button type="button" class="thumb thumb--add" data-act="page-add"' +
      (atMax ? ' disabled' : '') +
      ' title="Add another announcement page"' +
      ' aria-label="Add another announcement page">' +
      '<span class="thumb-sheet"><span class="thumb-plus" aria-hidden="true">+' +
        '</span></span>' +
      '<span class="thumb-label">Add page</span>' +
      '</button>';

    rail.innerHTML = html;
  }

  /* -------------------------------------------------------------------------
   * Announcement pages
   * ---------------------------------------------------------------------- */
  function announcementPages() {
    if (!State.doc.articles || !Array.isArray(State.doc.articles.pages)) {
      State.doc.articles = State.doc.articles || {};
      State.doc.articles.pages = [[]];
    }
    return State.doc.articles.pages;
  }

  function addAnnouncementPage() {
    var pages = announcementPages();
    if (pages.length >= (State.MAX_ANNOUNCEMENT_PAGES || 20)) {
      toast('That is the maximum number of announcement pages.', 'err');
      return;
    }
    var newIndex = pages.length;
    structuralChange(function () {
      pages.push([{ title: 'NEW SECTION',
                    body: '<p>Write the announcement here…</p>' }]);
    });
    var p = Keys.Render.pages().filter(function (x) {
      return x.kind === 'announcements';
    })[newIndex];
    if (p && Keys.Flip) Keys.Flip.go(p.n);
    toast('Added page ' + (p ? p.n : '') + '.', 'ok');
  }

  function removeAnnouncementPage(index) {
    var pages = announcementPages();
    var i = Number(index);
    if (isNaN(i) || i < 0 || i >= pages.length) return;
    if (pages.length <= 1) {
      toast('The issue needs at least one announcement page.', 'err');
      return;
    }
    var count = (pages[i] || []).length;
    if (count && !global.confirm(
      'Delete this page and the ' + count +
      (count === 1 ? ' section' : ' sections') + ' on it?')) return;

    structuralChange(function () { pages.splice(i, 1); });
    if (Keys.Flip && Keys.Flip.current() > totalPages()) {
      Keys.Flip.go(totalPages());
    }
    toast('Page removed.', 'ok');
  }

  function onPageChange(page) {
    var ind = $('#page-indicator');
    var total = totalPages();
    if (ind) ind.textContent = page + ' / ' + total;
    $$('#thumb-rail .thumb').forEach(function (t) {
      var on = Number(t.getAttribute('data-page')) === page;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'true');
      else t.removeAttribute('aria-current');
    });
    var prev = $('[data-act="prev"]');
    var next = $('[data-act="next"]');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= total;
    syncZoomLabel();
  }

  function syncZoomLabel() {
    var label = $('#zoom-label');
    if (!label || !Keys.Flip) return;
    var z = Keys.Flip.getZoom();
    label.textContent = z.mode === 'fit' ? 'Fit' : Math.round(z.scale * 100) + '%';
    var btn = $('[data-act="zoom-fit"]');
    if (btn) btn.setAttribute('aria-pressed', z.mode === 'fit' ? 'true' : 'false');
  }

  /* -------------------------------------------------------------------------
   * Theme
   *
   * The palette is chosen by the inline bootstrap in index.html before the
   * first paint; this only handles switching and persistence. The paper is
   * always white in both themes — it is paper.
   * ---------------------------------------------------------------------- */
  var THEME_KEY = 'stpeters.keys.theme';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark' : 'light';
  }

  function applyTheme(theme, persist) {
    var next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);

    var btn = $('[data-act="theme"]');
    if (btn) {
      // The button offers the OTHER theme, so its label describes the result.
      var offering = next === 'dark' ? 'light' : 'dark';
      var label = 'Switch to ' + offering + ' theme';
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
      // No aria-pressed here on purpose — see the note in index.html.
    }

    if (persist) {
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    }

    // The canvas colour changes, and the rail can change width if scrollbar
    // metrics differ between colour schemes.
    if (Keys.Flip) Keys.Flip.relayout();
    return next;
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
    toast(next === 'dark' ? 'Dark theme on.' : 'Light theme on.', 'ok');
  }

  function watchSystemTheme() {
    if (!global.matchMedia) return;
    var mq = global.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      // Only follow the OS while the user has not made an explicit choice.
      var saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
      if (saved === 'light' || saved === 'dark') return;
      applyTheme(mq.matches ? 'dark' : 'light', false);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* -------------------------------------------------------------------------
   * Rail resizing
   * ---------------------------------------------------------------------- */
  var MIN_RAIL = 300, MAX_RAIL = 640;

  function setRail(px) {
    var app = $('#app');
    if (!app) return;
    if (px <= 40) {
      document.body.classList.add('is-collapsed-rail');
    } else {
      document.body.classList.remove('is-collapsed-rail');
      app.style.setProperty('--rail-w',
        Math.max(MIN_RAIL, Math.min(MAX_RAIL, px)) + 'px');
    }
    if (Keys.Flip) Keys.Flip.relayout();
  }

  function wireResizer() {
    var handle = $('#rail-resizer');
    if (!handle) return;
    var dragging = false;

    function move(e) {
      if (!dragging) return;
      var x = e.touches ? e.touches[0].clientX : e.clientX;
      setRail(x);
      e.preventDefault();
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-resizing');
      handle.classList.remove('is-active');
    }

    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      document.body.classList.add('is-resizing');
      handle.classList.add('is-active');
      e.preventDefault();
    });
    handle.addEventListener('touchstart', function () {
      dragging = true;
      document.body.classList.add('is-resizing');
      handle.classList.add('is-active');
    }, { passive: true });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);

    handle.addEventListener('keydown', function (e) {
      var app = $('#app');
      var cur = parseInt(getComputedStyle(app).getPropertyValue('--rail-w'), 10) || 380;
      if (e.key === 'ArrowLeft') { setRail(cur - 24); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setRail(cur + 24); e.preventDefault(); }
      if (e.key === 'Enter' || e.key === ' ') {
        document.body.classList.toggle('is-collapsed-rail');
        if (Keys.Flip) Keys.Flip.relayout();
        e.preventDefault();
      }
    });
  }

  /* -------------------------------------------------------------------------
   * Global event wiring
   * ---------------------------------------------------------------------- */
  function wire() {

    /* --- typing in a rich-text field --- */
    document.addEventListener('input', function (e) {
      var el = e.target;
      if (!el.classList) return;
      if (el.classList.contains('rt')) {
        commitField(el);
      } else if (el.classList.contains('pt') && el.tagName === 'INPUT' &&
                 el.type !== 'checkbox') {
        var ptPath = el.getAttribute('data-path');
        if (!ptPath) return;
        State.set(ptPath, el.value);
        Keys.Render.push(ptPath, el.value);
        scheduleAutosave();
      }
    });

    /* --- plain selects / checkboxes: always a structural change --- */
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (el === $('#load-input')) { loadFile(e); return; }
      if (el.id === 'template-select') { chooseTemplate(el.value); return; }
      if (!el.classList || !el.classList.contains('pt')) return;
      var path = el.getAttribute('data-path');
      if (!path) return;
      var value = el.type === 'checkbox' ? el.checked
        : (el.tagName === 'SELECT' && /^-?\d+$/.test(el.value) ? Number(el.value) : el.value);
      structuralChange(function () { State.set(path, value); });
    });

    /* --- toolbar formatting: mousedown so the caret is never lost --- */
    $$('#format-group .tb-btn[data-fmt]').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      btn.addEventListener('click', function () {
        applyFormat(btn.getAttribute('data-fmt'));
      });
    });
    $$('#format-group .tb-select[data-fmt]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        applyFormat(sel.getAttribute('data-fmt'), sel.value);
        sel.selectedIndex = 0;
      });
    });

    /* --- delegated clicks --- */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.closest) return;

      /* accordion */
      var head = t.closest('.ed-head');
      if (head && !t.closest('.ed-badge')) {
        var sec = head.closest('.ed-section');
        var open = !sec.classList.contains('is-open');
        sec.classList.toggle('is-open', open);
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        return;
      }

      /* page badge / thumbnail -> navigate */
      var nav = t.closest('[data-page]');
      if (nav && nav.classList.contains('thumb--add')) nav = null;
      if (nav && (nav.classList.contains('ed-badge') || nav.classList.contains('thumb'))) {
        if (Keys.Flip) Keys.Flip.go(Number(nav.getAttribute('data-page')));
        return;
      }

      var btn = t.closest('[data-act]');
      if (!btn || btn.disabled) return;
      var act = btn.getAttribute('data-act');

      switch (act) {
        case 'save': saveFile(); return;
        case 'load': $('#load-input').click(); return;
        case 'pdf': printDoc(); return;
        case 'theme': toggleTheme(); return;
        case 'page-add': addAnnouncementPage(); return;
        case 'page-del':
          removeAnnouncementPage(btn.getAttribute('data-page-index'));
          return;
        case 'prev': if (Keys.Flip) Keys.Flip.prev(); return;
        case 'next': if (Keys.Flip) Keys.Flip.next(); return;
        case 'zoom-in': if (Keys.Flip) { Keys.Flip.zoomIn(); syncZoomLabel(); } return;
        case 'zoom-out': if (Keys.Flip) { Keys.Flip.zoomOut(); syncZoomLabel(); } return;
        case 'zoom-fit': if (Keys.Flip) { Keys.Flip.setZoom('fit'); syncZoomLabel(); } return;
      }

      /* generic list rows */
      if (act.indexOf('list-') === 0) {
        var listPath = btn.getAttribute('data-list');
        if (!listPath) return;
        structuralChange(function () {
          listAction(act, listPath, btn.getAttribute('data-index'),
                     btn.getAttribute('data-kind'));
        });
        return;
      }

      /* page 3 slip boxes */
      if (act.indexOf('slip-') === 0 || act.indexOf('field-') === 0 ||
          act.indexOf('term-') === 0 || act.indexOf('student-') === 0) {
        // slipAction may cancel (delete confirmation), so mutate first and
        // only re-render when it reports a change.
        var changed = slipAction(act, btn);
        if (changed) {
          structuralChange(null);
          if (Keys.Flip && Keys.Flip.current() !== 3) Keys.Flip.go(3);
        }
        return;
      }
    });

    /* --- click a region on the paper -> jump to its editor field --- */
    var stage = $('#page-stage');
    if (stage) stage.addEventListener('click', onPreviewClick);

    /* --- focus/blur on editor fields: navigate + highlight --- */
    document.addEventListener('focusin', function (e) {
      var el = e.target;
      if (!el.classList || !el.classList.contains('rt')) return;
      el.classList.add('is-focused');
      var path = el.getAttribute('data-path');
      var page = Number(el.getAttribute('data-page'));
      if (page && Keys.Flip && Keys.Flip.current() !== page) {
        Keys.Flip.go(page);
      }
      if (path) highlight(path, true);
      rememberSelection();
    });

    document.addEventListener('focusout', function (e) {
      var el = e.target;
      if (!el.classList || !el.classList.contains('rt')) return;
      el.classList.remove('is-focused');
      var path = el.getAttribute('data-path');
      if (path) highlight(path, false);
    });

    document.addEventListener('selectionchange', rememberSelection);

    /* --- single-line fields: no newlines --- */
    document.addEventListener('keydown', function (e) {
      var el = e.target;
      if (el.classList && el.classList.contains('rt') &&
          el.getAttribute('data-single') === 'true' && e.key === 'Enter') {
        e.preventDefault();
      }
    });

    /* --- paste as plain text so pasted Word/web markup can't wreck the
           print layout --- */
    document.addEventListener('paste', function (e) {
      var el = e.target;
      if (!el.classList || !el.classList.contains('rt')) return;
      var text = (e.clipboardData || global.clipboardData).getData('text/plain');
      if (text == null) return;
      e.preventDefault();
      if (el.getAttribute('data-single') === 'true') text = text.replace(/\s*\n+\s*/g, ' ');
      document.execCommand('insertText', false, text);
    });

    /* --- keyboard shortcuts --- */
    document.addEventListener('keydown', function (e) {
      var mod = e.metaKey || e.ctrlKey;

      if (mod && !e.shiftKey && !e.altKey) {
        var k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); saveFile(); return; }
        if (k === 'p') { e.preventDefault(); printDoc(); return; }
      }
      if (e.altKey && !mod) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); if (Keys.Flip) Keys.Flip.prev(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); if (Keys.Flip) Keys.Flip.next(); return; }
      }
      // Cmd/Ctrl+B/I/U are handled natively by contenteditable; just resync
      // the toolbar afterwards.
      if (mod && 'biu'.indexOf(e.key.toLowerCase()) !== -1) {
        setTimeout(function () {
          if (lastEditable) commitField(lastEditable);
          syncFormatButtons();
        }, 0);
      }
    });

    /* --- the Save / PDF file-name dialog --- */
    wireNameDialog();

    /* --- print hooks --- */
    global.addEventListener('beforeprint', prepareForPrint);
    global.addEventListener('afterprint', restoreAfterPrint);

    /* --- keep the button label in step, and follow the OS until the user
           makes an explicit choice --- */
    applyTheme(currentTheme(), false);
    watchSystemTheme();

    /* --- don't lose work --- */
    global.addEventListener('beforeunload', function (e) {
      State.autosave();
      if (State.dirty) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    });

    wireResizer();
  }

  /* -------------------------------------------------------------------------
   * Boot
   * ---------------------------------------------------------------------- */
  function render() {
    Keys.Editor.all();
    Keys.Render.all();

    if (Keys.Fit) Keys.Fit.init();
    if (Keys.Flip) Keys.Flip.init({ onChange: onPageChange });

    buildThumbs();
    markEmpties();
    syncTemplateSelect();
    onPageChange(Keys.Flip ? Keys.Flip.current() : 1);
    if (Keys.Fit) Keys.Fit.refitAll();
    if (Keys.Arrange) Keys.Arrange.init();
  }

  function boot() {
    if (booted) return;
    booted = true;

    var restored = false;
    try {
      restored = State.restore();
    } catch (e) {
      restored = false;
    }

    /* A corrupt autosave used to be fatal AND self-perpetuating: the first
     * render threw, so wire() never ran, nothing on the page was clickable,
     * and there was no way to clear the bad data from the UI — every reload
     * hit the same exception. State.replace() now repairs shape on the way in,
     * but this is the backstop: if the first render fails for any reason,
     * discard the saved document, tell the user, and boot the default issue.
     * wire() is always reached, so the app is never left inert. */
    try {
      render();
    } catch (e) {
      try { State.clearAutosave(); } catch (e2) {}
      State.reset();
      try {
        render();
      } catch (e3) {
        // Truly unrecoverable — surface it rather than showing a blank screen.
        var vp = $('#stage-viewport');
        if (vp) {
          vp.innerHTML = '<div class="stage-empty">St. Peter&rsquo;s Keys could ' +
            'not start. Please reload the page.</div>';
        }
      }
      wire();
      toast('Your saved session could not be opened, so it was reset. ' +
            'The newsletter has been restored to a blank issue.', 'err');
      State.dirty = false;
      return;
    }

    wire();

    if (restored) toast('Restored your last session.', 'ok');
    State.dirty = false;
  }

  var App = {
    boot: boot,
    structuralChange: structuralChange,
    toast: toast,
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    currentTheme: currentTheme,
    THEME_KEY: THEME_KEY,
    prepareForPrint: prepareForPrint,
    restoreAfterPrint: restoreAfterPrint,
    saveFile: saveFile,
    printDoc: printDoc,
    writeSaveFile: writeSaveFile,
    askFilename: askFilename,
    suggestedName: suggestedName,
    cleanFilename: cleanFilename,
    buildThumbs: buildThumbs,
    addAnnouncementPage: addAnnouncementPage,
    removeAnnouncementPage: removeAnnouncementPage,
    totalPages: totalPages,
    pageList: pageList,
    chooseTemplate: chooseTemplate,
    syncTemplateSelect: syncTemplateSelect
  };

  Keys.App = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
