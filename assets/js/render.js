/* =============================================================================
 * render.js — Builds the four preview pages from Keys.State.doc.
 *
 * Exposes window.Keys.Render. Owns pages 1 and 2 directly and delegates
 * page 3 to Keys.Slips and page 4 to Keys.Calendar.
 *
 * Markup contract: docs/SPEC.md §3, §3b.
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

  /** Wrap page contents in the standard paper shell. */
  function paper(n, orientation, inner) {
    return '<div class="paper" data-page="' + n +
      '" data-orientation="' + orientation + '" data-fit-page>' +
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
    return '<section class="nl-box">' +
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

  function articles(listPath, list) {
    var html = '<div class="nl-articles">';
    (list || []).forEach(function (a, i) {
      html += '<article class="nl-article">' +
        out('nl-article-title', listPath + '.' + i + '.title') +
        out('nl-article-body', listPath + '.' + i + '.body') +
        '</article>';
    });
    html += '</div>';
    return html;
  }

  function page1() {
    var d = State.doc;
    var inner =
      out('nl-tagline', 'masthead.tagline') +
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
        '<aside class="nl-rail">' +
          out('nl-schoolinfo', 'masthead.schoolInfo') +
          railBox('thisWeek', 'thisWeek.heading', d.thisWeek && d.thisWeek.rows, null) +
          railBox('lookingAhead', 'lookingAhead.heading',
                  d.lookingAhead && d.lookingAhead.rows, 'lookingAhead.note') +
        '</aside>' +
      '</div>' +
      articles('articles.page1', d.articles && d.articles.page1);
    return paper(1, 'portrait', inner);
  }

  function page2() {
    var d = State.doc;
    return paper(2, 'portrait', articles('articles.page2', d.articles && d.articles.page2));
  }

  function page3() {
    var html = Keys.Slips
      ? Keys.Slips.previewHTML(State.doc.slips || [])
      : '<p>Slips module unavailable.</p>';
    return paper(3, 'portrait', html);
  }

  function page4() {
    var html = Keys.Calendar
      ? Keys.Calendar.previewHTML(State.doc.calendar || {})
      : '<p>Calendar module unavailable.</p>';
    return paper(4, 'landscape', html);
  }

  /* -------------------------------------------------------------------------
   * Public API
   * ---------------------------------------------------------------------- */
  var Render = {
    escAttr: escAttr,

    /** Rebuild every page into #page-stage. Structural — callers must then
     *  re-bind Flip (page nodes are new) and refit. */
    all: function () {
      var stage = document.getElementById('page-stage');
      if (!stage) return;
      stage.innerHTML = page1() + page2() + page3() + page4();
    },

    /** Rebuild only page 3 (slips added/removed). */
    slips: function () {
      var p = document.querySelector('#page-stage .paper[data-page="3"] .paper-flow');
      if (!p || !Keys.Slips) return;
      p.innerHTML = Keys.Slips.previewHTML(State.doc.slips || []);
    },

    /** Rebuild only page 4 (month/year changed). */
    calendar: function () {
      var p = document.querySelector('#page-stage .paper[data-page="4"] .paper-flow');
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
