/* =============================================================================
 * editor.js — Builds the left-hand editing rail and owns the two-way binding
 * between editor fields and the preview.
 *
 * Exposes window.Keys.Editor. Owns the page 1 / page 2 sections and delegates
 * page 3 to Keys.Slips.editorHTML and page 4 to Keys.Calendar.editorHTML.
 *
 * Markup contract: docs/SPEC.md §2, §9b.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};
  var State = Keys.State;

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* -------------------------------------------------------------------------
   * Field builders
   * ---------------------------------------------------------------------- */

  /** A rich-text field bound to `path`. */
  function rt(label, path, page, opts) {
    opts = opts || {};
    var cls = 'rt' + (opts.single ? ' rt--single' : '');
    var style = opts.minHeight ? ' style="min-height:' + Number(opts.minHeight) + 'px"' : '';
    var value = State.get(path);
    return '<div class="ed-field">' +
      (label ? '<label class="ed-label">' + escText(label) + '</label>' : '') +
      '<div class="' + cls + '" contenteditable="true" role="textbox"' +
        ' aria-multiline="' + (opts.single ? 'false' : 'true') + '"' +
        ' aria-label="' + escAttr(label || path) + '"' +
        ' data-path="' + escAttr(path) + '"' +
        ' data-page="' + Number(page) + '"' +
        (opts.single ? ' data-single="true"' : '') +
        (opts.placeholder ? ' data-placeholder="' + escAttr(opts.placeholder) + '"' : '') +
        style + '>' + (value == null ? '' : value) + '</div>' +
      (opts.hint ? '<p class="ed-hint">' + escText(opts.hint) + '</p>' : '') +
    '</div>';
  }

  /** Tools column for a list row. */
  function rowTools(listPath, index, len) {
    var d = ' data-list="' + escAttr(listPath) + '" data-index="' + index + '"';
    return '<div class="ed-row-tools">' +
      '<button type="button" class="ed-btn ed-btn--icon" data-act="list-up"' + d +
        (index === 0 ? ' disabled' : '') + ' title="Move up" aria-label="Move up">&#9650;</button>' +
      '<button type="button" class="ed-btn ed-btn--icon" data-act="list-down"' + d +
        (index === len - 1 ? ' disabled' : '') + ' title="Move down" aria-label="Move down">&#9660;</button>' +
      '<button type="button" class="ed-btn ed-btn--icon ed-btn--danger" data-act="list-del"' + d +
        ' title="Remove" aria-label="Remove">&#10005;</button>' +
    '</div>';
  }

  /** Repeatable date/event rows for the This Week and Looking Ahead boxes. */
  function agendaList(listPath, rows, page) {
    var len = (rows || []).length;
    var html = '<div class="ed-list">';
    (rows || []).forEach(function (row, i) {
      html += '<div class="ed-row">' +
        '<div class="ed-row-head">' +
          '<span class="ed-row-title">Entry ' + (i + 1) + '</span>' +
          rowTools(listPath, i, len) +
        '</div>' +
        '<div class="ed-cols ed-cols--1-2">' +
          rt('Date', listPath + '.' + i + '.date', page, { single: true, placeholder: '5/25' }) +
          rt('Event', listPath + '.' + i + '.event', page, { minHeight: 56, placeholder: 'What is happening' }) +
        '</div>' +
      '</div>';
    });
    html += '</div>' +
      '<button type="button" class="ed-add" data-act="list-add"' +
        ' data-list="' + escAttr(listPath) + '" data-kind="agenda">+ Add entry</button>';
    return html;
  }

  /** Repeatable full-width article sections. */
  function articleList(listPath, list, page) {
    var len = (list || []).length;
    var html = '<div class="ed-list">';
    (list || []).forEach(function (a, i) {
      var title = String(a && a.title || '').replace(/<[^>]*>/g, '').trim();
      html += '<div class="ed-row">' +
        '<div class="ed-row-head">' +
          '<span class="ed-row-title">' + escText(title || 'Section ' + (i + 1)) + '</span>' +
          rowTools(listPath, i, len) +
        '</div>' +
        rt('Heading', listPath + '.' + i + '.title', page,
           { single: true, placeholder: 'SECTION HEADING' }) +
        rt('Body', listPath + '.' + i + '.body', page,
           { minHeight: 150, placeholder: 'Write the announcement here…' }) +
      '</div>';
    });
    html += '</div>' +
      '<button type="button" class="ed-add" data-act="list-add"' +
        ' data-list="' + escAttr(listPath) + '" data-kind="article">+ Add section</button>';
    return html;
  }

  function section(id, page, title, bodyHtml, open) {
    return '<section class="ed-section' + (open ? ' is-open' : '') +
        '" data-section="' + escAttr(id) + '">' +
      '<button type="button" class="ed-head" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="ed-badge" data-page="' + Number(page) + '" title="Go to page ' +
          Number(page) + '">' + Number(page) + '</span>' +
        '<span class="ed-head-title">' + escText(title) + '</span>' +
        '<span class="ed-chev" aria-hidden="true"></span>' +
      '</button>' +
      '<div class="ed-body">' + bodyHtml + '</div>' +
    '</section>';
  }

  function subhead(text) {
    return '<h3 class="ed-subhead">' + escText(text) + '</h3>';
  }

  /* -------------------------------------------------------------------------
   * Sections
   * ---------------------------------------------------------------------- */
  function page1Section(d) {
    var body =
      subhead('Masthead') +
      rt('Tagline', 'masthead.tagline', 1, { single: true }) +
      rt('Newsletter title', 'masthead.title', 1, { single: true }) +
      rt('Motto', 'masthead.motto', 1, { single: true }) +
      rt('Issue date', 'masthead.date', 1, { single: true, placeholder: 'May 26, 2026' }) +
      rt('School contact block', 'masthead.schoolInfo', 1,
         { minHeight: 110, hint: 'Appears at the top right of page 1.' }) +

      subhead('Classroom Corner') +
      rt('Section heading', 'masthead.sectionHeading', 1, { single: true }) +
      rt('Verse or quote', 'classroom.verse', 1, { minHeight: 70 }) +
      rt('Article', 'classroom.body', 1,
         { minHeight: 240, hint: 'The main story. Long text is shrunk to fit the column.' }) +
      rt('Sign-off', 'classroom.signature', 1, { minHeight: 48 }) +

      subhead('This Week') +
      rt('Box heading', 'thisWeek.heading', 1, { single: true }) +
      agendaList('thisWeek.rows', d.thisWeek && d.thisWeek.rows, 1) +

      subhead('Looking Ahead') +
      rt('Box heading', 'lookingAhead.heading', 1, { single: true }) +
      agendaList('lookingAhead.rows', d.lookingAhead && d.lookingAhead.rows, 1) +
      rt('Footer note', 'lookingAhead.note', 1, { single: true }) +

      subhead('Page 1 announcements') +
      articleList('articles.page1', d.articles && d.articles.page1, 1);

    /* Closed by default, like every other section: a fresh load (and a reload)
     * shows a compact index of the four pages rather than a wall of fields.
     * Editor.all() carries the user's open/closed state across structural
     * re-renders, so this default only ever applies to the FIRST render. */
    return section('page1', 1, 'Front Page', body, false);
  }

  function page2Section(d) {
    var body =
      '<p class="ed-hint ed-hint--lead">Full-width announcement sections. These ' +
      'fill page 2 in order.</p>' +
      articleList('articles.page2', d.articles && d.articles.page2, 2);
    return section('page2', 2, 'Announcements', body, false);
  }

  function page3Section(d) {
    var body = Keys.Slips
      ? Keys.Slips.editorHTML(d.slips || [])
      : '<p class="ed-hint">Slips module unavailable.</p>';
    // Plain text, not an HTML entity: section() runs the title through
    // escText(), so an "&amp;" here would be escaped a second time and show up
    // on screen as the literal characters "&amp;".
    return section('page3', 3, 'Lunch Slips and Forms', body, false);
  }

  function page4Section(d) {
    var body = Keys.Calendar
      ? Keys.Calendar.editorHTML(d.calendar || {})
      : '<p class="ed-hint">Calendar module unavailable.</p>';
    return section('page4', 4, 'Monthly Calendar', body, false);
  }

  /* -------------------------------------------------------------------------
   * Public API
   * ---------------------------------------------------------------------- */
  var Editor = {
    /** Rebuild the whole rail. Preserves which sections were open. */
    all: function () {
      var host = document.getElementById('editor-scroll');
      if (!host) return;

      var openState = {};
      var prev = host.querySelectorAll('.ed-section');
      for (var i = 0; i < prev.length; i++) {
        openState[prev[i].getAttribute('data-section')] =
          prev[i].classList.contains('is-open');
      }
      var scrollTop = host.scrollTop;

      var d = State.doc;
      host.innerHTML =
        page1Section(d) + page2Section(d) + page3Section(d) + page4Section(d);

      // Restore prior open/closed state (first render uses the defaults above).
      if (prev.length) {
        var now = host.querySelectorAll('.ed-section');
        for (var j = 0; j < now.length; j++) {
          var key = now[j].getAttribute('data-section');
          if (key in openState) {
            now[j].classList.toggle('is-open', openState[key]);
            var head = now[j].querySelector('.ed-head');
            if (head) head.setAttribute('aria-expanded', openState[key] ? 'true' : 'false');
          }
        }
        host.scrollTop = scrollTop;
      }

      Editor.syncPlainInputs();
    },

    /** Reflect state into the `.pt` inputs/selects (they are value-driven,
     *  not innerHTML-driven, so they need an explicit pass). */
    syncPlainInputs: function () {
      var els = document.querySelectorAll('#editor-scroll .pt[data-path]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var v = State.get(el.getAttribute('data-path'));
        if (el.type === 'checkbox') {
          el.checked = !!v && v !== 'false';
        } else if (el.value !== String(v == null ? '' : v)) {
          el.value = String(v == null ? '' : v);
        }
      }
    },

    /** Only rebuild the page 3 section (slip added/removed/reordered). */
    slips: function () {
      var host = document.querySelector('#editor-scroll .ed-section[data-section="page3"] .ed-body');
      if (!host || !Keys.Slips) return;
      host.innerHTML = Keys.Slips.editorHTML(State.doc.slips || []);
      Editor.syncPlainInputs();
    },

    /** Only rebuild the page 4 section (month/year changed). */
    calendar: function () {
      var host = document.querySelector('#editor-scroll .ed-section[data-section="page4"] .ed-body');
      if (!host || !Keys.Calendar) return;
      host.innerHTML = Keys.Calendar.editorHTML(State.doc.calendar || {});
      Editor.syncPlainInputs();
    },

    /** Put the caret at the end of a contenteditable so the user can carry on
     *  typing rather than overwriting from position zero. */
    caretToEnd: function (el) {
      if (!el || !el.isContentEditable) return;
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* non-fatal: the field is focused either way */ }
    },

    /** Focus the field for `path`, opening its section and scrolling to it.
     *  Used both by the preview's click-to-edit and programmatically. */
    focusPath: function (path) {
      if (!path) return null;
      var el = document.querySelector(
        '#editor-scroll [data-path="' +
        (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]');
      if (!el) return null;

      // A collapsed section is `display:none`, so the field is unfocusable and
      // unscrollable until its accordion is opened.
      var sec = el.closest('.ed-section');
      if (sec && !sec.classList.contains('is-open')) {
        sec.classList.add('is-open');
        var head = sec.querySelector('.ed-head');
        if (head) head.setAttribute('aria-expanded', 'true');
      }

      // preventScroll stops the browser's own abrupt jump-to-focus from
      // fighting the smooth scroll below.
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      Editor.caretToEnd(el);

      // Defer a frame: the section may have just become visible, so its
      // geometry is not final until layout runs again.
      requestAnimationFrame(function () {
        if (el.scrollIntoView) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        // Brief flash so it is obvious where the click landed, especially when
        // the jump also had to open a section.
        el.classList.remove('is-jumped');
        void el.offsetWidth;                 // restart the animation
        el.classList.add('is-jumped');
        setTimeout(function () { el.classList.remove('is-jumped'); }, 1200);
      });

      return el;
    },

    escAttr: escAttr,
    escText: escText,
    rt: rt
  };

  Keys.Editor = Editor;
})(window);
