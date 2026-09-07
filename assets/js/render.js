/* =============================================================================
 * render.js — Builds the preview pages from Keys.State.doc.
 *
 * Exposes window.Keys.Render. Owns the front and announcement sheets directly
 * and delegates the slips sheet to Keys.Slips and the calendar to
 * Keys.Calendar.
 *
 * TEMPLATES. The front and announcement sheets have two layouts, chosen by
 * `State.doc.template` (SPEC §3c):
 *
 *   contemporary — serif, one wide column plus a ruled right-hand rail.
 *   modern       — geometric sans, three columns on the front, two on
 *                  announcements, ruled headings and a running foot.
 *
 * Both read the SAME document. Only the front page's markup actually forks;
 * announcements share one markup tree and differ in CSS alone, which is what
 * keeps arrange.js and click-to-edit working identically on both. Slips and
 * calendar are untouched by the template.
 *
 * Every sheet carries `data-template` so paper.css can scope without having to
 * know anything about the page ordinal.
 *
 * Markup contract: docs/SPEC.md §3, §3b, §3c.
 * ========================================================================== */
(function (global) {
  'use strict';

  var Keys = global.Keys = global.Keys || {};
  var State = Keys.State;

  /** Escape a value destined for an HTML attribute. Content values are
   *  intentionally raw HTML, but attributes never are. */
  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** A bound preview node: its HTML is replaced whenever `path` changes. */
  function out(cls, path, tag) {
    tag = tag || 'div';
    var html = State.get(path);
    return '<' + tag + ' class="' + escAttr(cls) + ' rt-out" data-bind="' +
      escAttr(path) + '">' + (html == null ? '' : html) + '</' + tag + '>';
  }

  /** Wrap page contents in the standard paper shell.
   *
   *  `data-page` is the ORDINAL and shifts as announcement pages are added or
   *  removed. `data-kind` is the stable identity — CSS and any logic that
   *  means "the calendar" must key off kind, never off the number.
   *  `data-template` is on every sheet, including the two the template does
   *  not change, so a selector never has to combine kind and template to work
   *  out whether it is allowed to apply. */
  function paper(n, orientation, inner, kind) {
    return '<div class="paper" data-page="' + n +
      '" data-kind="' + escAttr(kind) + '"' +
      ' data-template="' + escAttr(State.template()) + '"' +
      ' data-orientation="' + orientation + '" data-fit-page>' +
      '<div class="paper-flow">' + inner + '</div>' +
      '<div class="paper-shade" aria-hidden="true"></div>' +
      '</div>';
  }

  /* -------------------------------------------------------------------------
   * Page 1 — masthead, Classroom Corner, This Week / Looking Ahead rail,
   * then full-width article sections.
   * ---------------------------------------------------------------------- */
  function agendaTable(basePath, rows) {
    var html = '<table class="nl-agenda"><tbody>';
    (rows || []).forEach(function (row, i) {
      html += '<tr>' +
        out('nl-agenda-date', basePath + '.rows.' + i + '.date', 'td') +
        out('nl-agenda-event', basePath + '.rows.' + i + '.event', 'td') +
        '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function railBox(basePath, headingPath, rows, notePath) {
    /* data-move / data-drop drive drag-to-reorder (arrange.js, SPEC §11). */
    return '<section class="nl-box" data-move="rail" data-move-key="' +
        escAttr(basePath) + '" data-move-label="' +
        escAttr(basePath === 'thisWeek' ? 'This Week' : 'Looking Ahead') + '">' +
      out('nl-box-title', headingPath) +
      /* fit-max is the CEILING in px, and must match the size paper.css gives
       * .nl-box-body (.93em of 14px = 13px ≈ 9.75pt, the reference agenda
       * size). Setting it lower makes tier 1 shrink text that already fit. */
      '<div class="nl-box-body fit" data-fit data-fit-max="13" data-fit-min="5">' +
        '<div class="fit-inner">' +
          agendaTable(basePath, rows) +
          (notePath ? out('nl-box-note', notePath) : '') +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* -------------------------------------------------------------------------
   * Modern rail box.
   *
   * Same data, same drag attributes, different shape: no ruled outline and no
   * fixed height. Each entry is ONE centred line ("9/8 Soccer Practice 3–5 pm")
   * rather than a two-column table row, so the date and event are inline spans
   * carrying the same data-bind paths the table cells used.
   *
   * There is deliberately no [data-fit] box here. Tier 1 needs a definite
   * height to measure against, and the Modern rail has none — the entries just
   * flow. A rail long enough to overrun the sheet is caught by tier 2 instead,
   * which shrinks the whole page. Wrapping this in a `.fit` box with auto
   * height would be worse than useless: clientHeight would always equal
   * scrollHeight, so tier 1 would report success while clipping nothing and
   * doing nothing.
   * ---------------------------------------------------------------------- */
  function agendaLines(basePath, rows) {
    var html = '<div class="nl-m-lines">';
    (rows || []).forEach(function (row, i) {
      html += '<p class="nl-m-line">' +
        out('nl-m-line-date', basePath + '.rows.' + i + '.date', 'span') +
        ' ' +
        out('nl-m-line-event', basePath + '.rows.' + i + '.event', 'span') +
      '</p>';
    });
    html += '</div>';
    return html;
  }

  function railBoxModern(basePath, headingPath, rows, notePath) {
    return '<section class="nl-m-block" data-move="rail" data-move-key="' +
        escAttr(basePath) + '" data-move-label="' +
        escAttr(basePath === 'thisWeek' ? 'This Week' : 'Looking Ahead') + '">' +
      out('nl-m-blocktitle', headingPath) +
      agendaLines(basePath, rows) +
      (notePath ? out('nl-box-note', notePath) : '') +
    '</section>';
  }

  /** The front-page rail boxes, emitted in the order `railOrder` gives.
   *  Both templates walk the same order list; only the box markup differs. */
  function railBoxes(d, modern) {
    var order = Array.isArray(d.railOrder) && d.railOrder.length
      ? d.railOrder : ['thisWeek', 'lookingAhead'];
    var box = modern ? railBoxModern : railBox;
    var html = '';
    order.forEach(function (key) {
      if (key === 'thisWeek') {
        html += box('thisWeek', 'thisWeek.heading',
                    d.thisWeek && d.thisWeek.rows, null);
      } else if (key === 'lookingAhead') {
        html += box('lookingAhead', 'lookingAhead.heading',
                    d.lookingAhead && d.lookingAhead.rows, 'lookingAhead.note');
      }
    });
    return html;
  }

  function articles(listPath, list) {
    /* The container is a drop zone and each article a draggable block; both
     * pages declare the same kind, which is what lets an announcement be
     * dragged from page 1 to page 2 (arrange.js, SPEC §11). */
    var html = '<div class="nl-articles" data-drop="article" data-drop-list="' +
      escAttr(listPath) + '">';
    (list || []).forEach(function (a, i) {
      var title = String(a && a.title || '').replace(/<[^>]*>/g, '').trim();
      html += '<article class="nl-article" data-move="article"' +
        ' data-move-key="' + escAttr(listPath + ':' + i) + '"' +
        ' data-move-label="' + escAttr(title || 'Section ' + (i + 1)) + '">' +
        out('nl-article-title', listPath + '.' + i + '.title') +
        out('nl-article-body', listPath + '.' + i + '.body') +
        '</article>';
    });
    html += '</div>';
    return html;
  }

  /* -------------------------------------------------------------------------
   * The page list. Front, then one sheet per announcement page, then the
   * slips and the calendar. Everything that needs to know what pages exist —
   * the pager, the thumbnails, the editor, the tests — reads this rather than
   * assuming four.
   * ---------------------------------------------------------------------- */
  function pages() {
    var d = State.doc;
    var list = [{ kind: 'front', name: 'Front Page', short: 'Front',
                  orientation: 'portrait' }];

    var apages = (d.articles && Array.isArray(d.articles.pages))
      ? d.articles.pages : [[]];
    apages.forEach(function (_, i) {
      list.push({
        kind: 'announcements',
        /* Same wording in the thumbnail caption as in the tooltip: the rail
         * is the main way the office manager refers to these pages, and
         * "Notices"/"News 2" did not match anything else in the app. */
        name: apages.length > 1 ? 'Announcements ' + (i + 1) : 'Announcements',
        short: apages.length > 1 ? 'Announcements ' + (i + 1) : 'Announcements',
        orientation: 'portrait',
        listPath: 'articles.pages.' + i,
        pageIndex: i
      });
    });

    list.push({ kind: 'slips', name: 'Lunch Slips', short: 'Slips',
                orientation: 'portrait' });
    list.push({ kind: 'calendar', name: 'Calendar', short: 'Calendar',
                orientation: 'landscape' });

    list.forEach(function (p, i) { p.n = i + 1; });
    return list;
  }

  /* -------------------------------------------------------------------------
   * Modern-only chrome
   * ---------------------------------------------------------------------- */

  /* Cross-and-open-book line art from reference/Keys_Modern-Page1.png.
   *
   * Drawn here rather than loaded, for the same reason as the slips starburst:
   * the app makes no network requests and has no image upload, so a decoration
   * has to be inline SVG. It is template chrome, not content — it carries no
   * data-bind and is aria-hidden, so click-to-edit ignores it. `modern.emblem`
   * turns it off for issues that need the space. */
  function emblem() {
    return '<div class="nl-m-emblem" aria-hidden="true">' +
      '<svg viewBox="0 0 120 108" role="presentation" focusable="false">' +
        '<g fill="none" stroke="#000" stroke-width="3.2" ' +
           'stroke-linecap="round" stroke-linejoin="round">' +
          /* rays above the cross */
          '<path d="M60 3v7M47 7l3 6.5M73 7l-3 6.5M37 15l4.5 5.5M83 15l-4.5 5.5"/>' +
          /* cross, drawn as one outline so it reads as line art */
          '<path d="M53.5 19h13v13.5H80v13H66.5V72h-13V45.5H40v-13h13.5V19Z"/>' +
          /* open book: two page blocks meeting at the spine */
          '<path d="M60 76.5C50 68.5 26 68.5 8 72.5v27C26 95.5 50 95.5 60 103.5' +
            'c10-8 34-8 52-4v-27c-18-4-42-4-52 4Z"/>' +
          '<path d="M60 76.5v27"/>' +
          /* text lines on each page */
          '<path d="M18 79.5c8-1.4 18-1.8 26-.6M18 87c8-1.4 18-1.8 26-.6' +
            'M18 94.5c8-1.4 18-1.8 26-.6"/>' +
          '<path d="M76 78.9c8-1.2 18-.8 26 .6M76 86.4c8-1.2 18-.8 26 .6' +
            'M76 93.9c8-1.2 18-.8 26 .6"/>' +
        '</g>' +
      '</svg>' +
    '</div>';
  }

  /** The Modern running foot. `site` only on the front sheet, as in the
   *  reference; the page number is DERIVED from the ordinal, so it is plain
   *  text with no data-bind — there is nothing to edit. */
  function modernFoot(n, withSite) {
    return '<div class="nl-m-foot">' +
      (withSite ? out('nl-m-foot-site', 'footer.site', 'span')
                : '<span class="nl-m-foot-site"></span>') +
      '<span class="nl-m-foot-num">' + Number(n) + '</span>' +
    '</div>';
  }

  /* -------------------------------------------------------------------------
   * Front page — one builder per template
   * ---------------------------------------------------------------------- */
  function frontContemporary(d) {
    return out('nl-tagline', 'masthead.tagline') +
      '<div class="nl-top">' +
        '<div class="nl-top-main">' +
          out('nl-title', 'masthead.title') +
          out('nl-motto', 'masthead.motto') +
          out('nl-date', 'masthead.date') +
          out('nl-heading', 'masthead.sectionHeading') +
          out('nl-verse', 'classroom.verse') +
          out('nl-body', 'classroom.body') +
          out('nl-sign', 'classroom.signature') +
        '</div>' +
        '<aside class="nl-rail" data-drop="rail">' +
          out('nl-schoolinfo', 'masthead.schoolInfo') +
          railBoxes(d, false) +
        '</aside>' +
      '</div>' +
      articles('articles.page1', d.articles && d.articles.page1);
  }

  /* Modern front page. Masthead band, date band, tagline band, then three
   * columns: intro + emblem + Bible verses on the left, Classroom Corner in
   * the middle, agendas + contact block on the right.
   *
   * `articles.page1` still renders full-width beneath the columns. The Modern
   * reference has no such region because that issue had none — dropping the
   * list instead would silently lose whatever the author put there, and the
   * columns already run the full height when it is empty. */
  function frontModern(d, n) {
    return '<header class="nl-m-head">' +
        '<div class="nl-m-titlerow">' +
          out('nl-title', 'masthead.title') +
          out('nl-m-volume', 'masthead.volume') +
        '</div>' +
      '</header>' +
      '<div class="nl-m-dateband">' + out('nl-date', 'masthead.date') + '</div>' +
      out('nl-tagline', 'masthead.tagline') +
      '<div class="nl-m-cols">' +
        '<aside class="nl-m-aside">' +
          '<section class="nl-m-block">' +
            out('nl-m-blocktitle nl-m-blocktitle--intro', 'intro.heading') +
            out('nl-m-blockbody', 'intro.body') +
          '</section>' +
          (d.modern && d.modern.emblem ? emblem() : '') +
          '<section class="nl-m-block">' +
            out('nl-m-blocktitle nl-m-blocktitle--bare', 'bible.heading') +
            out('nl-m-blockbody', 'bible.body') +
          '</section>' +
        '</aside>' +
        '<div class="nl-m-main">' +
          out('nl-heading', 'masthead.sectionHeading') +
          out('nl-body', 'classroom.body') +
          out('nl-sign', 'classroom.signature') +
        '</div>' +
        '<aside class="nl-rail" data-drop="rail">' +
          railBoxes(d, true) +
          /* No data-move: the contact block is a fixed part of the layout, and
           * railOrder only knows the two agenda boxes. */
          '<section class="nl-m-block nl-m-contact">' +
            out('nl-m-blocktitle', 'masthead.contactHeading') +
            out('nl-schoolinfo', 'masthead.schoolInfo') +
          '</section>' +
        '</aside>' +
      '</div>' +
      articles('articles.page1', d.articles && d.articles.page1) +
      modernFoot(n, true);
  }

  function page1(n) {
    var d = State.doc;
    var inner = State.template() === 'modern'
      ? frontModern(d, n)
      : frontContemporary(d);
    return paper(n, 'portrait', inner, 'front');
  }

  /* Announcements share ONE markup tree across templates — the two-column
   * Modern layout and its ruled headings are pure CSS. That is what keeps
   * drag-to-reorder and click-to-edit behaving identically on both. */
  function announcementPage(n, listPath, list) {
    var inner = articles(listPath, list) +
      (State.template() === 'modern' ? modernFoot(n, false) : '');
    return paper(n, 'portrait', inner, 'announcements');
  }

  function slipsPage(n) {
    var html = Keys.Slips
      ? Keys.Slips.previewHTML(State.doc.slips || [])
      : '<p>Slips module unavailable.</p>';
    return paper(n, 'portrait', html, 'slips');
  }

  function calendarPage(n) {
    var html = Keys.Calendar
      ? Keys.Calendar.previewHTML(State.doc.calendar || {})
      : '<p>Calendar module unavailable.</p>';
    return paper(n, 'landscape', html, 'calendar');
  }

  /* -------------------------------------------------------------------------
   * Public API
   * ---------------------------------------------------------------------- */
  var Render = {
    escAttr: escAttr,

    /** Rebuild every page into #page-stage. Structural — callers must then
     *  re-bind Flip (page nodes are new) and refit. */
    pages: pages,

    /** Number of sheets in the current issue. */
    count: function () { return pages().length; },

    /** The descriptor for a 1-based ordinal, or null. */
    pageAt: function (n) {
      var list = pages();
      return list[Number(n) - 1] || null;
    },

    /** First ordinal with the given kind, or 0. */
    ordinalOf: function (kind) {
      var list = pages();
      for (var i = 0; i < list.length; i++) {
        if (list[i].kind === kind) return list[i].n;
      }
      return 0;
    },

    all: function () {
      var stage = document.getElementById('page-stage');
      if (!stage) return;
      var d = State.doc;
      var apages = (d.articles && Array.isArray(d.articles.pages))
        ? d.articles.pages : [[]];
      var html = '';
      pages().forEach(function (p) {
        if (p.kind === 'front') html += page1(p.n);
        else if (p.kind === 'announcements') {
          html += announcementPage(p.n, p.listPath, apages[p.pageIndex]);
        } else if (p.kind === 'slips') html += slipsPage(p.n);
        else if (p.kind === 'calendar') html += calendarPage(p.n);
      });
      stage.innerHTML = html;
    },

    /** Rebuild only the slips sheet. */
    slips: function () {
      var p = document.querySelector('#page-stage .paper[data-kind="slips"] .paper-flow');
      if (!p || !Keys.Slips) return;
      p.innerHTML = Keys.Slips.previewHTML(State.doc.slips || []);
    },

    /** Rebuild only the calendar sheet (month/year changed). */
    calendar: function () {
      var p = document.querySelector('#page-stage .paper[data-kind="calendar"] .paper-flow');
      if (!p || !Keys.Calendar) return;
      p.innerHTML = Keys.Calendar.previewHTML(State.doc.calendar || {});
    },

    /** Push one value into every preview node bound to `path`.
     *
     *  Most bindings are a straight innerHTML assignment. The exception is a
     *  lunch slip's "inline choices" row: its stored value is a pipe-delimited
     *  string ("Ketchup | Mustard | Relish") that Keys.Slips expands into a
     *  row of ruled blanks. Assigning the raw string would collapse the row to
     *  literal pipes until the next structural render, so those nodes are
     *  re-expanded here. They are tagged with data-slip-inline by slips.js. */
    push: function (path, html) {
      var nodes = document.querySelectorAll(
        '#page-stage [data-bind="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].hasAttribute('data-slip-inline') && Keys.Slips && Keys.Slips.inlineHTML) {
          nodes[i].innerHTML = Keys.Slips.inlineHTML(html);
        } else {
          nodes[i].innerHTML = html;
        }
      }
      return nodes;
    },

    /** All preview nodes bound to `path` (used for focus highlighting). */
    nodesFor: function (path) {
      return document.querySelectorAll(
        '#page-stage [data-bind="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]');
    },

    pageEl: function (n) {
      return document.querySelector('#page-stage .paper[data-page="' + Number(n) + '"]');
    }
  };

  Keys.Render = Render;
})(window);
