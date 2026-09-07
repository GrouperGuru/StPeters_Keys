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
  /** A checkbox bound to a boolean path. */
  function check(label, path, page, hint) {
    var on = !!State.get(path);
    return '<div class="ed-field">' +
      '<label class="ed-check">' +
        '<input type="checkbox" class="pt" data-path="' + escAttr(path) + '"' +
          ' data-page="' + Number(page) + '"' + (on ? ' checked' : '') + '>' +
        '<span>' + escText(label) + '</span>' +
      '</label>' +
      (hint ? '<p class="ed-hint">' + escText(hint) + '</p>' : '') +
    '</div>';
  }

  /* -------------------------------------------------------------------------
   * Front page.
   *
   * The two templates print different things, so the rail offers different
   * fields. The rule is: SHOW ONLY WHAT THE ACTIVE TEMPLATE RENDERS. Anything
   * the other template owns stays in the document untouched and reappears the
   * moment you switch back — the lead hint says so, because a field silently
   * vanishing from the rail is otherwise indistinguishable from losing it.
   *
   * Shared by both:  tagline, title, date, schoolInfo, sectionHeading,
   *                  classroom.body/signature, thisWeek, lookingAhead,
   *                  articles.page1.
   * Contemporary:    masthead.motto, classroom.verse.
   * Modern:          masthead.volume, masthead.contactHeading, intro.*,
   *                  bible.*, footer.site, modern.emblem.
   * ---------------------------------------------------------------------- */
  function page1Section(d, ordinal) {
    var modern = State.template() === 'modern';
    var other = modern ? 'Contemporary' : 'Modern';

    var body =
      '<p class="ed-hint ed-hint--lead">Fields for the <strong>' +
      (modern ? 'Modern' : 'Contemporary') + '</strong> template. The ' +
      other + ' template uses a few different ones &mdash; switch templates ' +
      'in the toolbar to edit those; nothing is lost either way.</p>' +

      subhead('Masthead') +
      rt('Tagline', 'masthead.tagline', 1, { single: true }) +
      rt('Newsletter title', 'masthead.title', 1,
         { single: true,
           hint: modern
             ? 'Printed as typed.'
             : 'Printed in capitals whatever you type.' }) +
      (modern
        ? rt('Volume and issue', 'masthead.volume', 1,
             { single: true, placeholder: 'Volume 1, Issue 1  2026',
               hint: 'Small line beside the title.' })
        : rt('Motto', 'masthead.motto', 1, { single: true })) +
      rt('Issue date', 'masthead.date', 1, { single: true, placeholder: 'May 26, 2026' }) +
      (modern ? rt('Contact heading', 'masthead.contactHeading', 1,
                   { single: true, placeholder: 'CONTACT US!' }) : '') +
      rt('School contact block', 'masthead.schoolInfo', 1,
         { minHeight: 110,
           hint: modern
             ? 'Bottom of the right-hand column.'
             : 'Appears at the top right of page 1.' }) +

      (modern
        ? subhead('Introducing the Keys') +
          rt('Block heading', 'intro.heading', 1,
             { minHeight: 48,
               hint: 'Two lines in the reference. Press Shift+Enter for a line break.' }) +
          rt('Block text', 'intro.body', 1, { minHeight: 150 }) +
          check('Show the cross-and-book emblem', 'modern.emblem', 1,
                'Line art under the intro block. Turn it off to buy space on a busy issue.') +

          subhead('Bible Inspo') +
          rt('Block heading', 'bible.heading', 1, { single: true, placeholder: 'Bible Inspo:' }) +
          rt('Verses', 'bible.body', 1, { minHeight: 150 })
        : '') +

      subhead('Classroom Corner') +
      rt('Section heading', 'masthead.sectionHeading', 1, { single: true }) +
      (modern ? '' : rt('Verse or quote', 'classroom.verse', 1, { minHeight: 70 })) +
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
      articleList('articles.page1', d.articles && d.articles.page1, 1) +

      (modern
        ? subhead('Running foot') +
          rt('Website line', 'footer.site', 1,
             { single: true, placeholder: 'discoverstpeters.org',
               hint: 'Printed at the foot of the front page. Page numbers are ' +
                     'added automatically.' })
        : '');

    /* Closed by default, like every other section: a fresh load (and a reload)
     * shows a compact index of the four pages rather than a wall of fields.
     * Editor.all() carries the user's open/closed state across structural
     * re-renders, so this default only ever applies to the FIRST render. */
    return section('page1', ordinal || 1, 'Front Page', body, false);
  }

  /** The Announcements section: one group per announcement page, plus the
   *  controls to add and remove pages. */
  function page2Section(d, pageList) {
    var apages = (d.articles && Array.isArray(d.articles.pages))
      ? d.articles.pages : [[]];
    var ordinals = pageList.filter(function (p) {
      return p.kind === 'announcements';
    });
    var firstOrdinal = ordinals.length ? ordinals[0].n : 2;

    var body =
      '<p class="ed-hint ed-hint--lead">Full-width announcement sections. ' +
      'Add as many pages as the issue needs &mdash; the pages after them ' +
      'renumber themselves.</p>';

    apages.forEach(function (list, i) {
      var ord = ordinals[i] ? ordinals[i].n : firstOrdinal + i;
      body +=
        '<div class="ed-subpage" data-page-index="' + i + '">' +
          '<div class="ed-subpage-head">' +
            '<span class="ed-subpage-badge">' + ord + '</span>' +
            '<span class="ed-subpage-title">' +
              escText(ordinals[i] ? ordinals[i].name : 'Announcements') +
            '</span>' +
            (apages.length > 1
              ? '<button type="button" class="ed-btn ed-btn--icon ed-btn--danger"' +
                ' data-act="page-del" data-page-index="' + i + '"' +
                ' title="Remove this page" aria-label="Remove announcement page ' +
                ord + '">&#10005;</button>'
              : '') +
          '</div>' +
          articleList('articles.pages.' + i, list, ord) +
        '</div>';
    });

    var atMax = apages.length >=
      (Keys.State.MAX_ANNOUNCEMENT_PAGES || 20);
    body += '<button type="button" class="ed-add ed-add--page"' +
      ' data-act="page-add"' + (atMax ? ' disabled' : '') + '>' +
      '+ Add announcement page</button>';

    return section('page2', firstOrdinal, 'Announcements', body, false);
  }

  function page3Section(d, ordinal) {
    var body = Keys.Slips
      ? Keys.Slips.editorHTML(d.slips || [])
      : '<p class="ed-hint">Slips module unavailable.</p>';
    // Plain text, not an HTML entity: section() runs the title through
    // escText(), so an "&amp;" here would be escaped a second time and show up
    // on screen as the literal characters "&amp;".
    return section('page3', ordinal || 3, 'Lunch Slips and Forms', body, false);
  }

  function page4Section(d, ordinal) {
    var body = Keys.Calendar
      ? Keys.Calendar.editorHTML(d.calendar || {})
      : '<p class="ed-hint">Calendar module unavailable.</p>';
    return section('page4', ordinal || 4, 'Monthly Calendar', body, false);
  }

  /**
   * Force every field's `data-page` to its section's ordinal.
   *
   * `data-page` is what makes focusing a field turn the preview to the right
   * sheet. Adding an announcement page renumbers everything after it, and
   * slips.js / calendar.js hard-code "3" and "4" in the markup they hand back.
   * Rather than thread ordinals through those modules, the numbers are
   * corrected here in one pass — the section already knows which page it is.
   */
  function syncFieldPages(host) {
    var sections = host.querySelectorAll('.ed-section');
    for (var i = 0; i < sections.length; i++) {
      var badge = sections[i].querySelector('.ed-badge');
      if (!badge) continue;
      var n = badge.getAttribute('data-page');
      if (!n) continue;
      var fields = sections[i].querySelectorAll('[data-page]');
      for (var j = 0; j < fields.length; j++) {
        /* Sub-page badges carry their own correct ordinal already. */
        if (fields[j].classList.contains('ed-badge')) continue;
        fields[j].setAttribute('data-page', n);
      }
    }
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
      var pageList = Keys.Render && Keys.Render.pages ? Keys.Render.pages() : [];
      var ord = function (kind) {
        for (var i = 0; i < pageList.length; i++) {
          if (pageList[i].kind === kind) return pageList[i].n;
        }
        return 0;
      };
      host.innerHTML =
        page1Section(d, ord('front')) +
        page2Section(d, pageList) +
        page3Section(d, ord('slips')) +
        page4Section(d, ord('calendar'));

      syncFieldPages(host);

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
